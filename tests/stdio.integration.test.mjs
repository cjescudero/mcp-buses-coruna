import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogGeneratedAt = "2026-07-13T10:30:00.000Z";

const stopsPayload = {
  iTranvias: {
    actualizacion: {
      lineas: [
        {
          id: 3,
          lin_comer: "3",
          nombre_orig: "Os Rosales",
          nombre_dest: "Adormideras",
          color: "#e30613",
          rutas: [
            {
              ruta: 301,
              nombre_orig: "Os Rosales",
              nombre_dest: "Adormideras",
              paradas: [42, 7],
            },
          ],
        },
        {
          id: 12,
          lin_comer: "12",
          nombre_orig: "Os Castros",
          nombre_dest: "Materno",
          color: "0057b8",
          rutas: [],
        },
        {
          id: 99,
          lin_comer: "99",
          nombre_orig: "Origen 99",
          nombre_dest: "Destino 99",
          color: "000000",
          rutas: [],
        },
      ],
      paradas: [
        {
          id: 42,
          nombre: "Praza de Galicia <script>alert(1)</script>",
          posy: 43.366,
          posx: -8.404,
          enlaces: [3, 12, 99],
        },
        { id: 7, nombre: "Abente y Lago", posy: 43.37, posx: -8.39, enlaces: [3] },
        { id: 500, nombre: "Parada con fallo simulado", posy: 43.38, posx: -8.4, enlaces: [99] },
      ],
    },
  },
};

const arrivalsPayload = {
  buses: {
    lineas: [
      {
        linea: 3,
        buses: [
          { bus: 301, tiempo: 8, distancia: 1700, estado: 0, ult_parada: 8 },
          { bus: 302, tiempo: 2, distancia: 350, estado: 0, ult_parada: 6 },
        ],
      },
      { linea: 12, buses: [{ bus: 1201, tiempo: 5, distancia: 900, estado: 0 }] },
      { linea: 99, buses: [{ bus: 9901, tiempo: 1, distancia: 100, estado: 0 }] },
    ],
  },
};

const normalizedCatalog = {
  schema_version: 1,
  generated_at: catalogGeneratedAt,
  source_url: "https://example.test/itranvias-func-7",
  lines: [
    {
      line_id: 3,
      line_name: "3",
      origin: "Os Rosales",
      destination: "Adormideras",
      color_hex: "#e30613",
      routes: [
        {
          route_id: 301,
          origin: "Os Rosales",
          destination: "Adormideras",
          stop_ids: [42, 7],
        },
      ],
    },
    {
      line_id: 12,
      line_name: "12",
      origin: "Os Castros",
      destination: "Materno",
      color_hex: "#0057b8",
      routes: [],
    },
    {
      line_id: 99,
      line_name: "99",
      origin: "Origen 99",
      destination: "Destino 99",
      color_hex: "#000000",
      routes: [],
    },
  ],
  stops: [
    {
      id: 42,
      name: "Praza de Galicia <script>alert(1)</script>",
      latitude: 43.366,
      longitude: -8.404,
      lines: [3, 12, 99],
    },
    { id: 7, name: "Abente y Lago", latitude: 43.37, longitude: -8.39, lines: [3] },
    {
      id: 500,
      name: "Parada con fallo simulado",
      latitude: 43.38,
      longitude: -8.4,
      lines: [99],
    },
  ],
};

const expectedCatalogMetadata = {
  schema_version: 1,
  generated_at: catalogGeneratedAt,
  line_count: 3,
  stop_count: 3,
};

