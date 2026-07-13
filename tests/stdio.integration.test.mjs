import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const stopsPayload = {
  iTranvias: {
    actualizacion: {
      lineas: [
        { id: 3, lin_comer: "3", color: "#e30613" },
        { id: 12, lin_comer: "12", color: "0057b8" },
        { id: 99, lin_comer: "99", color: "000000" },
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

async function startMockTransitApi() {
  let stopRequests = 0;
  const server = createHttpServer((request, response) => {
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.url === "/stops") {
      stopRequests += 1;
      response.end(JSON.stringify(stopsPayload));
      return;
    }
    if (request.url?.startsWith("/arrivals/")) {
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
    getStopRequests: () => stopRequests,
  };
}

test("contrato MCP por stdio", async (t) => {
  const mockApi = await startMockTransitApi();
  const tempDir = await mkdtemp(path.join(tmpdir(), "mcp-buses-coruna-test-"));
  const configPath = path.join(tempDir, "app_config.json");
  await writeFile(
    configPath,
    JSON.stringify({ primary_stop_id: 42, interest_lines: ["3", "12"] }),
    "utf8",
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectDir, "dist", "main.js")],
    cwd: projectDir,
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      APP_CONFIG_PATH: configPath,
      STOPS_SOURCE_URL: `${mockApi.baseUrl}/stops`,
      ARRIVALS_URL_TEMPLATE: `${mockApi.baseUrl}/arrivals/{stop_id}`,
      CACHE_TTL_SECONDS: "60",
      HTTP_TIMEOUT_SECONDS: "2",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "mcp-buses-coruna-tests", version: "1.0.0" });

  t.after(async () => {
    await client.close().catch(() => {});
    await mockApi.close();
  });
  await client.connect(transport);

  await t.test("publica las herramientas y el recurso de la app", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ["search_stops", "show_bus_arrivals", "show_default_bus_arrivals"],
    );
    const { resources } = await client.listResources();
    assert(resources.some((resource) => resource.uri === "ui://buses-coruna/mcp-app.html"));
    const resource = await client.readResource({ uri: "ui://buses-coruna/mcp-app.html" });
    assert.match(resource.contents[0]?.text ?? "", /<!doctype html>/i);
  });

  await t.test("busca, filtra y limita paradas", async () => {
    const result = await client.callTool({
      name: "search_stops",
      arguments: { query: "galicia", limit: 1 },
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.total, 1);
    assert.equal(result.structuredContent.stops[0].id, 42);
    assert.deepEqual(result.structuredContent.stops[0].lines, [3, 12]);
  });

  await t.test("ordena llegadas por ETA y excluye líneas no configuradas", async () => {
    const result = await client.callTool({ name: "show_bus_arrivals", arguments: { stopId: 42 } });
    assert.equal(result.isError, undefined);
    const lines = result.structuredContent.arrivals.lines;
    assert.deepEqual(lines.map((line) => line.line_id), [3, 12]);
    assert.deepEqual(lines[0].buses.map((bus) => bus.eta_minutes), [2, 8]);
  });

  await t.test("marca una parada inexistente como error de herramienta", async () => {
    const result = await client.callTool({ name: "show_bus_arrivals", arguments: { stopId: 9999 } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.message, "stop_not_found");
  });

  await t.test("reutiliza el catálogo cacheado durante la sesión", async () => {
    await client.callTool({ name: "search_stops", arguments: {} });
    await client.callTool({ name: "show_default_bus_arrivals", arguments: {} });
    assert.equal(mockApi.getStopRequests(), 1);
  });
});

test("una línea de interés inexistente no habilita todas las paradas", async (t) => {
  const mockApi = await startMockTransitApi();
  const tempDir = await mkdtemp(path.join(tmpdir(), "mcp-buses-coruna-empty-interest-test-"));
  const configPath = path.join(tempDir, "app_config.json");
  await writeFile(
    configPath,
    JSON.stringify({ primary_stop_id: 42, interest_lines: ["LINEA-INEXISTENTE"] }),
    "utf8",
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectDir, "dist", "main.js")],
    cwd: projectDir,
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      APP_CONFIG_PATH: configPath,
      STOPS_SOURCE_URL: `${mockApi.baseUrl}/stops`,
      ARRIVALS_URL_TEMPLATE: `${mockApi.baseUrl}/arrivals/{stop_id}`,
      CACHE_TTL_SECONDS: "60",
      HTTP_TIMEOUT_SECONDS: "2",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "mcp-buses-coruna-interest-regression", version: "1.0.0" });

  t.after(async () => {
    await client.close().catch(() => {});
    await mockApi.close();
  });
  await client.connect(transport);

  const result = await client.callTool({ name: "search_stops", arguments: {} });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.total, 0);
  assert.deepEqual(result.structuredContent.stops, []);
});
