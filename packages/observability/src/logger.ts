import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';

import { getCorrelationContext } from './correlation-context';
import { redactedLogPaths, redactionCensorValue } from './redaction';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type LogFormat = 'json' | 'pretty';

export interface LoggerConfiguration {
  readonly serviceName: string;
  readonly level: LogLevel;
  readonly format: LogFormat;
  readonly nodeEnvironment: string;
  readonly version?: string;
  /**
  Overrides the output stream. Used by tests to assert on emitted lines.
  */
  readonly destination?: DestinationStream;
}

function buildTransport(format: LogFormat): LoggerOptions['transport'] {
  if (format !== 'pretty') {
    return undefined;
  }
  return {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
  };
}

/**
 * Reduces an error to what identifies it.
 *
 * A driver error carries its whole client: connection parameters, socket
 * state, the type catalogue. pino's default serializer copies every own
 * property, so one database restart writes several kilobytes of internals per
 * line -- including the host and the role it connects as. Everything an
 * operator can act on is in these five fields.
 */
/**
 * The same bound applied to a plain object. Ten fields is more than any real
 * failure payload carries and far less than a driver's internals.
 */
const maximumSerializedFields = 10;

function serializeError(error: unknown): Record<string, unknown> {
  if (typeof error === 'object' && error !== null && !(error instanceof Error)) {
    // pg-boss emits a plain object rather than an Error, and `String()` renders
    // that as "[object Object]": a line that reports a failure and says nothing
    // whatsoever about it, at the moment somebody is reading logs to find out.
    // Primitives only, for the same reason the Error branch drops `client`: a
    // nested value on one of these is the emitting library's internals, and
    // that is what turned a log line into kilobytes in the first place.
    const fields = Object.entries(error as Record<string, unknown>)
      .filter(([, value]) => typeof value !== 'object' && typeof value !== 'function')
      .slice(0, maximumSerializedFields);

    return { type: 'object', ...Object.fromEntries(fields) };
  }

  if (!(error instanceof Error)) {
    return { message: String(error) };
  }

  const code = (error as { code?: unknown }).code;

  return {
    type: error.name,
    message: error.message,
    ...(typeof code === 'string' && { code }),
    stack: error.stack,
    ...(error.cause !== undefined && { cause: serializeError(error.cause) }),
  };
}

export function createLogger(configuration: LoggerConfiguration): Logger {
  const options: LoggerOptions = {
    level: configuration.level,
    base: {
      service: configuration.serviceName,
      environment: configuration.nodeEnvironment,
      version: configuration.version,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'message',
    errorKey: 'error',
    serializers: { error: serializeError },
    formatters: {
      level: (label: string) => ({ level: label }),
    },
    // Stamps the active correlation context onto every line, so no call site
    // has to remember to pass a logger around.
    mixin: () => ({ ...getCorrelationContext() }),
    redact: { paths: [...redactedLogPaths], censor: redactionCensorValue },
    // A transport and an explicit destination are mutually exclusive in pino.
    transport:
      configuration.destination === undefined ? buildTransport(configuration.format) : undefined,
  };

  if (configuration.destination !== undefined) {
    return pino(options, configuration.destination);
  }

  try {
    return pino(options);
  } catch (error: unknown) {
    // `pino-pretty` is a development dependency and is absent from production
    // images. Readable logs are a convenience; running is not, so fall back to
    // JSON rather than refusing to start.
    if (configuration.format !== 'pretty') {
      throw error;
    }
    return pino({ ...options, transport: undefined });
  }
}
