import { type FormEvent, type ReactNode, useState } from 'react';
import { Link } from 'react-router';

import { fieldError, isFieldLevel } from '../api/client';
import { useApplications, useCreateApplication, useLogout, useSession } from '../api/queries';
import { Alert, Button, EmptyState, Field, Loading, Panel, TextInput } from '../components/ui';

/** Suggests a slug without taking the field over: the person can still type. */
function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function ApplicationsPage(): ReactNode {
  const session = useSession();
  const applications = useApplications();
  const applicationCreation = useCreateApplication();
  const failure = applicationCreation.error;
  const logout = useLogout();
  const [isCreating, setIsCreating] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    applicationCreation.mutate(
      { name, slug: slug.length > 0 ? slug : toSlug(name) },
      {
        onSuccess: () => {
          setIsCreating(false);
          setName('');
          setSlug('');
        },
      },
    );
  };

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">Applications</h1>
          <p className="mt-0.5 text-sm text-ink-muted">
            {session.data?.user.organization.name ?? 'Your organization'} — an application is the
            boundary an API key can reach.
          </p>
        </div>
        <Button
          variant="ghost"
          onClick={() => {
            logout.mutate();
          }}
          isBusy={logout.isPending}
        >
          Sign out
        </Button>
      </header>

      <Panel
        title="Your applications"
        actions={
          <Button
            variant="primary"
            onClick={() => {
              setIsCreating(!isCreating);
            }}
          >
            {isCreating ? 'Cancel' : 'New application'}
          </Button>
        }
      >
        {isCreating && (
          <form className="flex flex-col gap-4 border-b border-border px-4 py-4" onSubmit={submit}>
            <Field label="Name" error={fieldError(failure, 'name')}>
              {(fieldProps) => (
                <TextInput
                  {...fieldProps}
                  value={name}
                  required
                  autoFocus
                  onChange={(event) => {
                    setName(event.target.value);
                  }}
                />
              )}
            </Field>
            <Field
              error={fieldError(failure, 'slug')}
              label="Slug"
              hint="Lower case letters, digits and hyphens. Used in URLs and cannot be changed later."
            >
              {(fieldProps) => (
                <TextInput
                  {...fieldProps}
                  value={slug.length > 0 ? slug : toSlug(name)}
                  required
                  onChange={(event) => {
                    setSlug(event.target.value);
                  }}
                />
              )}
            </Field>
            {applicationCreation.isError && !isFieldLevel(failure) && (
              <Alert title="Could not create it">{applicationCreation.error.message}</Alert>
            )}
            <div>
              <Button type="submit" variant="primary" isBusy={applicationCreation.isPending}>
                Create application
              </Button>
            </div>
          </form>
        )}

        {applications.isPending && <Loading label="Loading applications…" />}

        {applications.isError && (
          <div className="px-4 py-4">
            <Alert title="Could not load your applications">{applications.error.message}</Alert>
          </div>
        )}

        {applications.data?.length === 0 && (
          <EmptyState
            title="No applications yet"
            description="Create one to get an API key and connect a WhatsApp account."
          />
        )}

        {applications.data !== undefined && applications.data.length > 0 && (
          <ul className="divide-y divide-border">
            {applications.data.map((application) => (
              <li key={application.id}>
                <Link
                  to={`/applications/${application.id}`}
                  className="flex items-baseline justify-between gap-3 px-4 py-3 hover:bg-surface-sunken"
                >
                  <span className="text-sm font-medium text-ink">{application.name}</span>
                  <span className="font-mono text-xs text-ink-subtle">{application.slug}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </main>
  );
}
