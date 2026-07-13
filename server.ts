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
  loadTransitCatalog,
  type CatalogMetadata,
  type LineSummary,
  type StopSummary,
  type TransitCatalog,
} from "./catalog.js";

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
}

interface TransitRuntimeConfig {
  arrivalsUrlTemplate: string;
  httpTimeoutMs: number;
}

export interface TransitBackend {
  readonly transit: TransitService;
  readonly catalog: CatalogMetadata;
}

class TransitServiceError extends Error {}

class TransitService {
  private readonly stopsById: ReadonlyMap<number, StopSummary>;
  private readonly linesById: ReadonlyMap<number, LineSummary>;

  constructor(
    private readonly config: TransitRuntimeConfig,
    private readonly catalog: TransitCatalog,
  ) {
    this.stopsById = new Map(catalog.stops.map((stop) => [stop.id, stop]));
    this.linesById = new Map(catalog.lines.map((line) => [line.line_id, line]));
  }

  searchStops(query: string | undefined, limit?: number): StopSummary[] {
    const normalized = query?.trim().toLowerCase();
    const matchingStops = normalized
      ? this.catalog.stops.filter(
          (stop) =>
            stop.name.toLowerCase().includes(normalized) || String(stop.id).includes(normalized),
        )
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
    const payload = await this.fetchJson(this.config.arrivalsUrlTemplate.replace("{stop_id}", String(stopId)));
    const parsed = arrivalsPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw new TransitServiceError("transit_api_invalid_arrivals_payload");
    }
    const linesRaw = parsed.data.buses.lineas;
    const lines: LineArrivals[] = [];

    for (const rawLine of linesRaw) {
      const lineObject = asObject(rawLine);
      if (!lineObject) {
        continue;
      }
      const lineId = safeInt(lineObject.linea);
      if (lineId === null) {
        continue;
      }

      const meta = this.linesById.get(lineId) ?? null;
      const busesData: ArrivalBus[] = [];
      for (const rawBus of asArray(lineObject.buses)) {
        const busObject = asObject(rawBus);
        if (!busObject) {
          continue;
        }
        const busId = safeInt(busObject.bus);
        if (busId === null) {
          continue;
        }
        busesData.push({
          bus_id: busId,
          eta_minutes: safeInt(busObject.tiempo),
          distance_meters: safeInt(busObject.distancia),
          status: safeInt(busObject.estado),
          last_stop_id: safeInt(busObject.ult_parada),
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

    return { stop_id: stopId, lines };
  }

  private async fetchJson(url: string): Promise<JsonObject> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.httpTimeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new TransitServiceError(`transit_api_error_${response.status}`);
      }
      const body = await response.json();
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
  buses: z.object({
    lineas: z.array(z.unknown()),
  }).passthrough(),
}).passthrough();

const DEFAULTS: TransitRuntimeConfig = {
  arrivalsUrlTemplate: "https://itranvias.com/queryitr_v3.php?func=0&dato={stop_id}",
  httpTimeoutMs: 8000,
};

const APP_RESOURCE_URI = "ui://buses-coruna/mcp-app.html";
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

  return {
    arrivalsUrlTemplate,
    httpTimeoutMs: Math.max(1000, Math.round(httpTimeoutSeconds * 1000)),
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
    return `${stop.id} - ${stop.name}: sin llegadas registradas.`;
  }
  const next = arrivals.lines
    .slice(0, 4)
    .map((line) => {
      const name = line.line_name ?? `Línea ${line.line_id}`;
      const firstEta = line.buses[0]?.eta_minutes ?? null;
      return `${name} (${formatEta(firstEta)})`;
    })
    .join(", ");
  return `${stop.id} - ${stop.name}. Próximas: ${next}.`;
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
  };
}

export function createServer(backend: TransitBackend = createTransitBackend()): McpServer {
  const server = new McpServer({
    name: "buses-coruna-mcp-server",
    version: "1.0.0",
  });

  const { transit, catalog } = backend;
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
            text: `No se pudieron recuperar las llegadas para la parada ${selectedStopId} (${detail}).`,
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

  registerAppTool(
    server,
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
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: {
        ui: {
          resourceUri: APP_RESOURCE_URI,
          visibility: ["app"],
        },
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
    },
    async () => ({
      contents: [
        {
          uri: APP_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: resourceHtml,
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

function toSortEta(eta: number | null): number {
  return eta ?? Number.MAX_SAFE_INTEGER;
}
