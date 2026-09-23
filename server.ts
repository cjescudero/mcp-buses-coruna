import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import {
  getCatalogMetadata,
  lineSummarySchema,
  loadTransitCatalog,
  stopSummarySchema,
  type CatalogMetadata,
  type LineSummary,
  type StopSummary,
  type TransitCatalog,
} from "./catalog.js";
import { createStopMatcher } from "./stop-search.js";

type JsonObject = Record<string, unknown>;

interface ArrivalBus {
  bus_id: number;
  eta_minutes: number | null;
  distance_meters: number | null;
  status: number | null;
  last_stop_id: number | null;
}

interface LineArrivals {
  line_id: number;
  line_name: string | null;
  color_hex: string | null;
  buses: ArrivalBus[];
}

interface ArrivalsResponse {
  stop_id: number;
  lines: LineArrivals[];
  fetched_at: string;
  source: "live" | "cache" | "stale";
}

interface TransitRuntimeConfig {
  arrivalsUrlTemplate: string;
  httpTimeoutMs: number;
  arrivalsCacheTtlMs: number;
  arrivalsStaleTtlMs: number;
  upstreamMinIntervalMs: number;
  upstreamMaxRequestsPerMinute: number;
  widgetDomain: string;
}

export interface TransitBackend {
  readonly transit: TransitService;
  readonly catalog: CatalogMetadata;
  readonly widgetDomain: string;
}

class TransitServiceError extends Error {}

class TransitService {
  private readonly stopsById: ReadonlyMap<number, StopSummary>;
  private readonly linesById: ReadonlyMap<number, LineSummary>;
  private readonly arrivalsCache = new Map<number, ArrivalsResponse>();
  private readonly arrivalsInFlight = new Map<number, Promise<ArrivalsResponse>>();
  private upstreamGate: Promise<void> = Promise.resolve();
  private lastUpstreamRequestAt = 0;
  private upstreamRequestTimes: number[] = [];
  private upstreamBlockedUntil = 0;

  constructor(
    private readonly config: TransitRuntimeConfig,
    private readonly catalog: TransitCatalog,
  ) {
    this.stopsById = new Map(catalog.stops.map((stop) => [stop.id, stop]));
    this.linesById = new Map(catalog.lines.map((line) => [line.line_id, line]));
  }

  searchStops(query: string | undefined, limit?: number): StopSummary[] {
    const normalized = query?.trim();
    const matchingStops = normalized
      ? this.catalog.stops.filter(createStopMatcher(normalized))
      : this.catalog.stops;
    return limit === undefined ? [...matchingStops] : matchingStops.slice(0, limit);
  }

  getStop(stopId: number): StopSummary | null {
    return this.stopsById.get(stopId) ?? null;
  }

  listLines(): LineSummary[] {
    return [...this.catalog.lines];
  }

  async getArrivals(stopId: number): Promise<ArrivalsResponse> {
    const cached = this.arrivalsCache.get(stopId);
    if (cached && Date.now() - Date.parse(cached.fetched_at) <= this.config.arrivalsCacheTtlMs) {
      return { ...cached, source: "cache" };
    }

    const inFlight = this.arrivalsInFlight.get(stopId);
    if (inFlight) {
      return inFlight;
    }

    const request = this.fetchArrivals(stopId, cached);
    this.arrivalsInFlight.set(stopId, request);
    try {
      return await request;
    } finally {
      this.arrivalsInFlight.delete(stopId);
    }
  }

