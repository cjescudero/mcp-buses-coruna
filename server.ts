import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
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

interface LineMeta {
  name: string;
  nameLower: string;
  color: string | null;
}

class TransitServiceError extends Error {}

class TransitService {
  private stopsCache: StopSummary[] | null = null;
  private cacheExpiresAt = 0;
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
    const busesRoot = asObject(payload.buses);
    const linesRaw = asArray(busesRoot?.lineas);
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

    try {
      const payload = await this.fetchJson(this.config.stopsSourceUrl);
      const iTranvias = asObject(payload.iTranvias);
      const actualizacion = asObject(iTranvias?.actualizacion);
      const rawStops = asArray(actualizacion?.paradas);
      const rawLines = asArray(actualizacion?.lineas);

      this.linesInfo = this.parseLineInfo(rawLines);
      this.stopsCache = rawStops
        .map((item) => this.mapStop(item))
        .filter((item): item is StopSummary => item !== null);
      this.setCacheExpiry();
      return this.stopsCache;
    } catch (error) {
      if (this.stopsCache) {
        return this.stopsCache;
      }
      this.linesInfo = new Map();
      this.interestLineIds = new Set();
      this.stopsCache = [this.placeholderStop()];
      this.setCacheExpiry();
      if (error instanceof TransitServiceError) {
        return this.stopsCache;
      }
      throw error;
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
    if (this.interestLineIds.size === 0) {
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
    if (this.interestLineIds.size === 0) {
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

  private placeholderStop(): StopSummary {
    return {
      id: this.primaryStopId,
      name: `Parada ${this.primaryStopId}`,
      latitude: 0,
      longitude: 0,
      lines: [],
    };
  }

  private setCacheExpiry(): void {
    const ttl = this.config.cacheTtlSeconds;
    this.cacheExpiresAt = ttl > 0 ? Date.now() + ttl * 1000 : Number.POSITIVE_INFINITY;
  }
}

const DEFAULTS: TransitRuntimeConfig = {
  primaryStopId: 42,
  interestLines: ["3", "3A", "12", "14"],
  stopsSourceUrl:
    "https://itranvias.com/queryitr_v3.php?dato=20160101T000000_gl_0_20160101T000000&func=7",
  arrivalsUrlTemplate: "https://itranvias.com/queryitr_v3.php?func=0&dato={stop_id}",
  cacheTtlSeconds: 0,
  httpTimeoutMs: 8000,
};

const APP_RESOURCE_URI = "ui://buses-coruna/mcp-app.html";
const DIST_HTML_CANDIDATES = [
  path.join(import.meta.dirname, "dist", "mcp-app.html"),
  path.join(import.meta.dirname, "mcp-app.html"),
];

function createTransitConfig(): TransitRuntimeConfig {
  const appConfig = loadAppConfig();
  const cacheTtlSeconds = safeInt(process.env.CACHE_TTL_SECONDS) ?? DEFAULTS.cacheTtlSeconds;
  const httpTimeoutSeconds =
    safeFloat(process.env.HTTP_TIMEOUT_SECONDS) ?? DEFAULTS.httpTimeoutMs / 1000;

  return {
    primaryStopId: appConfig.primaryStopId,
    interestLines: appConfig.interestLines,
    stopsSourceUrl: process.env.STOPS_SOURCE_URL ?? DEFAULTS.stopsSourceUrl,
    arrivalsUrlTemplate: process.env.ARRIVALS_URL_TEMPLATE ?? DEFAULTS.arrivalsUrlTemplate,
    cacheTtlSeconds,
    httpTimeoutMs: Math.max(1000, Math.round(httpTimeoutSeconds * 1000)),
  };
}

function loadAppConfig(): AppConfig {
  const candidates = [
    process.env.APP_CONFIG_PATH,
    path.join(process.cwd(), "config", "app_config.json"),
    path.join(process.cwd(), "..", "busesyparadas", "config", "app_config.json"),
    path.join(process.cwd(), "busesyparadas", "config", "app_config.json"),
  ].filter((item): item is string => Boolean(item));

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    try {
      const data = JSON.parse(readFileSync(candidate, "utf8")) as {
        primary_stop_id?: unknown;
        interest_lines?: unknown;
      };
      const primaryStopId = safeInt(data.primary_stop_id) ?? DEFAULTS.primaryStopId;
      const rawInterestLines = Array.isArray(data.interest_lines) ? data.interest_lines : [];
      const interestLines = rawInterestLines
        .map((line) => String(line).trim())
        .filter((line) => line.length > 0);
      return {
        primaryStopId,
        interestLines: interestLines.length > 0 ? interestLines : DEFAULTS.interestLines,
      };
    } catch {
      continue;
    }
  }

  return {
    primaryStopId: DEFAULTS.primaryStopId,
    interestLines: DEFAULTS.interestLines,
  };
}

function resolveResourceHtml(): string {
  for (const candidate of DIST_HTML_CANDIDATES) {
    if (existsSync(candidate)) {
      return readFileSync(candidate, "utf8");
    }
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

export function createServer(): McpServer {
  const server = new McpServer({
    name: "buses-coruna-mcp",
    version: "1.0.0",
  });

  const config = createTransitConfig();
  const transit = new TransitService(config);

  registerAppTool(
    server,
    "show_bus_arrivals",
    {
      title: "Llegadas de buses (A Coruña)",
      description:
        "Muestra la información de una parada: buses más próximos y resto de llegadas para líneas de interés.",
      inputSchema: {
        stopId: z.number().int().positive().optional().describe("ID de parada"),
      },
      _meta: {
        ui: {
          resourceUri: APP_RESOURCE_URI,
        },
      },
    },
    async ({ stopId }) => {
      const selectedStopId = stopId ?? config.primaryStopId;
      const stop = await transit.getStop(selectedStopId);

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
        };
      }
    },
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
          text: resolveResourceHtml(),
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
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function safeFloat(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
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
