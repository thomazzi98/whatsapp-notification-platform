import { type ApiKeyPrincipal, type AuthenticatedPrincipal } from '@platform/composition';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { type FastifyRequest } from 'fastify';

export interface RequestWithSession extends FastifyRequest {
  principal?: AuthenticatedPrincipal;
}

export interface RequestWithApiKey extends FastifyRequest {
  apiKeyPrincipal?: ApiKeyPrincipal;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedPrincipal => {
    const request = context.switchToHttp().getRequest<RequestWithSession>();

    if (request.principal === undefined) {
      throw new Error('CurrentUser was used on a route without the session guard.');
    }
    return request.principal;
  },
);

export const CurrentApiKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ApiKeyPrincipal => {
    const request = context.switchToHttp().getRequest<RequestWithApiKey>();

    if (request.apiKeyPrincipal === undefined) {
      throw new Error('CurrentApiKey was used on a route without the API key guard.');
    }
    return request.apiKeyPrincipal;
  },
);
