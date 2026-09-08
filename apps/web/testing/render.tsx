import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import axe from 'axe-core';
import { type ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { expect } from 'vitest';

/**
 * A client per test. Sharing one would let a cached response from an earlier
 * test satisfy a later one, which is how a test suite ends up passing for a
 * reason nobody can name.
 */
function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

export interface RenderOptions {
  /** The address the memory router starts at. */
  readonly path?: string;
  /** The route pattern, when the component reads parameters from the path. */
  readonly pattern?: string;
}

export function renderScreen(element: ReactNode, options: RenderOptions = {}): RenderResult {
  const path = options.path ?? '/';
  const pattern = options.pattern ?? path;

  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={pattern} element={element} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * Asserts the rendered markup has no accessibility violations axe can see.
 *
 * Used directly rather than through a matcher package: those lag the test
 * runner by a major version, and the assertion is this short.
 *
 * Two rules are off, both because the question they ask cannot be answered
 * here rather than because the answer is inconvenient. `region` asks whether
 * the page is inside a landmark, and a test renders one component rather than a
 * page. `color-contrast` needs layout and a canvas, neither of which jsdom has;
 * contrast is checked in the browser, by the end-to-end suite's route scans.
 */
export async function expectNoAccessibilityViolations(container: HTMLElement): Promise<void> {
  const results = await axe.run(container, {
    rules: { region: { enabled: false }, 'color-contrast': { enabled: false } },
  });

  expect(results.violations.map((violation) => `${violation.id}: ${violation.help}`)).toStrictEqual(
    [],
  );
}
