import { BadRequestException, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';

const identifierSchema = z.uuid();

/**
 * Refuses a path parameter that cannot be an identifier.
 *
 * Without this the value reaches a `where id = $1` against a uuid column and
 * Postgres raises 22P02, which is neither a domain error nor an HTTP one — so
 * the request became a 500 and was logged at error level. A client typo is not
 * an internal failure, and it should not look like one on a dashboard.
 *
 * The answer is 400 rather than 404 because the request is malformed rather
 * than pointing at something absent, and because saying so is the difference
 * between a developer finding their mistake in seconds and hunting for a
 * notification that never existed.
 */
export class UuidParameterPipe implements PipeTransform<unknown, string> {
  private readonly parameterName: string;

  public constructor(parameterName: string) {
    this.parameterName = parameterName;
  }

  public transform(value: unknown): string {
    const result = identifierSchema.safeParse(value);

    if (result.success) {
      return result.data;
    }

    throw new BadRequestException({
      error: 'Validation failed',
      message: `The ${this.parameterName} in the path is not a valid identifier.`,
      errors: [
        {
          path: this.parameterName,
          code: 'invalid_format',
          message: 'Expected a UUID.',
        },
      ],
    });
  }
}