  private async fetchArrivals(
    stopId: number,
    cached: ArrivalsResponse | undefined,
  ): Promise<ArrivalsResponse> {
    try {
      await this.acquireUpstreamSlot();
      const payload = await this.fetchJson(
        this.config.arrivalsUrlTemplate.replace("{stop_id}", String(stopId)),
      );
      const parsed = arrivalsPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        if (typeof payload.Origen === "string") {
          this.upstreamBlockedUntil = Date.now() + 60_000;
          throw new TransitServiceError("transit_api_rate_limited");
        }
        throw new TransitServiceError("transit_api_invalid_arrivals_payload");
      }
      if (parsed.data.resultado !== undefined && parsed.data.resultado !== "OK") {
        throw new TransitServiceError("transit_api_rejected_request");
      }

      const result = this.mapArrivals(stopId, parsed.data.buses.lineas ?? []);
      this.arrivalsCache.set(stopId, result);
      return result;
    } catch (error) {
      if (
        cached &&
        Date.now() - Date.parse(cached.fetched_at) <= this.config.arrivalsStaleTtlMs
      ) {
        return { ...cached, source: "stale" };
      }
      throw error;
    }
  }

  private mapArrivals(stopId: number, linesRaw: unknown[]): ArrivalsResponse {
    const lines: LineArrivals[] = [];

    for (const rawLine of linesRaw) {
      const lineObject = asObject(rawLine);
      if (!lineObject) {
        throw new TransitServiceError("transit_api_invalid_arrivals_payload");
      }
      const lineId = safeInt(lineObject.linea);
      if (lineId === null || lineId <= 0 || !Array.isArray(lineObject.buses)) {
        throw new TransitServiceError("transit_api_invalid_arrivals_payload");
      }

      const meta = this.linesById.get(lineId) ?? null;
      const busesData: ArrivalBus[] = [];
      for (const rawBus of asArray(lineObject.buses)) {
        const busObject = asObject(rawBus);
        if (!busObject) {
          throw new TransitServiceError("transit_api_invalid_arrivals_payload");
        }
        const busId = safeInt(busObject.bus);
        if (busId === null || busId < 0) {
          throw new TransitServiceError("transit_api_invalid_arrivals_payload");
        }
        busesData.push({
          bus_id: busId,
          eta_minutes: safeNonNegativeInt(busObject.tiempo),
          distance_meters: safeNonNegativeInt(busObject.distancia),
          status: safeInt(busObject.estado),
          last_stop_id: safeNonNegativeInt(busObject.ult_parada),
        });
      }

      busesData.sort((a, b) => toSortEta(a.eta_minutes) - toSortEta(b.eta_minutes));
      lines.push({
        line_id: lineId,
        line_name: meta?.line_name ?? null,
        color_hex: meta?.color_hex ?? null,
        buses: busesData,
      });
    }

    return {
      stop_id: stopId,
      lines,
      fetched_at: new Date().toISOString(),
      source: "live",
    };
  }

  private async acquireUpstreamSlot(): Promise<void> {
    let releaseGate!: () => void;
    const previousGate = this.upstreamGate;
    this.upstreamGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    await previousGate;

    try {
      let now = Date.now();
      if (now < this.upstreamBlockedUntil) {
        throw new TransitServiceError("transit_api_rate_limited");
      }
      this.upstreamRequestTimes = this.upstreamRequestTimes.filter(
        (timestamp) => now - timestamp < 60_000,
      );
      if (this.upstreamRequestTimes.length >= this.config.upstreamMaxRequestsPerMinute) {
        throw new TransitServiceError("transit_api_rate_limited");
      }

      const waitMs = this.lastUpstreamRequestAt + this.config.upstreamMinIntervalMs - now;
      if (waitMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
        now = Date.now();
      }
      this.lastUpstreamRequestAt = now;
      this.upstreamRequestTimes.push(now);
    } finally {
      releaseGate();
    }
  }

  private async fetchJson(url: string): Promise<JsonObject> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.httpTimeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (response.status === 429) {
        this.upstreamBlockedUntil = Date.now() + 60_000;
        throw new TransitServiceError("transit_api_rate_limited");
      }
      if (!response.ok) {
        throw new TransitServiceError(`transit_api_error_${response.status}`);
      }
      const rawBody = await response.text();
      if (/429\s+Too\s+Many\s+Requests/i.test(rawBody)) {
        this.upstreamBlockedUntil = Date.now() + 60_000;
        throw new TransitServiceError("transit_api_rate_limited");
      }
      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        throw new TransitServiceError("transit_api_invalid_payload");
      }
      if (!isObject(body)) {
        throw new TransitServiceError("transit_api_invalid_payload");
      }
      return body;
    } catch (error) {
      if (error instanceof TransitServiceError) {
        throw error;
      }
      throw new TransitServiceError("transit_api_unavailable");
    } finally {
      clearTimeout(timeout);
    }
  }
}

const arrivalsPayloadSchema = z.object({
  resultado: z.string().optional(),
  buses: z.object({
    lineas: z.array(z.unknown()).optional(),
  }).passthrough(),
}).passthrough();

