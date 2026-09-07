import {
  type ApplicationConfiguration,
  toApplicationConfiguration,
} from './application-configuration';
import { ConfigurationError, type ConfigurationIssue } from './configuration-error';
import { environmentSchema, placeholderSecret } from './environment-schema';

/**
 * Checks that only make sense once every field has parsed. These are the
 * settings whose misconfiguration is silent rather than loud: a non-secure
 * cookie still works, and identical database roles still connect — they just
 * remove a security control without any visible symptom.
 */
function collectProductionIssues(configuration: ApplicationConfiguration): ConfigurationIssue[] {
  if (configuration.nodeEnvironment !== 'production') {
    return [];
  }

  const issues: ConfigurationIssue[] = [];

  if (!configuration.security.cookieSecure) {
    issues.push({
      variableName: 'SECURITY_COOKIE_SECURE',
      message: 'must be true in production, otherwise session cookies are sent over plain HTTP',
    });
  }

  if (configuration.database.applicationUrl === configuration.database.systemUrl) {
    issues.push({
      variableName: 'DATABASE_SYSTEM_URL',
      message:
        'must differ from DATABASE_APPLICATION_URL, otherwise row level security is not enforced',
    });
  }

  const secrets: readonly (readonly [string, string])[] = [
    ['SECURITY_API_KEY_PEPPER', configuration.security.apiKeyPepper],
    ['SECURITY_ENCRYPTION_KEY', configuration.security.encryptionKey],
    ['SECURITY_CURSOR_SIGNING_KEY', configuration.security.cursorSigningKey],
    ['LOG_RECIPIENT_SALT', configuration.observability.recipientSalt],
    ['WAHA_API_KEY', configuration.whatsAppProvider.apiKey],
  ];

  for (const [variableName, value] of secrets) {
    if (value !== placeholderSecret) {
      continue;
    }
    issues.push({
      variableName,
      message: 'still holds the example placeholder and must be replaced in production',
    });
  }

  return issues;
}

/**
 * Parses the process environment into a validated configuration object.
 *
 * Throws a {@link ConfigurationError} listing every problem at once. Reporting
 * one issue per run turns a misconfigured deployment into a guessing game.
 */
export function parseConfiguration(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): ApplicationConfiguration {
  const result = environmentSchema.safeParse(environment);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      variableName: issue.path.join('.') || '(unknown)',
      message: issue.message,
    }));
    throw new ConfigurationError(issues);
  }

  const configuration = toApplicationConfiguration(result.data);
  const productionIssues = collectProductionIssues(configuration);

  if (productionIssues.length > 0) {
    throw new ConfigurationError(productionIssues);
  }

  return configuration;
}
