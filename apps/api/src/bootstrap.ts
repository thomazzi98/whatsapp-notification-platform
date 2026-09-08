import { type ApplicationConfiguration } from '@platform/configuration';
import { createLogger } from '@platform/observability';
import fastifyCookie from '@fastify/cookie';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import { ApiModule } from './api.module';
import { registerCorrelationHook } from './http/correlation/correlation.hook';
import { registerRawBodyParser } from './http/raw-body';
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
    // Trust exactly one hop -- the process that opened the socket, which in
    // this stack is always Caddy -- rather than trusting the whole
    // X-Forwarded-For chain. Caddy already replaces a client-supplied header
    // with the address it observed, so both settings behave the same here; this
    // one states the assumption the API is entitled to make rather than
    // inheriting a guarantee from whatever happens to sit in front of it.
    trustProxy: (_address: string, hop: number) => hop === 0,
  });

  const application = await NestFactory.create<NestFastifyApplication>(
    ApiModule.forConfiguration(configuration),
    adapter,
    {
      bufferLogs: true,
      logger: false,
      // The API registers its own JSON parser, because the webhook routes need
      // the exact bytes that arrived and Fastify allows only one parser per
      // content type. Letting the framework add its own would make that a
      // startup error rather than a choice.
      bodyParser: false,
    },
  );

  await application.register(fastifyCookie);
  registerRawBodyParser(adapter.getInstance());
  registerCorrelationHook(adapter.getInstance(), logger);
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
