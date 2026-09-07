import { type Logger } from 'pino';

export type SpanAttributes = Readonly<Record<string, string | number | boolean | undefined>>;

export interface SpanOptions {
  readonly logger: Logger;
  readonly event: string;
  readonly attributes?: SpanAttributes;
}

/**
 * The single place timing is recorded.
 *
 * Today it emits a duration on a structured log line. Distributed tracing is
 * deliberately out of scope while the system has three hops that are already
 * stitched together by `correlationId` — but when that changes, this function
 * becomes `tracer.startActiveSpan` and no call site has to be touched.
 */
export async function withSpan<Result>(
  options: SpanOptions,
  operation: () => Promise<Result>,
): Promise<Result> {
  const startedAt = process.hrtime.bigint();

  try {
    const result = await operation();
    options.logger.info(
      {
        event: options.event,
        outcome: 'succeeded',
        durationMilliseconds: elapsedMilliseconds(startedAt),
        ...options.attributes,
      },
      options.event,
    );
    return result;
  } catch (error: unknown) {
    options.logger.warn(
      {
        event: options.event,
        outcome: 'failed',
        durationMilliseconds: elapsedMilliseconds(startedAt),
        error,
        ...options.attributes,
      },
      options.event,
    );
    throw error;
  }
}

function elapsedMilliseconds(startedAt: bigint): number {
  const elapsedNanoseconds = process.hrtime.bigint() - startedAt;
  return Number(elapsedNanoseconds) / 1_000_000;
}
