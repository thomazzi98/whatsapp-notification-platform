import { type FormEvent, type ReactNode, useState } from 'react';

import { useLogin, useRegister } from '../api/queries';
import { Alert, Button, Field, Panel, TextInput } from '../components/ui';

type Mode = 'sign-in' | 'create-account';

export function SignInPage(): ReactNode {
  const [mode, setMode] = useState<Mode>('sign-in');
  const login = useLogin();
  const register = useRegister();
  const activeMutation = mode === 'sign-in' ? login : register;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    // FormData values can be files; these fields never are, so a text reader
    // keeps the type honest without a cast that would also accept one.
    const readField = (name: string): string => {
      const value = form.get(name);
      return typeof value === 'string' ? value : '';
    };
    const email = readField('email');
    const password = readField('password');

    if (mode === 'sign-in') {
      login.mutate({ email, password });
      return;
    }
    register.mutate({
      organizationName: readField('organizationName'),
      name: readField('name'),
      email,
      password,
    });
  };

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-4 py-12">
      <div>
        <h1 className="text-lg font-semibold text-ink">WhatsApp Notification Platform</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Send WhatsApp notifications and follow what happened to every one of them.
        </p>
      </div>

      <Panel title={mode === 'sign-in' ? 'Sign in' : 'Create an account'}>
        <form className="flex flex-col gap-4 px-4 py-4" onSubmit={submit}>
          {mode === 'create-account' && (
            <>
              <Field label="Organization">
                {(fieldProps) => (
                  <TextInput
                    {...fieldProps}
                    name="organizationName"
                    required
                    autoComplete="organization"
                  />
                )}
              </Field>
              <Field label="Your name">
                {(fieldProps) => (
                  <TextInput {...fieldProps} name="name" required autoComplete="name" />
                )}
              </Field>
            </>
          )}

          <Field label="Email">
            {(fieldProps) => (
              <TextInput
                {...fieldProps}
                name="email"
                type="email"
                required
                autoComplete="email"
                autoFocus
              />
            )}
          </Field>

          <Field
            label="Password"
            hint={mode === 'create-account' ? 'At least 12 characters.' : undefined}
          >
            {(fieldProps) => (
              <TextInput
                {...fieldProps}
                name="password"
                type="password"
                required
                autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
              />
            )}
          </Field>

          {activeMutation.isError && (
            <Alert title="That did not work">{activeMutation.error.message}</Alert>
          )}

          <Button type="submit" variant="primary" isBusy={activeMutation.isPending}>
            {mode === 'sign-in' ? 'Sign in' : 'Create account'}
          </Button>
        </form>
      </Panel>

      <p className="text-center text-sm text-ink-muted">
        {mode === 'sign-in' ? 'No account yet?' : 'Already have an account?'}{' '}
        <button
          type="button"
          className="font-medium text-accent underline underline-offset-2"
          onClick={() => {
            setMode(mode === 'sign-in' ? 'create-account' : 'sign-in');
          }}
        >
          {mode === 'sign-in' ? 'Create one' : 'Sign in'}
        </button>
      </p>
    </main>
  );
}
