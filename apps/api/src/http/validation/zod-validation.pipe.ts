import { BadRequestException, type PipeTransform } from '@nestjs/common';
import { type ZodType } from 'zod';

interface FieldError {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

/**
 * Validates a request against the same schema the OpenAPI document is generated
 * from, so the documented contract and the enforced contract cannot drift.
 *
 * Every failure is reported at once, keyed by field path, rather than stopping
 * at the first problem.
 */
export class ZodValidationPipe<Output> implements PipeTransform<unknown, Output> {
  private readonly schema: ZodType<Output>;

  public constructor(schema: ZodType<Output>) {
    this.schema = schema;
  }

  public transform(value: unknown): Output {
    const result = this.schema.safeParse(value);

    if (result.success) {
      return result.data;
    }

    const errors: FieldError[] = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      code: issue.code,
      message: issue.message,
    }));

    throw new BadRequestException({
      error: 'Validation failed',
      message: 'The request body did not match the expected schema.',
      errors,
    });
  }
}
