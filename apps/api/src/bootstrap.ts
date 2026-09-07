import { type ApplicationConfiguration } from '@platform/configuration';
import { createLogger } from '@platform/observability';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import { ApiModule } from './api.module';
import { registerCorrelationHook } from './http/correlation/correlation.hook';
import { ProblemDetailsFilter } from './http/filters/problem-details.filter';

export interface RunningApi {
  readonly application: NestFastifyApplication;
  readonly url: string;
}

export async function bootstrapApi(configuration: ApplicationConfiguration): Promise<RunningApi> {
  const logger = createLogger({
    serviceName: 'api',
    level: configuration.observability.logLevel,
    format: configuration.observability.logFormat,
    nodeEnvironment: configuration.nodeEnvironment,
  });

  const adapter = new FastifyAdapter({
    bodyLimit: configuration.http.bodyLimitBytes,
    // Fastify generates its own request ids; the correlation hook replaces them
    // with a value that also survives the queue hop into the worker.
    // eslint-disable-next-line unicorn/name-replacements -- Fastify option name.
    genReqId: () => randomCorrelationId(),
    trustProxy: true,
  });

  const application = await NestFactory.create<NestFastifyApplication>(
    ApiModule.forConfiguration(configuration),
    adapter,
    { bufferLogs: true, logger: false },
  );

  registerCorrelationHook(adapter.getInstance(), configuration.observability.recipientSalt);
  application.useGlobalFilters(new ProblemDetailsFilter(logger, configuration.http.publicBaseUrl));
  application.enableShutdownHooks();

  await application.listen(configuration.http.port, configuration.http.host);
  const url = await application.getUrl();

  logger.info({ event: 'api.started', port: configuration.http.port, url }, 'API is listening');

  return { application, url };
}

function randomCorrelationId(): string {
  return crypto.randomUUID();
}
