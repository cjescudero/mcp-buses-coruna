import { timingSafeEqual } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, createTransitBackend } from "./server.js";

const transportMode = (process.env.MCP_TRANSPORT ?? "stdio").trim().toLowerCase();

function parseIntegerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${name} debe ser un entero entre ${min} y ${max}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} debe ser un entero entre ${min} y ${max}`);
  }
  return value;
}

function csvEnv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function requestHostname(req: Request): string | null {
  const host = req.headers.host;
  if (!host) {
    return null;
  }
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function safeTokenEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

async function startStdioServer(): Promise<void> {
  const transport = new StdioServerTransport();
  const server = createServer();
  await server.connect(transport);
}

async function startHttpServer(): Promise<void> {
  const host = (process.env.HOST ?? "127.0.0.1").trim();
  if (!host) {
    throw new Error("HOST no puede estar vacío");
  }
  const port = parseIntegerEnv("PORT", 3001, 1, 65_535);
  const rateLimit = parseIntegerEnv("MCP_RATE_LIMIT_PER_MINUTE", 120, 0, 100_000);
  const authToken = process.env.MCP_AUTH_TOKEN;
  if (authToken !== undefined && authToken.length === 0) {
    throw new Error("MCP_AUTH_TOKEN no puede estar vacío");
  }
  const configuredOrigins = new Set(csvEnv("MCP_ALLOWED_ORIGINS"));
  const allowedHosts = new Set(
    ["127.0.0.1", "localhost", "::1", host, ...csvEnv("MCP_ALLOWED_HOSTS")].map((item) =>
      item.toLowerCase(),
    ),
  );
  const isAllowedOrigin = (origin: string): boolean => {
    if (configuredOrigins.has("*") || configuredOrigins.has(origin)) {
      return true;
    }
    if (configuredOrigins.size > 0) {
      return false;
    }
    try {
      return allowedHosts.has(new URL(origin).hostname.toLowerCase());
    } catch {
      return false;
    }
  };

  const app = express();
  const backend = createTransitBackend();
  const activeConnections = new Set<() => Promise<void>>();
  const rateBuckets = new Map<string, { count: number; resetAt: number }>();

  app.disable("x-powered-by");
  // The documented deployment uses a loopback reverse proxy. Trust only that
  // hop so req.ip reflects X-Forwarded-For without accepting arbitrary remote
  // proxy headers.
  app.set("trust proxy", "loopback");
  app.use((req, res, next) => {
    const hostname = requestHostname(req);
    if (!hostname || !allowedHosts.has(hostname)) {
      res.status(403).json({ error: "host_not_allowed" });
      return;
    }
    const origin = req.headers.origin;
    if (origin && !isAllowedOrigin(origin)) {
      res.status(403).json({ error: "origin_not_allowed" });
      return;
    }
    next();
  });
  app.use(
    cors({
      origin(origin, callback) {
        callback(null, !origin || isAllowedOrigin(origin));
      },
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
      exposedHeaders: ["Mcp-Session-Id", "Mcp-Protocol-Version"],
      allowedHeaders: [
        "Accept",
        "Authorization",
        "Content-Type",
        "Last-Event-ID",
        "Mcp-Protocol-Version",
        "Mcp-Session-Id",
      ],
    }),
  );
  app.use(express.json({ limit: "2mb", type: ["application/json", "application/*+json"] }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", transport: "streamable-http" });
  });

  app.all("/mcp", (req, res, next) => {
    if (authToken !== undefined) {
      const authorization = req.headers.authorization ?? "";
      const suppliedToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      if (!safeTokenEqual(suppliedToken, authToken)) {
        res.setHeader("WWW-Authenticate", "Bearer");
        res.status(401).json({ error: "unauthorized" });
        return;
      }
    }

    if (rateLimit > 0) {
      const now = Date.now();
      const key = req.ip || req.socket.remoteAddress || "unknown";
      const current = rateBuckets.get(key);
      const bucket = !current || current.resetAt <= now ? { count: 0, resetAt: now + 60_000 } : current;
      bucket.count += 1;
      rateBuckets.set(key, bucket);
      res.setHeader("RateLimit-Limit", String(rateLimit));
      res.setHeader("RateLimit-Remaining", String(Math.max(0, rateLimit - bucket.count)));
      res.setHeader("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));
      if (bucket.count > rateLimit) {
        res.setHeader("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
        res.status(429).json({ error: "rate_limit_exceeded" });
        return;
      }
      if (rateBuckets.size > 10_000) {
        for (const [bucketKey, value] of rateBuckets) {
          if (value.resetAt <= now) rateBuckets.delete(bucketKey);
        }
      }
    }
    next();
  });

  app.all("/mcp", async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createServer(backend);
    let cleanedUp = false;
    const cleanup = async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      activeConnections.delete(cleanup);
      await Promise.allSettled([transport.close(), server.close()]);
    };
    activeConnections.add(cleanup);
    res.once("close", () => void cleanup());

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      await cleanup();
      if (!res.headersSent) {
        res.status(500).json({ error: "mcp_request_failed" });
      } else {
        res.destroy(error instanceof Error ? error : undefined);
      }
    }
  });

  const httpServer = await new Promise<HttpServer>((resolve, reject) => {
    const candidate = app.listen(port, host, (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      candidate.off("error", reject);
      resolve(candidate);
    });
    candidate.once("error", reject);
  });
  // eslint-disable-next-line no-console
  console.error(`MCP HTTP server listening on http://${host}:${port}/mcp`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.error(`Received ${signal}; closing MCP HTTP server`);
    const serverClosed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await Promise.allSettled([...activeConnections].map((cleanup) => cleanup()));
    await serverClosed;
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void shutdown(signal).then(() => process.exit(0));
    });
  }
}

if (transportMode === "http") {
  startHttpServer().catch((error) => {
    // eslint-disable-next-line no-console
    console.error("Failed to start HTTP server", error);
    process.exitCode = 1;
  });
} else if (transportMode === "stdio") {
  startStdioServer().catch((error) => {
    // eslint-disable-next-line no-console
    console.error("Failed to start stdio server", error);
    process.exitCode = 1;
  });
} else {
  // eslint-disable-next-line no-console
  console.error("MCP_TRANSPORT debe ser 'stdio' o 'http'");
  process.exitCode = 1;
}
