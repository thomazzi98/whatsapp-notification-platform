import { type ApplicationConfiguration } from '@platform/configuration';
import { createLogger, logEvents } from '@platform/observability';
import { type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { WorkerModule } from './worker.module';

/**
 * The worker has no HTTP surface.
 *
 * `createApplicationContext` builds the same dependency graph as the API
 * without a server, which is the point of the composition package: one wiring,
 * two processes, and no second construction of the delivery pipeline that could
 * drift from the first.
 */
export async function bootstrapWorker(
  configuration: ApplicationConfiguration,
): Promise<INestApplicationContext> {
  const logger = createLogger({
    serviceName: 'worker',
    level: configuration.observability.logLevel,
    format: configuration.observability.logFormat,
    nodeEnvironment: configuration.nodeEnvironment,
  });

  const context = await NestFactory.createApplicationContext(
    WorkerModule.forConfiguration(configuration),
    { bufferLogs: true, logger: false },
  );

  // A shutdown that hangs and one that drains cleanly look identical from
  // outside the process unless it says so on the way out.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      logger.info(
        { event: logEvents.workerShutdownStarted, signal },
        'Draining in-flight jobs before exit',
      );
    });
  }

  // Without this, SIGTERM kills the process with jobs still in flight instead
  // of letting the queue client drain them.
  context.enableShutdownHooks();

  logger.info({ event: logEvents.processStarted }, 'Worker is processing jobs');

  return context;
}
