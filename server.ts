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

type JsonObject = Record<string, unknown>;

interface StopSummary {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  lines: number[];
}

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

interface AppConfig {
  primaryStopId: number;
  interestLines: string[];
}

interface TransitRuntimeConfig extends AppConfig {
  stopsSourceUrl: string;
  arrivalsUrlTemplate: string;
  cacheTtlSeconds: number;
  httpTimeoutMs: number;
}

export interface TransitBackend {
  readonly config: TransitRuntimeConfig;
  readonly transit: TransitService;
}

interface LineMeta {
  name: string;
  nameLower: string;
  color: string | null;
}

class TransitServiceError extends Error {}

class TransitService {
  private stopsCache: StopSummary[] | null = null;
  private cacheExpiresAt = 0;
  private retryAfter = 0;
  private loadingStopsPromise: Promise<StopSummary[]> | null = null;
  private linesInfo = new Map<number, LineMeta>();
  private interestLineIds = new Set<number>();
  private readonly interestLineNames: Set<string>;
  readonly primaryStopId: number;

  constructor(private readonly config: TransitRuntimeConfig) {
    this.primaryStopId = config.primaryStopId;
    this.interestLineNames = new Set(
      config.interestLines.map((line) => line.trim().toLowerCase()).filter(Boolean),
    );
  }

  async searchStops(query: string | undefined, limit = 50): Promise<StopSummary[]> {
    const stops = this.filterInterestStops(await this.loadStops());
    const normalized = query?.trim().toLowerCase();
    if (!normalized) {
      return stops.slice(0, limit);
    }
    return stops.filter((stop) => stop.name.toLowerCase().includes(normalized)).slice(0, limit);
  }

  async getStop(stopId: number): Promise<StopSummary | null> {
    const stops = await this.loadStops();
    const stop = stops.find((item) => item.id === stopId);
    return stop ? this.applyInterestToStop(stop) : null;
  }

