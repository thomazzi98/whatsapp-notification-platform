import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Button } from './ui';

describe('a button that is doing something', () => {
  it('cannot be pressed again while it is busy', () => {
    render(<Button isBusy>Create key</Button>);

    expect(screen.getByRole('button', { name: 'Create key' })).toBeDisabled();
  });

  it('stays disabled while busy even when the caller also passes disabled', () => {
    // Every submit button with a validity condition passes both. The spread
    // used to come last, so `disabled={false}` overwrote the busy guard and
    // the button accepted a second click while the first request was in
    // flight — the exact double-submit the guard exists to prevent.
    render(
      <Button isBusy disabled={false}>
        Create key
      </Button>,
    );

    expect(screen.getByRole('button', { name: 'Create key' })).toBeDisabled();
  });

  it('is disabled when the caller says so and nothing is in flight', () => {
    render(<Button disabled>Create key</Button>);

    expect(screen.getByRole('button', { name: 'Create key' })).toBeDisabled();
  });

  it('says it is busy, for anyone not looking at the cursor', () => {
    render(<Button isBusy>Create key</Button>);

    expect(screen.getByRole('button', { name: 'Create key' })).toHaveAttribute('aria-busy', 'true');
  });
});
