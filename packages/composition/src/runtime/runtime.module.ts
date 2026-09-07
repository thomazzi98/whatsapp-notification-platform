import {
  CLOCK_PORT,
  type ClockPort,
  IDENTIFIER_GENERATOR_PORT,
  RANDOM_PORT,
} from '@platform/domain';
import {
  createIdentifierGenerator,
  createSystemClock,
  createSystemRandom,
} from '@platform/security';
import { Global, Module } from '@nestjs/common';

/**
 * Binds the domain's ambient ports to real implementations. Tests replace this
 * module to make time, randomness and identifiers deterministic.
 */
@Global()
@Module({
  providers: [
    { provide: CLOCK_PORT, useFactory: createSystemClock },
    { provide: RANDOM_PORT, useFactory: createSystemRandom },
    {
      provide: IDENTIFIER_GENERATOR_PORT,
      inject: [CLOCK_PORT],
      useFactory: (clock: ClockPort) => createIdentifierGenerator(clock),
    },
  ],
  exports: [CLOCK_PORT, RANDOM_PORT, IDENTIFIER_GENERATOR_PORT],
})
export class RuntimeModule {}
