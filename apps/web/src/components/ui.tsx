import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useId,
} from 'react';

export type Tone = 'neutral' | 'positive' | 'caution' | 'negative' | 'accent';

const toneClasses: Record<Tone, string> = {
  neutral: 'bg-surface-sunken text-ink-muted border-border',
  positive: 'bg-positive-subtle text-positive border-positive/25',
  caution: 'bg-caution-subtle text-caution border-caution/25',
  negative: 'bg-negative-subtle text-negative border-negative/25',
  accent: 'bg-accent-subtle text-accent border-accent/25',
};

/**
 * A label is never carried by colour alone: every badge shows its text, and
 * callers pair it with an icon. Colour is the third signal, not the first.
 */
export function Badge({
  tone = 'neutral',
  icon,
  children,
}: {
  tone?: Tone;
  icon?: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-control border px-2 py-0.5 text-xs font-medium ${toneClasses[tone]}`}
    >
      {icon}
      {children}
    </span>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const buttonClasses: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-hover border-transparent',
  secondary: 'bg-surface-raised text-ink hover:bg-surface-sunken border-border-strong',
  ghost: 'bg-transparent text-ink-muted hover:bg-surface-sunken hover:text-ink border-transparent',
  danger: 'bg-surface-raised text-negative hover:bg-negative-subtle border-negative/30',
};

export function Button({
  variant = 'secondary',
  isBusy = false,
  children,
  className = '',
  ...attributes
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  isBusy?: boolean;
}): ReactNode {
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-2 rounded-control border px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${buttonClasses[variant]} ${className}`}
      {...attributes}
      // After the spread, not before it. A caller passing both isBusy and an
      // explicit disabled — which is every submit button with a validity
      // condition — used to have the busy guard overwritten by its own
      // `disabled={false}`, so the button stayed clickable while the request
      // it had already started was in flight.
      disabled={isBusy || attributes.disabled}
      aria-busy={isBusy}
    >
      {children}
    </button>
  );
}

export function Panel({
  title,
  description,
  actions,
  children,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <section className="rounded-panel border border-border bg-surface-raised">
      {title !== undefined && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">{title}</h2>
            {description !== undefined && (
              <p className="mt-0.5 text-sm text-ink-muted">{description}</p>
            )}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: (fieldProps: { id: string; 'aria-describedby': string | undefined }) => ReactNode;
}): ReactNode {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [
    hint === undefined ? undefined : hintId,
    error === undefined ? undefined : errorId,
  ]
    .filter((value) => value !== undefined)
    .join(' ');

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      {children({ id, 'aria-describedby': describedBy.length > 0 ? describedBy : undefined })}
      {hint !== undefined && (
        <p id={hintId} className="text-xs text-ink-subtle">
          {hint}
        </p>
      )}
      {error !== undefined && (
        <p id={errorId} className="text-xs text-negative">
          {error}
        </p>
      )}
    </div>
  );
}

const controlClasses =
  'w-full rounded-control border border-border-strong bg-surface-raised px-3 py-1.5 text-sm text-ink placeholder:text-ink-subtle disabled:opacity-60';

export function TextInput(attributes: InputHTMLAttributes<HTMLInputElement>): ReactNode {
  return <input className={controlClasses} {...attributes} />;
}

export function TextArea(attributes: TextareaHTMLAttributes<HTMLTextAreaElement>): ReactNode {
  return <textarea className={`${controlClasses} min-h-24 resize-y`} {...attributes} />;
}

export function Select(attributes: SelectHTMLAttributes<HTMLSelectElement>): ReactNode {
  return <select className={controlClasses} {...attributes} />;
}

/**
 * Failures are announced, not just drawn. A message that appears silently is
 * invisible to anyone using a screen reader, which is precisely the moment they
 * most need to know something went wrong.
 */
export function Alert({
  tone = 'negative',
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div
      role={tone === 'negative' ? 'alert' : 'status'}
      className={`rounded-panel border px-3 py-2 text-sm ${toneClasses[tone]}`}
    >
      {title !== undefined && <p className="font-semibold">{title}</p>}
      <div className={title === undefined ? '' : 'mt-0.5'}>{children}</div>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}): ReactNode {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="max-w-md text-sm text-ink-muted">{description}</p>
      {action !== undefined && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Loading({ label }: { label: string }): ReactNode {
  return (
    <p role="status" className="px-4 py-12 text-center text-sm text-ink-muted">
      {label}
    </p>
  );
}

/** A timestamp that reads as both absolute and relative, because both matter. */
export function Timestamp({ value }: { value: string | null }): ReactNode {
  if (value === null) {
    return <span className="text-ink-subtle">—</span>;
  }

  const parsed = new Date(value);

  return (
    <time dateTime={value} title={parsed.toISOString()} className="tabular-nums">
      {parsed.toLocaleString()}
    </time>
  );
}
