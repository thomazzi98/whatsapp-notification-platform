import 'reflect-metadata';

import { parseConfiguration } from '@platform/configuration';
import { ConfigurationError } from '@platform/configuration';

import { bootstrapApi } from './bootstrap';

/**
 * Configuration is validated before Nest is constructed.
 *
 * Validating inside a Nest module would fail partway through dependency
 * resolution and bury the real message under a provider stack trace. Failing
 * here reports every problem at once, before a single provider exists.
 */
function loadConfigurationOrExit(): ReturnType<typeof parseConfiguration> {
  try {
    return parseConfiguration(process.env);
  } catch (error: unknown) {
    if (error instanceof ConfigurationError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const configuration = loadConfigurationOrExit();
  await bootstrapApi(configuration);
}

async function run(): Promise<void> {
  try {
    await main();
  } catch (error: unknown) {
    process.stderr.write(`The API failed to start: ${String(error)}\n`);
    process.exit(1);
  }
}

void run();
