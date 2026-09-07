import { type ParsedTemplate } from './parse-template';

export interface TemplateVariableDeclaration {
  readonly name: string;
  readonly required: boolean;
  readonly defaultValue?: string;
  readonly description?: string;
}

export type TemplateVariableValue = string | number | boolean;

export const maximumRenderedBodyLength = 4096;
export const maximumVariableValueLength = 1024;

export const templateRenderErrorCodes = [
  'template_variable_missing',
  'template_variable_unknown',
  'template_variable_invalid_type',
  'template_variable_too_long',
  'rendered_body_too_long',
] as const;

export type TemplateRenderErrorCode = (typeof templateRenderErrorCodes)[number];

export interface TemplateRenderErrorDetails {
  readonly missingVariables?: readonly string[];
  readonly unknownVariables?: readonly string[];
  readonly invalidVariables?: readonly { readonly name: string; readonly receivedType: string }[];
  readonly tooLongVariables?: readonly string[];
  readonly renderedLength?: number;
}

export class TemplateRenderError extends Error {
  public readonly code: TemplateRenderErrorCode;
  public readonly details: TemplateRenderErrorDetails;

  public constructor(
    code: TemplateRenderErrorCode,
    message: string,
    details: TemplateRenderErrorDetails,
  ) {
    super(message);
    this.name = 'TemplateRenderError';
    this.code = code;
    this.details = details;
  }
}

export interface RenderResult {
  readonly renderedBody: string;
  readonly characterCount: number;
  readonly variablesUsed: readonly string[];
  readonly optionalVariablesDefaulted: readonly string[];
}

function describeType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

function isSupportedValue(value: unknown): value is TemplateVariableValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function assertNoUnknownVariables(
  declarations: readonly TemplateVariableDeclaration[],
  values: Readonly<Record<string, unknown>>,
): void {
  const declaredNames = new Set(declarations.map((declaration) => declaration.name));
  const unknownVariables = Object.keys(values).filter((name) => !declaredNames.has(name));

  if (unknownVariables.length === 0) {
    return;
  }

  // Rejecting extra variables is deliberate. Ignoring them silently hides the
  // most common real mistake — a typo in a variable name — where the caller
  // believes a value was substituted and a half-empty message reaches a person.
  throw new TemplateRenderError(
    'template_variable_unknown',
    `The template does not declare: ${unknownVariables.join(', ')}.`,
    { unknownVariables },
  );
}

function assertValueTypes(values: Readonly<Record<string, unknown>>): void {
  const invalidVariables = Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null && !isSupportedValue(value))
    .map(([name, value]) => ({ name, receivedType: describeType(value) }));

  if (invalidVariables.length === 0) {
    return;
  }

  throw new TemplateRenderError(
    'template_variable_invalid_type',
    'Template variables must be a string, number or boolean.',
    { invalidVariables },
  );
}

function assertValueLengths(resolved: ReadonlyMap<string, string>): void {
  const tooLongVariables = [...resolved]
    .filter(([, value]) => value.length > maximumVariableValueLength)
    .map(([name]) => name);

  if (tooLongVariables.length === 0) {
    return;
  }

  throw new TemplateRenderError(
    'template_variable_too_long',
    `Template variable values may be at most ${String(maximumVariableValueLength)} characters.`,
    { tooLongVariables },
  );
}

interface ResolutionResult {
  readonly resolved: Map<string, string>;
  readonly defaulted: string[];
}

function resolveVariables(
  declarations: readonly TemplateVariableDeclaration[],
  values: Readonly<Record<string, unknown>>,
): ResolutionResult {
  const resolved = new Map<string, string>();
  const defaulted: string[] = [];
  const missingVariables: string[] = [];

  for (const declaration of declarations) {
    const supplied = values[declaration.name];

    if (isSupportedValue(supplied)) {
      resolved.set(declaration.name, String(supplied));
      continue;
    }
    if (declaration.required) {
      missingVariables.push(declaration.name);
      continue;
    }
    if (declaration.defaultValue !== undefined) {
      resolved.set(declaration.name, declaration.defaultValue);
      defaulted.push(declaration.name);
      continue;
    }
    resolved.set(declaration.name, '');
    defaulted.push(declaration.name);
  }

  if (missingVariables.length > 0) {
    // A message containing a literal "{{customerName}}" must never be sent.
    throw new TemplateRenderError(
      'template_variable_missing',
      `Missing required template variables: ${missingVariables.join(', ')}.`,
      { missingVariables },
    );
  }

  return { resolved, defaulted };
}

/**
 * Substitution is single pass by construction: the output is assembled by
 * concatenating parsed nodes, and a substituted value is never re-scanned for
 * placeholders. A value containing "{{secret}}" therefore renders literally,
 * which closes template injection without needing an escaping layer.
 */
export function renderTemplate(
  parsed: ParsedTemplate,
  declarations: readonly TemplateVariableDeclaration[],
  values: Readonly<Record<string, unknown>> = {},
): RenderResult {
  assertNoUnknownVariables(declarations, values);
  assertValueTypes(values);

  const { resolved, defaulted } = resolveVariables(declarations, values);
  assertValueLengths(resolved);

  const renderedBody = parsed.nodes
    .map((node) => {
      if (node.kind === 'text') {
        return node.value;
      }
      return resolved.get(node.name) ?? '';
    })
    .join('');

  if (renderedBody.length > maximumRenderedBodyLength) {
    throw new TemplateRenderError(
      'rendered_body_too_long',
      `The rendered message is ${String(renderedBody.length)} characters, above the ${String(maximumRenderedBodyLength)} character limit.`,
      { renderedLength: renderedBody.length },
    );
  }

  return {
    renderedBody,
    characterCount: renderedBody.length,
    variablesUsed: parsed.variableNames,
    optionalVariablesDefaulted: defaulted.filter((name) => parsed.variableNames.includes(name)),
  };
}