  async getArrivals(stopId: number): Promise<ArrivalsResponse> {
    if (this.linesInfo.size === 0) {
      await this.loadStops();
    }

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

      const meta = this.linesInfo.get(lineId) ?? null;
      if (!this.isInterestLine(lineId, meta)) {
        continue;
      }

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
        line_name: meta?.name ?? null,
        color_hex: meta?.color ?? null,
        buses: busesData,
      });
    }

    lines.sort((a, b) => {
      const aEta = a.buses.length > 0 ? toSortEta(a.buses[0].eta_minutes) : Number.MAX_SAFE_INTEGER;
      const bEta = b.buses.length > 0 ? toSortEta(b.buses[0].eta_minutes) : Number.MAX_SAFE_INTEGER;
      return aEta - bEta;
    });

    return { stop_id: stopId, lines };
  }

  private async loadStops(force = false): Promise<StopSummary[]> {
    const now = Date.now();
    if (!force && this.stopsCache && now < this.cacheExpiresAt) {
      return this.stopsCache;
    }
    if (!force && this.stopsCache && now < this.retryAfter) {
      return this.stopsCache;
    }

    if (this.loadingStopsPromise) {
      return this.loadingStopsPromise;
    }

    this.loadingStopsPromise = this.loadStopsInternal(force);
    try {
      return await this.loadingStopsPromise;
    } finally {
      this.loadingStopsPromise = null;
    }
  }

  private async loadStopsInternal(force: boolean): Promise<StopSummary[]> {
    const now = Date.now();
    if (!force && this.stopsCache && now < this.cacheExpiresAt) {
      return this.stopsCache;
    }

    const previousLinesInfo = this.linesInfo;
    const previousInterestLineIds = this.interestLineIds;
    try {
      const payload = await this.fetchJson(this.config.stopsSourceUrl);
      const parsed = stopsPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        throw new TransitServiceError("transit_api_invalid_stops_payload");
      }
      const rawStops = parsed.data.iTranvias.actualizacion.paradas;
      const rawLines = parsed.data.iTranvias.actualizacion.lineas;

      const nextLinesInfo = this.parseLineInfo(rawLines);
      const nextStopsCache = rawStops
        .map((item) => this.mapStop(item))
        .filter((item): item is StopSummary => item !== null);
      if (nextStopsCache.length === 0) {
        throw new TransitServiceError("transit_api_empty_stops_payload");
      }
      this.linesInfo = nextLinesInfo;
      this.stopsCache = nextStopsCache;
      this.retryAfter = 0;
      this.setCacheExpiry();
      return this.stopsCache;
    } catch (error) {
      if (this.stopsCache) {
        this.linesInfo = previousLinesInfo;
        this.interestLineIds = previousInterestLineIds;
        // Keep serving the last known good catalog, but retry after a short backoff.
        this.retryAfter = Date.now() + 30_000;
        return this.stopsCache;
      }
      throw error instanceof TransitServiceError
        ? error
        : new TransitServiceError("transit_api_unavailable");
    }
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

  private parseLineInfo(linesRaw: unknown[]): Map<number, LineMeta> {
    const info = new Map<number, LineMeta>();
    const interestIds = new Set<number>();

    for (const lineRaw of linesRaw) {
      const line = asObject(lineRaw);
      if (!line) {
        continue;
      }
      const lineId = safeInt(line.id);
      if (lineId === null) {
        continue;
      }

      const name = String(line.lin_comer ?? lineId).trim();
      const normalizedName = name.toLowerCase();
      const color = formatColor(line.color);
      info.set(lineId, { name, nameLower: normalizedName, color });

      if (
        this.interestLineNames.has(normalizedName) ||
        this.interestLineNames.has(String(lineId).toLowerCase())
      ) {
        interestIds.add(lineId);
      }
    }

    this.interestLineIds = interestIds;
    return info;
  }

  private filterInterestStops(stops: StopSummary[]): StopSummary[] {
    if (this.interestLineNames.size === 0) {
      return [...stops].sort((a, b) => a.name.localeCompare(b.name, "es"));
    }
    const filtered: StopSummary[] = [];
    for (const stop of stops) {
      const transformed = this.applyInterestToStop(stop);
      if (transformed.lines.length > 0) {
        filtered.push(transformed);
      }
    }
    return filtered.sort((a, b) => a.name.localeCompare(b.name, "es"));
  }

  private applyInterestToStop(stop: StopSummary): StopSummary {
    if (this.interestLineNames.size === 0) {
      return { ...stop, lines: [...stop.lines] };
    }
    return {
      ...stop,
      lines: stop.lines.filter((lineId) => this.interestLineIds.has(lineId)),
    };
  }

  private isInterestLine(lineId: number, lineMeta: LineMeta | null): boolean {
    if (this.interestLineNames.size === 0) {
      return true;
    }
    if (this.interestLineIds.has(lineId)) {
      return true;
    }
    if (this.interestLineNames.has(String(lineId).toLowerCase())) {
      return true;
    }
    if (lineMeta && this.interestLineNames.has(lineMeta.nameLower)) {
      return true;
    }
    return false;
  }

  private mapStop(rawStop: unknown): StopSummary | null {
    const stop = asObject(rawStop);
    if (!stop) {
      return null;
    }
    const stopId = safeInt(stop.id);
    if (stopId === null) {
      return null;
    }
    const lineIds = asArray(stop.enlaces)
      .map((line) => safeInt(line))
      .filter((line): line is number => line !== null);

    return {
      id: stopId,
      name: String(stop.nombre ?? `Parada ${stopId}`),
      latitude: safeFloat(stop.posy) ?? 0,
      longitude: safeFloat(stop.posx) ?? 0,
      lines: lineIds,
    };
  }

  private setCacheExpiry(): void {
    const ttl = this.config.cacheTtlSeconds;
    // A zero TTL explicitly disables caching; finite defaults avoid stale data forever.
    this.cacheExpiresAt = ttl > 0 ? Date.now() + ttl * 1000 : 0;
  }
}

