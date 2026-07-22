import { createServer, type Server } from "node:http";
import type { Logger } from "../logger.js";

/** Tiny HTTP health server — GET /ping → pong */
export function startPingServer(input: {
  port: number;
  host?: string;
  log: Logger;
}): Server {
  const host = input.host ?? "0.0.0.0";
  const server = createServer((req, res) => {
    const path = req.url?.split("?")[0] ?? "";
    if (req.method === "GET" && path === "/ping") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("pong");
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  });

  server.listen(input.port, host, () => {
    input.log.info("ping_server_listening", { host, port: input.port, path: "/ping" });
  });

  server.on("error", (err) => {
    input.log.error("ping_server_error", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return server;
}
