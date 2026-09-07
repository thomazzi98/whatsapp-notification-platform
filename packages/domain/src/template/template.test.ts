import { describe, expect, it } from 'vitest';

import { parseTemplate, TemplateSyntaxError } from './parse-template';
import {
  maximumRenderedBodyLength,
  maximumVariableValueLength,
  renderTemplate,
  TemplateRenderError,
  type TemplateVariableDeclaration,
} from './render-template';

function required(name: string): TemplateVariableDeclaration {
  return { name, required: true };
}

function optional(name: string, defaultValue?: string): TemplateVariableDeclaration {
  return defaultValue === undefined
    ? { name, required: false }
    : { name, required: false, defaultValue };
}

function renderError(operation: () => unknown): TemplateRenderError {
  try {
    operation();
  } catch (error: unknown) {
    if (error instanceof TemplateRenderError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the render to fail, but it succeeded.');
}

describe('parseTemplate', () => {
  it('extracts variables in the order they first appear', () => {
    const parsed = parseTemplate('Hello {{customerName}}, order {{orderId}} shipped.');

    expect(parsed.variableNames).toEqual(['customerName', 'orderId']);
  });

  it('de-duplicates a variable used more than once', () => {
    const parsed = parseTemplate('{{name}} and again {{name}}');

    expect(parsed.variableNames).toEqual(['name']);
    expect(parsed.nodes.filter((node) => node.kind === 'variable')).toHaveLength(2);
  });

  it('tolerates whitespace inside the braces', () => {
    expect(parseTemplate('Hi {{  customerName  }}').variableNames).toEqual(['customerName']);
  });

  it('treats a template with no variables as plain text', () => {
    const parsed = parseTemplate('Just a message.');

    expect(parsed.variableNames).toEqual([]);
    expect(parsed.nodes).toEqual([{ kind: 'text', value: 'Just a message.' }]);
  });

  it('handles an empty template', () => {
    expect(parseTemplate('').nodes).toEqual([]);
  });

  it('supports escaping so a literal brace pair can be written', () => {
    const parsed = parseTemplate(String.raw`Literal \{{notAVariable}} stays.`);

    expect(parsed.variableNames).toEqual([]);
    expect(renderTemplate(parsed, [], {}).renderedBody).toBe('Literal {{notAVariable}} stays.');
  });

  it('rejects an unclosed placeholder and reports where it opened', () => {
    let caught: TemplateSyntaxError | undefined;
    try {
      parseTemplate('Hello {{customerName');
    } catch (error: unknown) {
      caught = error as TemplateSyntaxError;
    }

    expect(caught?.code).toBe('unclosed_placeholder');
    expect(caught?.offset).toBe(6);
  });

  it('rejects an empty placeholder', () => {
    expect(() => parseTemplate('Hello {{}}')).toThrow(TemplateSyntaxError);
    expect(() => parseTemplate('Hello {{   }}')).toThrow(TemplateSyntaxError);
  });

  it('rejects variable names that are not plain identifiers', () => {
    for (const body of [
      'Hello {{customer.name}}',
      'Hello {{customer-name}}',
      'Hello {{1name}}',
      'Hello {{name!}}',
      'Hello {{#if condition}}',
    ]) {
      expect(() => parseTemplate(body), body).toThrow(TemplateSyntaxError);
    }
  });
});

describe('renderTemplate', () => {
  it('substitutes supplied values', () => {
    const parsed = parseTemplate('Hello {{customerName}}, order {{orderId}} shipped.');
    const result = renderTemplate(parsed, [required('customerName'), required('orderId')], {
      customerName: 'Rafael',
      orderId: 'ORD-123',
    });

    expect(result.renderedBody).toBe('Hello Rafael, order ORD-123 shipped.');
    expect(result.characterCount).toBe(result.renderedBody.length);
  });

  it('substitutes a repeated variable at every position', () => {
    const parsed = parseTemplate('{{name}}, {{name}}!');

    expect(renderTemplate(parsed, [required('name')], { name: 'Ana' }).renderedBody).toBe(
      'Ana, Ana!',
    );
  });

  it('converts numbers and booleans to their string form', () => {
    const parsed = parseTemplate('{{count}} items, express: {{express}}');
    const result = renderTemplate(parsed, [required('count'), required('express')], {
      count: 3,
      express: true,
    });

    expect(result.renderedBody).toBe('3 items, express: true');
  });

  it('refuses to send a message with an unresolved required variable', () => {
    const parsed = parseTemplate('Hello {{customerName}}');
    const error = renderError(() => renderTemplate(parsed, [required('customerName')], {}));

    expect(error.code).toBe('template_variable_missing');
    expect(error.details.missingVariables).toEqual(['customerName']);
  });

  it('reports every missing variable at once', () => {
    const parsed = parseTemplate('{{a}} {{b}} {{c}}');
    const error = renderError(() =>
      renderTemplate(parsed, [required('a'), required('b'), required('c')], { b: 'given' }),
    );

    expect(error.details.missingVariables).toEqual(['a', 'c']);
  });

  it('uses a default for an optional variable that was not supplied', () => {
    const parsed = parseTemplate('Hello {{greeting}} {{name}}');
    const result = renderTemplate(parsed, [optional('greeting', 'there'), required('name')], {
      name: 'Ana',
    });

    expect(result.renderedBody).toBe('Hello there Ana');
    expect(result.optionalVariablesDefaulted).toContain('greeting');
  });

  it('renders an optional variable with no default as empty', () => {
    const parsed = parseTemplate('Hello{{suffix}}');

    expect(renderTemplate(parsed, [optional('suffix')], {}).renderedBody).toBe('Hello');
  });

  it('rejects a value for a variable the template does not declare', () => {
    const parsed = parseTemplate('Hello {{name}}');
    const error = renderError(() =>
      renderTemplate(parsed, [required('name')], { name: 'Ana', custmerName: 'typo' }),
    );

    expect(error.code).toBe('template_variable_unknown');
    expect(error.details.unknownVariables).toEqual(['custmerName']);
  });

  it('rejects a value that is not a string, number or boolean', () => {
    const parsed = parseTemplate('Hello {{name}}');
    const error = renderError(() =>
      renderTemplate(parsed, [required('name')], { name: { first: 'Ana' } }),
    );

    expect(error.code).toBe('template_variable_invalid_type');
    expect(error.details.invalidVariables).toEqual([{ name: 'name', receivedType: 'object' }]);
  });

  it('rejects an oversized variable value', () => {
    const parsed = parseTemplate('{{note}}');
    const error = renderError(() =>
      renderTemplate(parsed, [required('note')], {
        note: 'x'.repeat(maximumVariableValueLength + 1),
      }),
    );

    expect(error.code).toBe('template_variable_too_long');
    expect(error.details.tooLongVariables).toEqual(['note']);
  });

  it('rejects a rendered message longer than the provider accepts', () => {
    const parsed = parseTemplate('{{a}}{{b}}{{c}}{{d}}{{e}}');
    const declarations = ['a', 'b', 'c', 'd', 'e'].map((name) => required(name));
    const chunk = 'x'.repeat(maximumVariableValueLength);
    const error = renderError(() =>
      renderTemplate(parsed, declarations, { a: chunk, b: chunk, c: chunk, d: chunk, e: chunk }),
    );

    expect(error.code).toBe('rendered_body_too_long');
    expect(error.details.renderedLength).toBeGreaterThan(maximumRenderedBodyLength);
  });

  it('does not re-scan substituted values, so a value cannot inject a placeholder', () => {
    const parsed = parseTemplate('Hello {{name}}');
    const result = renderTemplate(parsed, [required('name'), optional('secret', 'LEAKED')], {
      name: '{{secret}}',
    });

    expect(result.renderedBody).toBe('Hello {{secret}}');
    expect(result.renderedBody).not.toContain('LEAKED');
  });
});
