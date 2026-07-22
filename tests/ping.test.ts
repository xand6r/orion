import { describe, expect, it } from "vitest";
import { startPingServer } from "../src/http/ping.js";
import { createLogger } from "../src/logger.js";

describe("ping server", () => {
  it("returns pong on GET /ping", async () => {
    const server = startPingServer({
      port: 0,
      host: "127.0.0.1",
      log: createLogger("error"),
    });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("expected port address");

    const res = await fetch(`http://127.0.0.1:${addr.port}/ping`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("pong");

    const missing = await fetch(`http://127.0.0.1:${addr.port}/nope`);
    expect(missing.status).toBe(404);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