const catalogMetadataSchema = z.object({
  schema_version: z.literal(1),
  generated_at: z.iso.datetime({ offset: true }),
  line_count: z.number().int().nonnegative(),
  stop_count: z.number().int().nonnegative(),
});

const arrivalBusSchema = z.object({
  bus_id: z.number().int().nonnegative(),
  eta_minutes: z.number().int().nonnegative().nullable(),
  distance_meters: z.number().int().nonnegative().nullable(),
  status: z.number().int().nullable(),
  last_stop_id: z.number().int().nonnegative().nullable(),
});

const lineArrivalsSchema = z.object({
  line_id: z.number().int().positive(),
  line_name: z.string().nullable(),
  color_hex: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable(),
  buses: z.array(arrivalBusSchema),
});

const arrivalsResponseSchema = z.object({
  stop_id: z.number().int().positive(),
  lines: z.array(lineArrivalsSchema),
  fetched_at: z.iso.datetime({ offset: true }),
  source: z.enum(["live", "cache", "stale"]),
});

const arrivalsToolOutputSchema = z.object({
  stop: stopSummarySchema.nullable(),
  arrivals: arrivalsResponseSchema.nullable(),
  message: z.string().optional(),
  catalog: catalogMetadataSchema,
});

const searchStopsOutputSchema = z.object({
  total: z.number().int().nonnegative(),
  stops: z.array(stopSummarySchema),
  message: z.string().optional(),
  catalog: catalogMetadataSchema,
});

const listLinesOutputSchema = z.object({
  total: z.number().int().nonnegative(),
  lines: z.array(lineSummarySchema),
  message: z.string().optional(),
  catalog: catalogMetadataSchema,
});

const DEFAULTS: TransitRuntimeConfig = {
  arrivalsUrlTemplate: "https://itranvias.com/queryitr_v3.php?func=0&dato={stop_id}",
  httpTimeoutMs: 8000,
  arrivalsCacheTtlMs: 15_000,
  arrivalsStaleTtlMs: 120_000,
  upstreamMinIntervalMs: 1100,
  upstreamMaxRequestsPerMinute: 4,
  widgetDomain: "https://escudero.gtec.udc.es",
};

const APP_RESOURCE_URI = "ui://buses-coruna/mcp-app-v2.html";
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DIST_HTML_PATH = path.basename(MODULE_DIR) === "dist"
  ? path.join(MODULE_DIR, "mcp-app.html")
  : path.join(MODULE_DIR, "dist", "mcp-app.html");
let resourceHtmlCache: string | null = null;

function createTransitConfig(): TransitRuntimeConfig {
  const httpTimeoutSeconds = parseEnvNumber(
    "HTTP_TIMEOUT_SECONDS",
    DEFAULTS.httpTimeoutMs / 1000,
    1,
    120,
  );
  const arrivalsUrlTemplate = validateHttpUrl(
    "ARRIVALS_URL_TEMPLATE",
    process.env.ARRIVALS_URL_TEMPLATE ?? DEFAULTS.arrivalsUrlTemplate,
  );
  if (!arrivalsUrlTemplate.includes("{stop_id}")) {
    throw new Error("ARRIVALS_URL_TEMPLATE debe contener {stop_id}");
  }

  const arrivalsCacheTtlSeconds = parseEnvNumber(
    "ARRIVALS_CACHE_TTL_SECONDS",
    DEFAULTS.arrivalsCacheTtlMs / 1000,
    0,
    300,
  );
  const arrivalsStaleTtlSeconds = parseEnvNumber(
    "ARRIVALS_STALE_TTL_SECONDS",
    DEFAULTS.arrivalsStaleTtlMs / 1000,
    arrivalsCacheTtlSeconds,
    3600,
  );
  const upstreamMinIntervalMs = parseEnvNumber(
    "ITRANVIAS_MIN_INTERVAL_MS",
    DEFAULTS.upstreamMinIntervalMs,
    0,
    60_000,
  );
  const upstreamMaxRequestsPerMinute = parseEnvNumber(
    "ITRANVIAS_MAX_REQUESTS_PER_MINUTE",
    DEFAULTS.upstreamMaxRequestsPerMinute,
    1,
    1000,
  );
  if (!Number.isInteger(upstreamMaxRequestsPerMinute)) {
    throw new Error("ITRANVIAS_MAX_REQUESTS_PER_MINUTE debe ser un entero");
  }
  const widgetDomain = validateOrigin(
    "WIDGET_DOMAIN",
    process.env.WIDGET_DOMAIN ?? DEFAULTS.widgetDomain,
  );

  return {
    arrivalsUrlTemplate,
    httpTimeoutMs: Math.max(1000, Math.round(httpTimeoutSeconds * 1000)),
    arrivalsCacheTtlMs: Math.round(arrivalsCacheTtlSeconds * 1000),
    arrivalsStaleTtlMs: Math.round(arrivalsStaleTtlSeconds * 1000),
    upstreamMinIntervalMs: Math.round(upstreamMinIntervalMs),
    upstreamMaxRequestsPerMinute,
    widgetDomain,
  };
}

