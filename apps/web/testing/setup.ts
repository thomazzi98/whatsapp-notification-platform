import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';

import { apiMock } from './api-mock';

beforeAll(() => {
  // Unhandled requests fail rather than fall through: a component reaching for
  // an endpoint the test did not describe is a fact worth knowing, not a
  // silent network error the component then renders as an ordinary failure.
  apiMock.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  cleanup();
  apiMock.resetHandlers();
});

afterAll(() => {
  apiMock.close();
});