const stopsPayloadSchema = z.object({
  iTranvias: z.object({
    actualizacion: z.object({
      paradas: z.array(z.unknown()),
      lineas: z.array(z.unknown()),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

const arrivalsPayloadSchema = z.object({
  buses: z.object({
    lineas: z.array(z.unknown()),
  }).passthrough(),
}).passthrough();

const positiveIntegerConfigSchema = z.union([
  z.number().int().positive(),
  z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().positive()),
]);

const appConfigFileSchema = z.object({
  primary_stop_id: positiveIntegerConfigSchema.optional(),
  interest_lines: z.array(z.union([z.string(), z.number().finite()])).optional(),
}).passthrough();

const DEFAULTS: TransitRuntimeConfig = {
  primaryStopId: 42,
  interestLines: ["3", "3A", "12", "14"],
  stopsSourceUrl:
    "https://itranvias.com/queryitr_v3.php?dato=20160101T000000_gl_0_20160101T000000&func=7",
  arrivalsUrlTemplate: "https://itranvias.com/queryitr_v3.php?func=0&dato={stop_id}",
  cacheTtlSeconds: 300,
  httpTimeoutMs: 8000,
};

const APP_RESOURCE_URI = "ui://buses-coruna/mcp-app.html";
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DIST_HTML_PATH = path.basename(MODULE_DIR) === "dist"
  ? path.join(MODULE_DIR, "mcp-app.html")
  : path.join(MODULE_DIR, "dist", "mcp-app.html");
let resourceHtmlCache: string | null = null;

function createTransitConfig(): TransitRuntimeConfig {
  const appConfig = loadAppConfig();
  const cacheTtlSeconds = parseEnvNumber("CACHE_TTL_SECONDS", DEFAULTS.cacheTtlSeconds, 0, 86_400);
  const httpTimeoutSeconds = parseEnvNumber(
    "HTTP_TIMEOUT_SECONDS",
    DEFAULTS.httpTimeoutMs / 1000,
    1,
    120,
  );
  const stopsSourceUrl = validateHttpUrl(
    "STOPS_SOURCE_URL",
    process.env.STOPS_SOURCE_URL ?? DEFAULTS.stopsSourceUrl,
  );
  const arrivalsUrlTemplate = validateHttpUrl(
    "ARRIVALS_URL_TEMPLATE",
    process.env.ARRIVALS_URL_TEMPLATE ?? DEFAULTS.arrivalsUrlTemplate,
  );
  if (!arrivalsUrlTemplate.includes("{stop_id}")) {
    throw new Error("ARRIVALS_URL_TEMPLATE debe contener {stop_id}");
  }

  return {
    primaryStopId: appConfig.primaryStopId,
    interestLines: appConfig.interestLines,
    stopsSourceUrl,
    arrivalsUrlTemplate,
    cacheTtlSeconds,
    httpTimeoutMs: Math.max(1000, Math.round(httpTimeoutSeconds * 1000)),
  };
}

function loadAppConfig(): AppConfig {
  const explicitConfigPath = process.env.APP_CONFIG_PATH;
  const candidates = [
    explicitConfigPath,
    path.join(process.cwd(), "config", "app_config.json"),
    path.join(process.cwd(), "..", "busesyparadas", "config", "app_config.json"),
    path.join(process.cwd(), "busesyparadas", "config", "app_config.json"),
  ].filter((item): item is string => Boolean(item));

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      if (candidate === explicitConfigPath) {
        throw new Error(`APP_CONFIG_PATH no existe: ${candidate}`);
      }
      continue;
    }
    try {
      const data = appConfigFileSchema.parse(JSON.parse(readFileSync(candidate, "utf8")));
      const primaryStopId = data.primary_stop_id ?? DEFAULTS.primaryStopId;
      const rawInterestLines = data.interest_lines ?? [];
      const interestLines = rawInterestLines
        .map((line) => String(line).trim())
        .filter((line) => line.length > 0);
      return {
        primaryStopId,
        interestLines: interestLines.length > 0 ? interestLines : DEFAULTS.interestLines,
      };
    } catch (error) {
      if (candidate === explicitConfigPath) {
        const detail = error instanceof Error ? error.message : "configuración inválida";
        throw new Error(`APP_CONFIG_PATH inválido (${detail})`);
      }
      continue;
    }
  }

  return {
    primaryStopId: DEFAULTS.primaryStopId,
    interestLines: DEFAULTS.interestLines,
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
    return `${stop.id} - ${stop.name}: sin llegadas para las líneas configuradas.`;
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
  return { config, transit: new TransitService(config) };
}

export function createServer(backend: TransitBackend = createTransitBackend()): McpServer {
  const server = new McpServer({
    name: "buses-coruna-mcp",
    version: "1.0.0",
  });

  const { config, transit } = backend;
  // Fail during startup instead of reporting a healthy MCP whose UI resource
  // will fail only when a host attempts to open it.
  const resourceHtml = resolveResourceHtml();
  const getArrivalsForStop = async (selectedStopId: number) => {
    let stop: StopSummary | null;
    try {
      stop = await transit.getStop(selectedStopId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "transit_api_unavailable";
      return {
        content: [
          {
            type: "text" as const,
            text: `No se pudo consultar el catálogo de paradas (${detail}).`,
          },
        ],
        structuredContent: {
          primaryStopId: config.primaryStopId,
          stop: null,
          arrivals: null,
          message: detail,
        },
        isError: true,
      };
    }

    if (!stop) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No existe la parada ${selectedStopId}.`,
          },
        ],
        structuredContent: {
          primaryStopId: config.primaryStopId,
          stop: null,
          arrivals: null,
          message: "stop_not_found",
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
          primaryStopId: config.primaryStopId,
          stop,
          arrivals,
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
          primaryStopId: config.primaryStopId,
          stop,
          arrivals: null,
          message: detail,
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
        "Muestra llegadas de una parada. Si no se indica stopId, usa automáticamente la parada principal configurada.",
      inputSchema: {
        stopId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("ID de parada (opcional). Si se omite, se usa la parada principal."),
      },
      _meta: {
        ui: {
          resourceUri: APP_RESOURCE_URI,
        },
      },
    },
    async ({ stopId }) => getArrivalsForStop(stopId ?? config.primaryStopId),
  );

  registerAppTool(
    server,
    "show_default_bus_arrivals",
    {
      title: "Llegadas de buses (parada por defecto)",
      description:
        "Muestra llegadas usando siempre la parada principal configurada. Útil para consultas genéricas sin indicar parada.",
      inputSchema: {},
      _meta: {
        ui: {
          resourceUri: APP_RESOURCE_URI,
        },
      },
    },
    async () => getArrivalsForStop(config.primaryStopId),
  );

  registerAppTool(
    server,
    "search_stops",
    {
      title: "Buscar paradas",
      description: "Devuelve paradas filtradas por líneas de interés para usar en el buscador de la UI.",
      inputSchema: {
        query: z.string().optional(),
        limit: z.number().int().min(1).max(400).optional(),
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
        const stops = await transit.searchStops(query, limit ?? 50);
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
            primaryStopId: config.primaryStopId,
          },
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : "transit_api_unavailable";
        return {
          content: [{ type: "text" as const, text: `No se pudieron recuperar las paradas (${detail}).` }],
          structuredContent: { total: 0, stops: [], primaryStopId: config.primaryStopId, message: detail },
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

function safeFloat(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim();
    if (normalized.length === 0) {
      return null;
    }
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
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

function formatColor(rawColor: unknown): string | null {
  if (typeof rawColor !== "string" || rawColor.trim().length === 0) {
    return null;
  }
  const color = rawColor.trim();
  if (color.startsWith("#")) {
    return color;
  }
  return `#${color.padStart(6, "0")}`;
}
