import { APPLICATION_CONFIGURATION } from '@platform/composition';
import { type ApplicationConfiguration } from '@platform/configuration';
import { buildOpenApiDocument } from '@platform/contracts';
import { Controller, Get, Header, Inject } from '@nestjs/common';

/**
 * Unauthenticated, because a description of the API is not a secret and an
 * integrator needs it before they have a key.
 *
 * The document is built from the same Zod schemas that validate requests, so it
 * cannot drift into describing a field the API does not accept. A test asserts
 * the reverse too: that no route exists without being described here.
 */
@Controller('v1')
export class OpenApiController {
  private readonly document: Record<string, unknown>;

  public constructor(@Inject(APPLICATION_CONFIGURATION) configuration: ApplicationConfiguration) {
    // Built once: it is derived from schemas that cannot change at runtime.
    this.document = buildOpenApiDocument({
      publicBaseUrl: configuration.http.publicBaseUrl,
    });
  }

  @Get('openapi.json')
  @Header('cache-control', 'public, max-age=300')
  public read(): Record<string, unknown> {
    return this.document;
  }
}
