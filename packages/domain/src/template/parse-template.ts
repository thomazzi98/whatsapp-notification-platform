export type TemplateNode =
  | { readonly kind: 'text'; readonly value: string }
  | {
      readonly kind: 'variable';
      readonly name: string;
      readonly start: number;
      readonly end: number;
    };

export interface ParsedTemplate {
  readonly nodes: readonly TemplateNode[];
  /** De-duplicated, in the order the variables first appear. */
  readonly variableNames: readonly string[];
}

export const templateSyntaxErrorCodes = [
  'unclosed_placeholder',
  'empty_placeholder',
  'invalid_variable_name',
] as const;

export type TemplateSyntaxErrorCode = (typeof templateSyntaxErrorCodes)[number];

export class TemplateSyntaxError extends Error {
  public readonly code: TemplateSyntaxErrorCode;
  /** Character offset in the template body, so an editor can point at it. */
  public readonly offset: number;

  public constructor(code: TemplateSyntaxErrorCode, offset: number, message: string) {
    super(message);
    this.name = 'TemplateSyntaxError';
    this.code = code;
    this.offset = offset;
  }
}

export const templateVariableNamePattern = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

const PLACEHOLDER_OPEN = '{{';
const PLACEHOLDER_CLOSE = '}}';
const ESCAPED_OPEN = String.raw`\{{`;

/**
 * A deliberately small language: named placeholders substituted into plain
 * text, with no helpers, conditionals, loops or property paths.
 *
 * The restriction is what makes the rest of the feature possible. Because the
 * variable set of a template can be determined statically, the editor can
 * validate it, the dashboard can generate typed inputs, and a preview can be
 * shown before the template is ever saved — none of which is possible with a
 * general-purpose templating engine.
 */
export function parseTemplate(body: string): ParsedTemplate {
  const nodes: TemplateNode[] = [];
  const variableNames: string[] = [];
  let textBuffer = '';
  let index = 0;

  function flushText(): void {
    if (textBuffer.length === 0) {
      return;
    }
    nodes.push({ kind: 'text', value: textBuffer });
    textBuffer = '';
  }

  while (index < body.length) {
    if (body.startsWith(ESCAPED_OPEN, index)) {
      textBuffer += PLACEHOLDER_OPEN;
      index += ESCAPED_OPEN.length;
      continue;
    }

    if (!body.startsWith(PLACEHOLDER_OPEN, index)) {
      textBuffer += body.charAt(index);
      index += 1;
      continue;
    }

    const closeIndex = body.indexOf(PLACEHOLDER_CLOSE, index + PLACEHOLDER_OPEN.length);
    if (closeIndex === -1) {
      throw new TemplateSyntaxError(
        'unclosed_placeholder',
        index,
        `A placeholder opened at position ${String(index)} is never closed with "}}".`,
      );
    }

    const rawName = body.slice(index + PLACEHOLDER_OPEN.length, closeIndex).trim();
    if (rawName.length === 0) {
      throw new TemplateSyntaxError(
        'empty_placeholder',
        index,
        `The placeholder at position ${String(index)} does not name a variable.`,
      );
    }
    if (!templateVariableNamePattern.test(rawName)) {
      throw new TemplateSyntaxError(
        'invalid_variable_name',
        index,
        `"${rawName}" is not a valid variable name. Use letters, digits and underscores, starting with a letter.`,
      );
    }

    flushText();
    nodes.push({
      kind: 'variable',
      name: rawName,
      start: index,
      end: closeIndex + PLACEHOLDER_CLOSE.length,
    });
    if (!variableNames.includes(rawName)) {
      variableNames.push(rawName);
    }
    index = closeIndex + PLACEHOLDER_CLOSE.length;
  }

  flushText();

  return { nodes, variableNames };
}