function resolveResourceHtml(): string {
  if (resourceHtmlCache !== null) {
    return resourceHtmlCache;
  }
  if (existsSync(DIST_HTML_PATH)) {
    resourceHtmlCache = readFileSync(DIST_HTML_PATH, "utf8");
    return resourceHtmlCache;
  }
  throw new Error(
    "No se encontró mcp-app.html. Ejecuta `npm run build:app` en mcp-buses-coruna antes de levantar el servidor.",
  );
}

function summarizeArrivals(stop: StopSummary, arrivals: ArrivalsResponse): string {
  if (arrivals.lines.length === 0) {
    return `${stop.id} - ${stop.name}: sin llegadas registradas en la lectura de las ${formatObservedTime(arrivals.fetched_at)}.`;
  }
  const next = arrivals.lines
    .slice(0, 4)
    .map((line) => {
      const name = line.line_name ?? `Línea ${line.line_id}`;
      const firstEta = line.buses[0]?.eta_minutes ?? null;
      return `${name} (${formatEta(firstEta)})`;
    })
    .join(", ");
  const freshness = arrivals.source === "stale"
    ? `Última lectura disponible (${formatObservedTime(arrivals.fetched_at)})`
    : `Lectura de las ${formatObservedTime(arrivals.fetched_at)}`;
  return `${stop.id} - ${stop.name}. ${freshness}. Próximas: ${next}.`;
}

function formatObservedTime(isoTimestamp: string): string {
  return new Intl.DateTimeFormat("es-ES", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Madrid",
  }).format(new Date(isoTimestamp));
}

function describeTransitError(code: string): string {
  switch (code) {
    case "transit_api_rate_limited":
      return "iTranvias ha alcanzado temporalmente su límite de consultas; inténtalo de nuevo dentro de un minuto";
    case "transit_api_error_503":
    case "transit_api_unavailable":
      return "iTranvias no está disponible en este momento";
    case "transit_api_invalid_arrivals_payload":
    case "transit_api_invalid_payload":
      return "iTranvias devolvió una respuesta que no contiene llegadas utilizables";
    default:
      return "iTranvias no pudo completar la consulta de llegadas";
  }
}

function formatEta(value: number | null): string {
  if (value === null) {
    return "sin dato";
  }
  if (value <= 0) {
    return "llegando";
  }
  if (value === 1) {
    return "1 min";
  }
  return `${value} min`;
}

export function createTransitBackend(): TransitBackend {
  const config = createTransitConfig();
  const staticCatalog = loadTransitCatalog();
  return {
    catalog: getCatalogMetadata(staticCatalog),
    transit: new TransitService(config, staticCatalog),
    widgetDomain: config.widgetDomain,
  };
}

