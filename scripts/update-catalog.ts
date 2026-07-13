import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  resolveCatalogPath,
  transitCatalogSchema,
  type LineSummary,
  type RouteSummary,
  type StopSummary,
  type TransitCatalog,
} from "../catalog.js";

const DEFAULT_CATALOG_SOURCE_URL =
  "https://itranvias.com/queryitr_v3.php?dato=20160101T000000_gl_0_20160101T000000&func=7";
const DEFAULT_TIMEOUT_SECONDS = 20;

const upstreamCatalogEnvelopeSchema = z.object({
  iTranvias: z.object({
    actualizacion: z.object({
      paradas: z.array(z.unknown()),
      lineas: z.array(z.unknown()),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

export interface CatalogUpdateOptions {
  sourceUrl: string;
  destinationPath: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface CatalogUpdateResult {
  catalog: TransitCatalog;
  destinationPath: string;
}

export async function updateCatalog(options: CatalogUpdateOptions): Promise<CatalogUpdateResult> {
  validateHttpUrl("CATALOG_SOURCE_URL", options.sourceUrl);
  const destinationPath = resolveCatalogPath(options.destinationPath);
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1_000 || options.timeoutMs > 120_000) {
    throw new Error("El timeout del catálogo debe estar entre 1000 y 120000 ms");
  }

  const payload = await downloadCatalogPayload(
    options.sourceUrl,
    options.timeoutMs,
    options.fetchImpl ?? fetch,
  );
  const catalog = normalizeCatalogPayload(payload, options.sourceUrl, options.now?.() ?? new Date());
  await writeCatalogAtomically(destinationPath, catalog);
  return { catalog, destinationPath };
}

export function normalizeCatalogPayload(
  payload: unknown,
  sourceUrl: string,
  generatedAt: Date,
): TransitCatalog {
  const envelope = upstreamCatalogEnvelopeSchema.safeParse(payload);
  if (!envelope.success) {
    throw new Error(`Respuesta de catálogo no válida: ${z.prettifyError(envelope.error)}`);
  }
  if (!Number.isFinite(generatedAt.getTime())) {
    throw new Error("La fecha de generación del catálogo no es válida");
  }

  const rawLines = envelope.data.iTranvias.actualizacion.lineas;
  const rawStops = envelope.data.iTranvias.actualizacion.paradas;
  if (rawLines.length === 0 || rawStops.length === 0) {
    throw new Error("La respuesta de iTranvias no contiene líneas y paradas");
  }

  const lines = rawLines.map((rawLine, index) => mapLine(rawLine, index));
  const stops = rawStops.map((rawStop, index) => mapStop(rawStop, index));
  lines.sort((left, right) => left.line_id - right.line_id);
  stops.sort((left, right) => left.id - right.id);

  const result = transitCatalogSchema.safeParse({
    schema_version: 1,
    generated_at: generatedAt.toISOString(),
    source_url: sourceUrl,
    lines,
    stops,
  });
  if (!result.success) {
    throw new Error(`Catálogo normalizado no válido: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export async function writeCatalogAtomically(
  destinationPath: string,
  catalog: TransitCatalog,
): Promise<void> {
  const validatedCatalog = transitCatalogSchema.parse(catalog);
  const directory = path.dirname(destinationPath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(destinationPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await mkdir(directory, { recursive: true });

  try {
    await writeFile(temporaryPath, `${JSON.stringify(validatedCatalog, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporaryPath, destinationPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function downloadCatalogPayload(
  sourceUrl: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(sourceUrl, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`iTranvias respondió con HTTP ${response.status}`);
    }
    try {
      return await response.json();
    } catch {
      throw new Error("iTranvias no devolvió JSON válido");
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`La descarga del catálogo superó ${timeoutMs} ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function mapLine(rawValue: unknown, index: number): LineSummary {
  const context = `lineas[${index}]`;
  const rawLine = requireObject(rawValue, context);
  const lineId = requirePositiveInt(rawLine.id, `${context}.id`);
  const routesValue = rawLine.rutas;
  if (!Array.isArray(routesValue)) {
    throw new Error(`${context}.rutas debe ser una lista`);
  }

  const routes = routesValue.map((rawRoute, routeIndex) =>
    mapRoute(rawRoute, `${context}.rutas[${routeIndex}]`),
  );
  routes.sort((left, right) => left.route_id - right.route_id);

  return {
    line_id: lineId,
    line_name: requireNonEmptyString(rawLine.lin_comer, `${context}.lin_comer`),
    origin: optionalString(rawLine.nombre_orig),
    destination: optionalString(rawLine.nombre_dest),
    color_hex: normalizeColor(rawLine.color, `${context}.color`),
    routes,
  };
}

function mapRoute(rawValue: unknown, context: string): RouteSummary {
  const rawRoute = requireObject(rawValue, context);
  if (!Array.isArray(rawRoute.paradas)) {
    throw new Error(`${context}.paradas debe ser una lista`);
  }
  return {
    route_id: requirePositiveInt(rawRoute.ruta, `${context}.ruta`),
    origin: optionalString(rawRoute.nombre_orig),
    destination: optionalString(rawRoute.nombre_dest),
    stop_ids: rawRoute.paradas.map((rawStopId, index) =>
      requireReferencedId(rawStopId, `${context}.paradas[${index}]`, ["id", "parada"]),
    ),
  };
}

function mapStop(rawValue: unknown, index: number): StopSummary {
  const context = `paradas[${index}]`;
  const rawStop = requireObject(rawValue, context);
  if (!Array.isArray(rawStop.enlaces)) {
    throw new Error(`${context}.enlaces debe ser una lista`);
  }
  const lines = rawStop.enlaces.map((rawLineId, lineIndex) =>
    requireReferencedId(rawLineId, `${context}.enlaces[${lineIndex}]`, ["id", "linea"]),
  );

  return {
    id: requirePositiveInt(rawStop.id, `${context}.id`),
    name: requireNonEmptyString(rawStop.nombre, `${context}.nombre`),
    latitude: requireFiniteNumber(rawStop.posy, `${context}.posy`),
    longitude: requireFiniteNumber(rawStop.posx, `${context}.posx`),
    lines: [...new Set(lines)].sort((left, right) => left - right),
  };
}

function requireObject(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} debe ser un objeto`);
  }
  return value as Record<string, unknown>;
}

function requireReferencedId(
  value: unknown,
  context: string,
  objectKeys: string[],
): number {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    for (const key of objectKeys) {
      if (object[key] !== undefined) {
        return requirePositiveInt(object[key], `${context}.${key}`);
      }
    }
  }
  return requirePositiveInt(value, context);
}

function requirePositiveInt(value: unknown, context: string): number {
  const number = parseNumber(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${context} debe ser un entero positivo`);
  }
  return number;
}

function requireFiniteNumber(value: unknown, context: string): number {
  const number = parseNumber(value);
  if (!Number.isFinite(number)) {
    throw new Error(`${context} debe ser un número finito`);
  }
  return number;
}

function parseNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return Number(value.trim());
  }
  return Number.NaN;
}

function requireNonEmptyString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${context} debe ser un texto no vacío`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeColor(value: unknown, context: string): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 0xffffff) {
    return `#${value.toString(16).padStart(6, "0").toUpperCase()}`;
  }
  if (typeof value !== "string") {
    throw new Error(`${context} debe ser un color hexadecimal`);
  }
  const normalized = value.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{1,6}$/.test(normalized)) {
    throw new Error(`${context} debe ser un color hexadecimal`);
  }
  return `#${normalized.padStart(6, "0").toUpperCase()}`;
}

function readOptionsFromEnvironment(): CatalogUpdateOptions {
  const sourceUrl = process.env.CATALOG_SOURCE_URL ?? DEFAULT_CATALOG_SOURCE_URL;
  validateHttpUrl("CATALOG_SOURCE_URL", sourceUrl);
  const timeoutSeconds = parseTimeoutSeconds(process.env.CATALOG_TIMEOUT_SECONDS);
  return {
    sourceUrl,
    destinationPath: resolveCatalogPath(process.env.CATALOG_PATH),
    timeoutMs: timeoutSeconds * 1000,
  };
}

function parseTimeoutSeconds(rawValue: string | undefined): number {
  if (rawValue === undefined) {
    return DEFAULT_TIMEOUT_SECONDS;
  }
  const normalized = rawValue.trim();
  const timeoutSeconds = Number(normalized);
  if (
    normalized.length === 0 ||
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > 120
  ) {
    throw new Error("CATALOG_TIMEOUT_SECONDS debe ser un número entre 1 y 120");
  }
  return timeoutSeconds;
}

function validateHttpUrl(name: string, value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} debe ser una URL válida`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} debe usar http o https`);
  }
}

async function main(): Promise<void> {
  try {
    const { catalog, destinationPath } = await updateCatalog(readOptionsFromEnvironment());
    const routeCount = catalog.lines.reduce((total, line) => total + line.routes.length, 0);
    process.stdout.write(
      [
        `Catálogo actualizado: ${destinationPath}`,
        `Generado: ${catalog.generated_at}`,
        `Líneas: ${catalog.lines.length}; rutas: ${routeCount}; paradas: ${catalog.stops.length}`,
      ].join("\n") + "\n",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`No se pudo actualizar el catálogo: ${message}\n`);
    process.exitCode = 1;
  }
}

const isMainModule = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  void main();
}
