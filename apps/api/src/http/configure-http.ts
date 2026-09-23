import fastifyCookie from '@fastify/cookie';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { type Logger } from 'pino';

import { registerCorrelationHook } from './correlation/correlation.hook';
import { ProblemDetailsFilter } from './filters/problem-details.filter';
import { registerRawBodyParser } from './raw-body';

/**
 * Everything between the socket and the controllers, in one place.
 *
 * The bootstrap and the suites that stand in for a real client both call this,
 * so what a test sends is parsed, correlated and answered exactly as in
 * production. Assembled by hand in each suite, the stacks had drifted: the
 * public API's tests ran on Nest's default body parser while production ran on
 * this one, and a parser change could not have failed a /v1 test.
 *
 * The application must be created with `bodyParser: false`, because Fastify
 * allows one parser per content type and this one is the API's.
 */
export async function configureHttp(
  application: NestFastifyApplication,
  options: { readonly logger: Logger; readonly publicBaseUrl: string },
): Promise<void> {
  await application.register(fastifyCookie);
  const instance = application.getHttpAdapter().getInstance();
  registerRawBodyParser(instance);
  registerCorrelationHook(instance, options.logger);
  application.useGlobalFilters(new ProblemDetailsFilter(options.logger, options.publicBaseUrl));
}
