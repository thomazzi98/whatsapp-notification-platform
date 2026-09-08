import { setupServer } from 'msw/node';

/**
 * The dashboard talks to its own origin, so handlers are registered per test
 * rather than defined here: every test states exactly which endpoints its
 * component is entitled to call, and anything else fails loudly.
 */
export const apiMock = setupServer();