export function createServer(backend: TransitBackend = createTransitBackend()): McpServer {
  const server = new McpServer({
    name: "buses-coruna-mcp-server",
    version: "1.0.0",
  });

  const { transit, catalog, widgetDomain } = backend;
  const widgetResourceMeta = {
    prefersBorder: true,
    domain: widgetDomain,
    csp: {
      connectDomains: [],
      resourceDomains: [],
    },
  };
  // Fail during startup instead of reporting a healthy MCP whose UI resource
  // will fail only when a host attempts to open it.
  const resourceHtml = resolveResourceHtml();
  const getArrivalsForStop = async (selectedStopId: number) => {
    const stop = transit.getStop(selectedStopId);

    if (!stop) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No existe la parada ${selectedStopId}.`,
          },
        ],
        structuredContent: {
          stop: null,
          arrivals: null,
          message: "stop_not_found",
          catalog,
        },
        isError: true,
      };
    }

    try {
      const arrivals = await transit.getArrivals(selectedStopId);
      return {
        content: [
          {
            type: "text" as const,
            text: summarizeArrivals(stop, arrivals),
          },
        ],
        structuredContent: {
          stop,
          arrivals,
          catalog,
        },
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "transit_api_unavailable";
      return {
        content: [
          {
            type: "text" as const,
            text: `No se pudieron recuperar las llegadas para la parada ${selectedStopId}: ${describeTransitError(detail)}.`,
          },
        ],
        structuredContent: {
          stop,
          arrivals: null,
          message: detail,
          catalog,
        },
        isError: true,
      };
    }
  };

  registerAppTool(
    server,
    "show_bus_arrivals",
    {
      title: "Llegadas de buses (A Coruña)",
      description:
        "Muestra las llegadas de todas las líneas para una parada de A Coruña.",
      inputSchema: {
        stopId: z
          .number()
          .int()
          .positive()
          .describe("ID positivo de la parada que se desea consultar."),
      },
      outputSchema: arrivalsToolOutputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      _meta: {
        ui: {
          resourceUri: APP_RESOURCE_URI,
        },
      },
    },
    async ({ stopId }) => getArrivalsForStop(stopId),
  );

  server.registerTool(
    "search_stops",
    {
      title: "Buscar paradas",
      description:
        "Devuelve todas las paradas, o las que coincidan por nombre o ID, sin filtrar por líneas.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Texto opcional que debe aparecer en el nombre o ID de la parada."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(400)
          .optional()
          .describe("Número máximo opcional de coincidencias, entre 1 y 400."),
      },
      outputSchema: searchStopsOutputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, limit }) => {
      try {
        const stops = await transit.searchStops(query, limit);
        return {
          content: [
            {
              type: "text" as const,
              text: `Encontradas ${stops.length} paradas.`,
            },
          ],
          structuredContent: {
            total: stops.length,
            stops,
            catalog,
          },
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : "transit_api_unavailable";
        return {
          content: [{ type: "text" as const, text: `No se pudieron recuperar las paradas (${detail}).` }],
          structuredContent: { total: 0, stops: [], message: detail, catalog },
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "list_bus_lines",
    {
      title: "Listar líneas de bus",
      description:
        "Devuelve todas las líneas del catálogo estático de A Coruña.",
      inputSchema: {},
      outputSchema: listLinesOutputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const lines = await transit.listLines();
        return {
          content: [
            {
              type: "text" as const,
              text: `Encontradas ${lines.length} líneas.`,
            },
          ],
          structuredContent: {
            total: lines.length,
            lines,
            catalog,
          },
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : "transit_api_unavailable";
        return {
          content: [
            {
              type: "text" as const,
              text: `No se pudieron recuperar las líneas (${detail}).`,
            },
          ],
          structuredContent: { total: 0, lines: [], message: detail, catalog },
          isError: true,
        };
      }
    },
  );

  registerAppResource(
    server,
    APP_RESOURCE_URI,
    APP_RESOURCE_URI,
    {
      mimeType: RESOURCE_MIME_TYPE,
      _meta: {
        ui: widgetResourceMeta,
      },
    },
    async () => ({
      contents: [
        {
          uri: APP_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: resourceHtml,
          _meta: {
            ui: widgetResourceMeta,
          },
        },
      ],
    }),
  );

  return server;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): JsonObject | null {
  return isObject(value) ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function safeInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim();
    if (!/^[+-]?\d+$/.test(normalized)) {
      return null;
    }
    const parsed = Number(normalized);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function safeNonNegativeInt(value: unknown): number | null {
  const parsed = safeInt(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function parseEnvNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const normalized = raw.trim();
  if (normalized.length === 0) {
    throw new Error(`${name} debe ser un número entre ${min} y ${max}`);
  }
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} debe ser un número entre ${min} y ${max}`);
  }
  return value;
}

function validateHttpUrl(name: string, raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} debe ser una URL válida`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} debe usar http o https`);
  }
  return raw;
}

function validateOrigin(name: string, raw: string): string {
  const normalized = validateHttpUrl(name, raw).trim();
  const parsed = new URL(normalized);
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${name} debe ser un origen sin ruta, consulta ni fragmento`);
  }
  return parsed.origin;
}

function toSortEta(eta: number | null): number {
  return eta ?? Number.MAX_SAFE_INTEGER;
}
