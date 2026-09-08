import 'reflect-metadata';

import { ConfigurationError, parseConfiguration } from '@platform/configuration';

import { bootstrapWorker } from './bootstrap';

/**
 * Configuration is validated before Nest is constructed, so a missing variable
 * is reported as a list of problems rather than buried in a provider stack
 * trace half way through dependency resolution.
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

async function run(): Promise<void> {
  try {
    await bootstrapWorker(loadConfigurationOrExit());
  } catch (error: unknown) {
    process.stderr.write(`The worker failed to start: ${String(error)}\n`);
    process.exit(1);
  }
}

void run();
