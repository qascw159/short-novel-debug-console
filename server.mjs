import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const host = process.env.HOST || "127.0.0.1";
const port = Number.parseInt(process.env.PORT || "5173", 10);
const apiTarget = new URL(process.env.API_TARGET || "http://49.232.138.53:8010");
const root = dirname(fileURLToPath(import.meta.url));
const indexPath = join(root, "index.html");

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`);
}

function proxyApi(request, response) {
  const upstreamUrl = new URL(request.url, apiTarget);
  const transport = upstreamUrl.protocol === "https:" ? httpsRequest : httpRequest;
  const headers = { ...request.headers, host: upstreamUrl.host };

  const upstreamRequest = transport(
    upstreamUrl,
    { method: request.method, headers },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, {
        ...upstreamResponse.headers,
        "x-accel-buffering": "no",
      });
      upstreamResponse.pipe(response);
    },
  );

  upstreamRequest.on("error", (error) => {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    response.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "API proxy failed", message: error.message }));
  });

  request.on("aborted", () => upstreamRequest.destroy());
  request.pipe(upstreamRequest);
}

async function serveIndex(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" });
    response.end();
    return;
  }

  const file = await stat(indexPath);
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-length": file.size,
    "content-type": "text/html; charset=utf-8",
  });

  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(indexPath).pipe(response);
}

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname.startsWith("/api/")) {
      proxyApi(request, response);
      return;
    }
    if (pathname === "/" || pathname === "/index.html") {
      await serveIndex(request, response);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "Local server failed", message: error.message }));
  }
});

server.listen(port, host, () => {
  console.log(`Short Novel Debug Console: http://${host}:${port}`);
  console.log(`API proxy target: ${apiTarget.origin}`);
});

