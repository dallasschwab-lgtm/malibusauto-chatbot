import http from "node:http";
import { logger } from "./lib/logger.js";
import { router } from "./routes/index.js";

const BODY_LIMIT_BYTES = 1 * 1024 * 1024; // 1 MB

function parseJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > BODY_LIMIT_BYTES) {
        req.destroy(new Error("BODY_TOO_LARGE"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });

    req.on("error", reject);
  });
}

function parseUrl(rawUrl: string | undefined): URL | null {
  try {
    // Use a fixed internal base — never trust the Host header for routing
    return new URL(rawUrl ?? "/", "http://localhost");
  } catch {
    return null;
  }
}

export function createServer(): http.Server {
  return http.createServer(async (req, res) => {
    const method = req.method ?? "GET";

    const url = parseUrl(req.url);
    if (!url) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Malformed request URI" }));
      return;
    }

    logger.info({ method, path: url.pathname }, "incoming request");

    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Parse JSON body for non-GET/HEAD requests
    let body: unknown = undefined;
    const contentType = req.headers["content-type"] ?? "";
    if (contentType.includes("application/json") && method !== "GET" && method !== "HEAD") {
      try {
        body = await parseJsonBody(req);
      } catch (err) {
        const isTooLarge = err instanceof Error && err.message === "BODY_TOO_LARGE";
        res.writeHead(isTooLarge ? 413 : 400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: isTooLarge ? "Request body too large" : "Invalid JSON body" }));
        return;
      }
    }

    const handler = router(method, url.pathname);

    if (!handler) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    try {
      await handler(req, res, { url, method, body });
    } catch (err) {
      logger.error({ err }, "Unhandled error in route handler");
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  });
}
