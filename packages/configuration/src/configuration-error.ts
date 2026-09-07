export interface ConfigurationIssue {
  readonly variableName: string;
  readonly message: string;
}

export class ConfigurationError extends Error {
  public readonly issues: readonly ConfigurationIssue[];

  public constructor(issues: readonly ConfigurationIssue[]) {
    const details = issues.map((issue) => `  ${issue.variableName}: ${issue.message}`).join('\n');
    super(`Invalid configuration:\n${details}`);
    this.name = 'ConfigurationError';
    this.issues = issues;
  }
}
