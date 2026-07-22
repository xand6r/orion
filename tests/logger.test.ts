import { describe, expect, it } from "vitest";
import { createLogger, errorFields } from "../src/logger.js";

describe("structured logger", () => {
  it("emits JSON, child context, serialized errors, and redacts secrets", () => {
    const chunks: string[] = [];
    const destination = { write: (chunk: string) => chunks.push(chunk) };
    const log = createLogger("info", destination);
    log.child({ executionId: "run-1" }).error("operation_failed", {
      ...errorFields(new Error("boom")),
      apiKey: "secret",
      chatId: "telegram-chat",
    });

    expect(chunks).toHaveLength(1);
    const row = JSON.parse(chunks[0] ?? "{}") as Record<string, unknown>;
    expect(row.msg).toBe("operation_failed");
    expect(row.executionId).toBe("run-1");
    expect(row.apiKey).toBe("[REDACTED]");
    expect(row.chatId).toBe("[REDACTED]");
    expect((row.err as { message?: string }).message).toBe("boom");
  });
});
