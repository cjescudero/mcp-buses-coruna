import cors from "cors";
import express from "express";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";

const transportMode = process.env.MCP_TRANSPORT?.toLowerCase() ?? "stdio";
const port = Number(process.env.PORT ?? 3001);

async function startStdioServer(): Promise<void> {
  const transport = new StdioServerTransport();
  const server = createServer();
  await server.connect(transport);
}

async function startHttpServer(): Promise<void> {
  const app = express();
  app.use(
    cors({
      origin: "*",
      exposedHeaders: ["Mcp-Session-Id"],
      allowedHeaders: ["Content-Type", "mcp-session-id"],
    }),
  );

  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      transport: "streamable-http",
    });
  });

  app.all("/mcp", async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const server = createServer();

    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.error(`MCP HTTP server listening on http://localhost:${port}/mcp`);
  });
}

if (transportMode === "http") {
  startHttpServer().catch((error) => {
    // eslint-disable-next-line no-console
    console.error("Failed to start HTTP server", error);
    process.exit(1);
  });
} else {
  startStdioServer().catch((error) => {
    // eslint-disable-next-line no-console
    console.error("Failed to start stdio server", error);
    process.exit(1);
  });
}
