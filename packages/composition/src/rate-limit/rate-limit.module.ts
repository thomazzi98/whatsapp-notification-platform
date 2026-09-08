import { Global, Module } from '@nestjs/common';

import { RateLimitService } from './rate-limit.service';

/**
 * Global because the limit applies at the edge, and the edge is every
 * controller: a module that had to be imported deliberately would eventually
 * be forgotten by the one route that needed it most.
 */
@Global()
@Module({
  providers: [RateLimitService],
  exports: [RateLimitService],
})
export class RateLimitModule {}
