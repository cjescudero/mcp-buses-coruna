import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const positiveInteger = z.number().int().positive();
const nullableName = z.string().trim().min(1).nullable();

export const routeSummarySchema = z
  .object({
    route_id: positiveInteger,
    origin: nullableName,
    destination: nullableName,
    stop_ids: z.array(positiveInteger),
  })
  .strict();

export const lineSummarySchema = z
  .object({
    line_id: positiveInteger,
    line_name: z.string().trim().min(1),
    origin: nullableName,
    destination: nullableName,
    color_hex: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/)
      .nullable(),
    routes: z.array(routeSummarySchema),
  })
  .strict();

export const stopSummarySchema = z
  .object({
    id: positiveInteger,
    name: z.string().trim().min(1),
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    lines: z.array(positiveInteger),
  })
  .strict();

export const transitCatalogSchema = z
  .object({
    schema_version: z.literal(1),
    generated_at: z.iso.datetime({ offset: true }),
    source_url: z.url().refine((value) => {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    }, "source_url debe usar http o https"),
    lines: z.array(lineSummarySchema).min(1),
    stops: z.array(stopSummarySchema).min(1),
  })
  .strict()
  .superRefine((catalog, context) => {
    const lineIds = new Set<number>();
    for (const [lineIndex, line] of catalog.lines.entries()) {
      if (lineIds.has(line.line_id)) {
        context.addIssue({
          code: "custom",
          path: ["lines", lineIndex, "line_id"],
          message: `line_id duplicado: ${line.line_id}`,
        });
      }
      lineIds.add(line.line_id);

      const routeIds = new Set<number>();
      for (const [routeIndex, route] of line.routes.entries()) {
        if (routeIds.has(route.route_id)) {
          context.addIssue({
            code: "custom",
            path: ["lines", lineIndex, "routes", routeIndex, "route_id"],
            message: `route_id duplicado en la línea ${line.line_id}: ${route.route_id}`,
          });
        }
        routeIds.add(route.route_id);
      }
    }

    const stopIds = new Set<number>();
    for (const [stopIndex, stop] of catalog.stops.entries()) {
      if (stopIds.has(stop.id)) {
        context.addIssue({
          code: "custom",
          path: ["stops", stopIndex, "id"],
          message: `id de parada duplicado: ${stop.id}`,
        });
      }
      stopIds.add(stop.id);

      const stopLineIds = new Set<number>();
      for (const [lineIndex, lineId] of stop.lines.entries()) {
        if (stopLineIds.has(lineId)) {
          context.addIssue({
            code: "custom",
            path: ["stops", stopIndex, "lines", lineIndex],
            message: `línea duplicada en la parada ${stop.id}: ${lineId}`,
          });
        }
        stopLineIds.add(lineId);
        if (!lineIds.has(lineId)) {
          context.addIssue({
            code: "custom",
            path: ["stops", stopIndex, "lines", lineIndex],
            message: `línea inexistente en la parada ${stop.id}: ${lineId}`,
          });
        }
      }
    }

    for (const [lineIndex, line] of catalog.lines.entries()) {
      for (const [routeIndex, route] of line.routes.entries()) {
        for (const [stopIndex, stopId] of route.stop_ids.entries()) {
          if (!stopIds.has(stopId)) {
            context.addIssue({
              code: "custom",
              path: ["lines", lineIndex, "routes", routeIndex, "stop_ids", stopIndex],
              message: `parada inexistente en la ruta ${route.route_id}: ${stopId}`,
            });
          }
        }
      }
    }
  });

export type RouteSummary = z.infer<typeof routeSummarySchema>;
export type LineSummary = z.infer<typeof lineSummarySchema>;
export type StopSummary = z.infer<typeof stopSummarySchema>;
export type TransitCatalog = z.infer<typeof transitCatalogSchema>;

export interface CatalogMetadata {
  readonly schema_version: 1;
  readonly generated_at: string;
  readonly line_count: number;
  readonly stop_count: number;
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CATALOG_PATH = path.basename(MODULE_DIR) === "dist"
  ? path.resolve(MODULE_DIR, "..", "data", "transit-catalog.json")
  : path.resolve(MODULE_DIR, "data", "transit-catalog.json");

export function resolveCatalogPath(configuredPath = process.env.CATALOG_PATH): string {
  if (configuredPath === undefined) {
    return DEFAULT_CATALOG_PATH;
  }
  const normalized = configuredPath.trim();
  if (normalized.length === 0) {
    throw new Error("CATALOG_PATH no puede estar vacío");
  }
  return path.resolve(normalized);
}

export function loadTransitCatalog(configuredPath = process.env.CATALOG_PATH): TransitCatalog {
  const catalogPath = resolveCatalogPath(configuredPath);
  let raw: string;
  try {
    raw = readFileSync(catalogPath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : "error de lectura desconocido";
    throw new Error(`No se pudo leer el catálogo estático en ${catalogPath}: ${reason}`);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "JSON inválido";
    throw new Error(`El catálogo estático en ${catalogPath} no contiene JSON válido: ${reason}`);
  }

  const parsed = transitCatalogSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(
      `El catálogo estático en ${catalogPath} no cumple el esquema: ${z.prettifyError(parsed.error)}`,
    );
  }
  return deepFreeze(parsed.data);
}

export function getCatalogMetadata(catalog: TransitCatalog): CatalogMetadata {
  return Object.freeze({
    schema_version: catalog.schema_version,
    generated_at: catalog.generated_at,
    line_count: catalog.lines.length,
    stop_count: catalog.stops.length,
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}
