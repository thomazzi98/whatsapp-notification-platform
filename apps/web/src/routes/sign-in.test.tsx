import userEvent from '@testing-library/user-event';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { apiMock } from '../../testing/api-mock';
import { expectNoAccessibilityViolations, renderScreen } from '../../testing/render';
import { SignInPage } from './sign-in';

async function switchToCreateAccount(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: 'Create one' }));
}

describe('signing in', () => {
  it('says what is wrong on the field it is wrong about', async () => {
    apiMock.use(
      http.post('*/dashboard/auth/register', () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Validation failed',
            status: 400,
            detail: 'The request body did not match the expected schema.',
            errors: [{ path: 'password', message: 'The password must be at least 12 characters.' }],
          },
          { status: 400 },
        ),
      ),
    );

    renderScreen(<SignInPage />);
    await switchToCreateAccount();
    await userEvent.type(screen.getByLabelText('Organization'), 'Acme');
    await userEvent.type(screen.getByLabelText('Your name'), 'Dana');
    await userEvent.type(screen.getByLabelText('Email'), 'dana@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'a-long-password');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));

    // The reported bug: the API said exactly what was wrong and the form said
    // nothing, so the only way to find out was the network tab.
    expect(
      await screen.findByText('The password must be at least 12 characters.'),
    ).toBeInTheDocument();
  });

  it('does not also repeat the failure as a summary', async () => {
    apiMock.use(
      http.post('*/dashboard/auth/login', () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Validation failed',
            status: 400,
            detail: 'The request body did not match the expected schema.',
            errors: [{ path: 'email', message: 'That is not an email address.' }],
          },
          { status: 400 },
        ),
      ),
    );

    renderScreen(<SignInPage />);
    await userEvent.type(screen.getByLabelText('Email'), 'dana@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'whatever-it-is');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('That is not an email address.')).toBeInTheDocument();
    // "The request body did not match the expected schema" is true and useless.
    expect(screen.queryByText('That did not work')).not.toBeInTheDocument();
  });

  it('shows a summary when the failure belongs to no field', async () => {
    apiMock.use(
      http.post('*/dashboard/auth/login', () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Unauthorized',
            status: 401,
            detail: 'The email address or password is incorrect.',
          },
          { status: 401 },
        ),
      ),
    );

    renderScreen(<SignInPage />);
    await userEvent.type(screen.getByLabelText('Email'), 'dana@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'the-wrong-one');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('That did not work')).toBeInTheDocument();
    expect(screen.getByText('The email address or password is incorrect.')).toBeInTheDocument();
  });

  it('refuses a short password before a round trip is needed', async () => {
    renderScreen(<SignInPage />);
    await switchToCreateAccount();

    // The browser's own guard, so the shortest password never costs a request.
    expect(screen.getByLabelText('Password')).toHaveAttribute('minlength', '12');
  });

  it('asks for no minimum when signing in, because the rule is not the point there', () => {
    renderScreen(<SignInPage />);

    expect(screen.getByLabelText('Password')).not.toHaveAttribute('minlength');
  });

  it('has no accessibility violations', async () => {
    const { container } = renderScreen(<SignInPage />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    });
    await expectNoAccessibilityViolations(container);
  });
});
