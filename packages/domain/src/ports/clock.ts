/**
 * Time is injected rather than read from the global clock, so scheduling and
 * expiry logic can be tested without fake timers.
 */
export interface ClockPort {
  now: () => Date;
}

export const CLOCK_PORT = Symbol('ClockPort');