async function startMockTransitApi() {
  let catalogRequests = 0;
  let arrivalRequests = 0;
  let catalogResponse = stopsPayload;
  const server = createHttpServer((request, response) => {
    response.setHeader("content-type", "application/json; charset=utf-8");
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.searchParams.get("func") === "7") {
      catalogRequests += 1;
      response.end(JSON.stringify(catalogResponse));
      return;
    }
    if (url.searchParams.get("func") === "0") {
      arrivalRequests += 1;
      if (url.searchParams.get("dato") === "500") {
        response.statusCode = 503;
        response.end(JSON.stringify({ error: "service_unavailable" }));
        return;
      }
      response.end(JSON.stringify(arrivalsPayload));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not_found" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    getCatalogRequests: () => catalogRequests,
    getArrivalRequests: () => arrivalRequests,
    setCatalogResponse: (value) => {
      catalogResponse = value;
    },
  };
}

function runCatalogUpdate(env) {
  return new Promise((resolve, reject) => {
    const command = process.platform === "win32" ? "npm.cmd" : "npm";
    const child = spawn(command, ["run", "update:catalog", "--silent"], {
      cwd: projectDir,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test("contrato MCP por stdio", async (t) => {
  const mockApi = await startMockTransitApi();
  const tempDir = await mkdtemp(path.join(tmpdir(), "mcp-buses-coruna-test-"));
  const catalogPath = path.join(tempDir, "transit-catalog.json");
  await writeFile(catalogPath, `${JSON.stringify(normalizedCatalog, null, 2)}\n`, "utf8");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectDir, "dist", "main.js")],
    cwd: projectDir,
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      CATALOG_PATH: catalogPath,
      CATALOG_SOURCE_URL: `${mockApi.baseUrl}/query?func=7`,
      ARRIVALS_URL_TEMPLATE: `${mockApi.baseUrl}/query?func=0&dato={stop_id}`,
      HTTP_TIMEOUT_SECONDS: "2",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "mcp-buses-coruna-tests", version: "1.0.0" });

  t.after(async () => {
    await client.close().catch(() => {});
    await mockApi.close();
    await rm(tempDir, { recursive: true, force: true });
  });
  await client.connect(transport);

  await t.test("publica las herramientas y el recurso de la app", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ["list_bus_lines", "search_stops", "show_bus_arrivals"],
    );
    const { resources } = await client.listResources();
    assert(resources.some((resource) => resource.uri === "ui://buses-coruna/mcp-app.html"));
    const resource = await client.readResource({ uri: "ui://buses-coruna/mcp-app.html" });
    assert.match(resource.contents[0]?.text ?? "", /<!doctype html>/i);
  });

  await t.test("devuelve todas las líneas en el orden del snapshot", async () => {
    const result = await client.callTool({ name: "list_bus_lines", arguments: {} });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.total, 3);
    assert.deepEqual(result.structuredContent.catalog, expectedCatalogMetadata);
    assert.deepEqual(
      result.structuredContent.lines.map((line) => line.line_id),
      [3, 12, 99],
    );
    assert.deepEqual(result.structuredContent.lines[0], {
      line_id: 3,
      line_name: "3",
      origin: "Os Rosales",
      destination: "Adormideras",
      color_hex: "#e30613",
      routes: [
        {
          route_id: 301,
          origin: "Os Rosales",
          destination: "Adormideras",
          stop_ids: [42, 7],
        },
      ],
    });
  });

  await t.test("devuelve todas las paradas y líneas sin priorización", async () => {
    const result = await client.callTool({ name: "search_stops", arguments: {} });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.total, 3);
    assert.deepEqual(result.structuredContent.catalog, expectedCatalogMetadata);
    assert.deepEqual(
      result.structuredContent.stops.map((stop) => stop.id),
      [42, 7, 500],
    );
    assert.deepEqual(result.structuredContent.stops[0].lines, [3, 12, 99]);
    assert.deepEqual(result.structuredContent.stops[1].lines, [3]);
    assert.deepEqual(result.structuredContent.stops[2].lines, [99]);
  });

  await t.test("busca por nombre o identificador y respeta el límite", async () => {
    const byName = await client.callTool({
      name: "search_stops",
      arguments: { query: "galicia", limit: 1 },
    });
    assert.equal(byName.isError, undefined);
    assert.equal(byName.structuredContent.total, 1);
    assert.equal(byName.structuredContent.stops[0].id, 42);

    const byId = await client.callTool({
      name: "search_stops",
      arguments: { query: "42" },
    });
    assert.equal(byId.isError, undefined);
    assert.deepEqual(byId.structuredContent.stops.map((stop) => stop.id), [42]);
  });

  await t.test("exige stopId para consultar llegadas", async () => {
    const result = await client.callTool({ name: "show_bus_arrivals", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /stopId|required|invalid/i);
  });

  await t.test("devuelve todas las líneas y ordena los buses por ETA", async () => {
    const result = await client.callTool({ name: "show_bus_arrivals", arguments: { stopId: 42 } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent.catalog, expectedCatalogMetadata);
    const lines = result.structuredContent.arrivals.lines;
    assert.deepEqual(lines.map((line) => line.line_id), [3, 12, 99]);
    assert.deepEqual(lines[0].buses.map((bus) => bus.eta_minutes), [2, 8]);
    assert.deepEqual(lines[1].buses.map((bus) => bus.eta_minutes), [5]);
    assert.deepEqual(lines[2].buses.map((bus) => bus.eta_minutes), [1]);
  });

  await t.test("marca una parada inexistente como error de herramienta", async () => {
    const result = await client.callTool({ name: "show_bus_arrivals", arguments: { stopId: 9999 } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.message, "stop_not_found");
  });

  await t.test("marca los fallos del proveedor como error de herramienta", async () => {
    const result = await client.callTool({ name: "show_bus_arrivals", arguments: { stopId: 500 } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.message, "transit_api_error_503");
  });

  await t.test("nunca solicita func=7 durante la ejecución normal", async () => {
    await client.callTool({ name: "search_stops", arguments: {} });
    await client.callTool({ name: "search_stops", arguments: { query: "abente" } });
    await client.callTool({ name: "list_bus_lines", arguments: {} });
    await client.callTool({ name: "show_bus_arrivals", arguments: { stopId: 7 } });
    await client.callTool({ name: "show_bus_arrivals", arguments: { stopId: 42 } });
    assert.equal(mockApi.getCatalogRequests(), 0);
    assert.ok(mockApi.getArrivalRequests() >= 2);
  });
});

test("actualiza el catálogo manualmente y de forma atómica", async (t) => {
  const mockApi = await startMockTransitApi();
  const tempDir = await mkdtemp(path.join(tmpdir(), "mcp-buses-coruna-update-"));
  const catalogPath = path.join(tempDir, "transit-catalog.json");

  t.after(async () => {
    await mockApi.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  const updateEnv = {
    CATALOG_SOURCE_URL: `${mockApi.baseUrl}/query?func=7&dato=test-snapshot`,
    CATALOG_PATH: catalogPath,
    CATALOG_TIMEOUT_SECONDS: "2",
  };
  const success = await runCatalogUpdate(updateEnv);
  assert.equal(success.code, 0, success.stderr || success.stdout);

  const generated = JSON.parse(await readFile(catalogPath, "utf8"));
  assert.equal(generated.schema_version, 1);
  assert.match(generated.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(generated.source_url, updateEnv.CATALOG_SOURCE_URL);
  assert.deepEqual(
    generated.lines.map((line) => ({ id: line.line_id, color: line.color_hex })),
    [
      { id: 3, color: "#E30613" },
      { id: 12, color: "#0057B8" },
      { id: 99, color: "#000000" },
    ],
  );
  assert.deepEqual(generated.lines[0].routes, normalizedCatalog.lines[0].routes);
  assert.deepEqual(
    generated.stops.map((stop) => stop.id),
    [7, 42, 500],
  );
  assert.deepEqual(generated.stops.find((stop) => stop.id === 42), normalizedCatalog.stops[0]);
  assert.deepEqual(await readdir(tempDir), ["transit-catalog.json"]);

  const previousContents = await readFile(catalogPath, "utf8");
  mockApi.setCatalogResponse({ iTranvias: { actualizacion: { lineas: "invalid", paradas: [] } } });
  const failure = await runCatalogUpdate(updateEnv);
  assert.notEqual(failure.code, 0, "un payload inválido no debe aceptarse");
  assert.equal(await readFile(catalogPath, "utf8"), previousContents);
  assert.deepEqual(await readdir(tempDir), ["transit-catalog.json"]);
  assert.equal(mockApi.getCatalogRequests(), 2);
});
