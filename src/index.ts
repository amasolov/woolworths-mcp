#!/usr/bin/env node

// Woolworths MCP server.
//
// Transports:
//   stdio (default)      - for desktop clients that spawn the server.
//   MCP_TRANSPORT=http   - Streamable HTTP on PORT (default 8000), path /mcp,
//                          plus GET /healthz.
//
// HTTP is stateless: every POST gets a fresh MCP server and transport, and no
// session id is handed out. Nothing an MCP session would hold lives in one -
// the Woolworths cookies are per process (see woolworths.ts) - so a pod
// restart cannot strand a client on a session id the new process never
// issued.

import { readFileSync } from "node:fs";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { callTool, toolDefinitions } from "./tools.js";
import { shutdown as closeBrowser } from "./woolworths.js";

// The version is package.json's, so a release bump cannot miss it.
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const SERVER_INFO = { name: "woolworths-mcp-server", version };
const MAX_BODY_BYTES = 1024 * 1024;

function buildServer(): Server {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      const result = await callTool(name, args ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[woolworths] ${name} failed: ${message}`);
      return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
    }
  });

  return server;
}

async function runStdio() {
  await buildServer().connect(new StdioServerTransport());
  console.error("Woolworths MCP server running on stdio");
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("request body is not JSON"));
      }
    });
    req.on("error", reject);
  });
}

function jsonRpcError(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

async function handleMcp(req: IncomingMessage, res: ServerResponse) {
  // Stateless: no server-initiated stream to GET and no session to DELETE.
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return jsonRpcError(res, 405, "Method not allowed");
  }

  let body: unknown;
  try {
    body = await readJson(req);
  } catch (error) {
    return jsonRpcError(res, 400, (error as Error).message);
  }

  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

async function runHttp() {
  const port = Number(process.env.PORT ?? 8000);

  const http = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/healthz" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("ok");
    }
    if (path === "/mcp") {
      return handleMcp(req, res).catch((error) => {
        console.error("[woolworths] request failed:", error);
        if (!res.headersSent) jsonRpcError(res, 500, "Internal server error");
      });
    }
    res.writeHead(404).end();
  });

  const shutdown = () => {
    closeBrowser();
    http.close(() => process.exit(0));
    // Don't wait on a slow in-flight request past the pod's grace period.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  http.listen(port, () => {
    console.error(`Woolworths MCP server on http://0.0.0.0:${port}/mcp (tools: ${toolDefinitions.map((t) => t.name).join(", ")})`);
  });
}

const transport = process.env.MCP_TRANSPORT ?? "stdio";
const run = transport === "http" ? runHttp : transport === "stdio" ? runStdio : null;
if (!run) {
  console.error(`MCP_TRANSPORT must be "stdio" or "http", not "${transport}"`);
  process.exit(1);
}
run().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
