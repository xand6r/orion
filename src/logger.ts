import pino, { type DestinationStream, type Logger as PinoLogger } from "pino";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export type Logger = {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
};

export function createLogger(
  level: LogLevel = "info",
  destination?: DestinationStream,
  options: { pretty?: boolean } = {},
): Logger {
  const usePretty = options.pretty === true && !destination;
  const root = pino(
    {
      level,
      base: {
        service: "orion",
        pid: process.pid,
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: [
          "apiKey",
          "token",
          "*.apiKey",
          "*.token",
          "headers.authorization",
          "*.headers.authorization",
          "chatId",
          "userId",
          "senderId",
          "messageId",
          "updateId",
          "*.chatId",
          "*.userId",
          "*.senderId",
          "*.messageId",
          "*.updateId",
        ],
        censor: "[REDACTED]",
      },
      serializers: {
        err: pino.stdSerializers.err,
      },
      ...(usePretty
        ? {
            transport: {
              target: "pino-pretty",
              options: {
                colorize: true,
                translateTime: "SYS:HH:MM:ss",
                ignore: "pid,hostname,service",
                singleLine: false,
              },
            },
          }
        : {}),
    },
    destination,
  );
  return wrap(root);
}

function wrap(log: PinoLogger): Logger {
  return {
    debug: (message, fields) => log.debug(fields ?? {}, message),
    info: (message, fields) => log.info(fields ?? {}, message),
    warn: (message, fields) => log.warn(fields ?? {}, message),
    error: (message, fields) => log.error(fields ?? {}, message),
    child: (bindings) => wrap(log.child(bindings)),
  };
}

export function errorFields(error: unknown): LogFields {
  return error instanceof Error
    ? { err: error, errorType: error.name, errorMessage: error.message }
    : { errorType: typeof error, errorMessage: String(error) };
}
