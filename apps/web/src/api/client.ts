/**
 * A problem response, as the API returns it. Reading `detail` rather than
 * inventing a message in the browser keeps one explanation of a failure, on the
 * side that knows what happened.
 */
export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly correlationId?: string;
  readonly errors?: readonly { readonly path: string; readonly message: string }[];
}

export class ApiError extends Error {
  public readonly status: number;
  public readonly problem: ProblemDetails | undefined;

  public constructor(status: number, problem: ProblemDetails | undefined, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.problem = problem;
  }

  /** The API answers a stale or absent session with 401, and only with 401. */
  public get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  /**
   * What the API said about a specific field.
   *
   * A validation failure's `detail` says only that the body did not match the
   * schema, which is true and useless. The reason a person can act on is in
   * `errors`, and a form that ignores it sends them to the network tab.
   */
  public messageFor(field: string): string | undefined {
    return this.problem?.errors?.find((entry) => entry.path === field)?.message;
  }

  /** True when the failure is about the request rather than about the platform. */
  public get isValidationFailure(): boolean {
    return (this.problem?.errors?.length ?? 0) > 0;
  }
}

/** Reads field errors off anything a mutation may have thrown. */
export function fieldError(error: unknown, field: string): string | undefined {
  return error instanceof ApiError ? error.messageFor(field) : undefined;
}

/**
 * True when the failure is already explained on the fields it concerns, so the
 * form can leave out a summary that would only repeat "the request body did not
 * match the expected schema".
 */
export function isFieldLevel(error: unknown): boolean {
  return error instanceof ApiError && error.isValidationFailure;
}

const CSRF_HEADER = 'x-csrf-token';
const CSRF_STORAGE_KEY = 'wnp.csrfToken';

/**
 * The CSRF token is kept where a cross-site request cannot reach it.
 *
 * The session itself lives in a cookie the browser attaches automatically,
 * which is exactly what makes a forged request possible; requiring a header
 * that only same-origin script can read is what closes it. Session storage
 * rather than a variable so a reload does not sign the user out.
 */
export function rememberCsrfToken(token: string): void {
  sessionStorage.setItem(CSRF_STORAGE_KEY, token);
}

export function forgetCsrfToken(): void {
  sessionStorage.removeItem(CSRF_STORAGE_KEY);
}

export function readCsrfToken(): string | undefined {
  return sessionStorage.getItem(CSRF_STORAGE_KEY) ?? undefined;
}

interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

async function readProblem(response: Response): Promise<ProblemDetails | undefined> {
  try {
    return (await response.json()) as ProblemDetails;
  } catch {
    return undefined;
  }
}

/**
 * Every call the dashboard makes goes through here.
 *
 * Same origin, so no base URL and no CORS: the deployment decides where the API
 * is, not the build. Credentials are sent because the session is a cookie, and
 * the CSRF header is attached to everything that changes state.
 */
export async function request<Result>(path: string, options: RequestOptions = {}): Promise<Result> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};
  const csrfToken = readCsrfToken();

  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (method !== 'GET' && csrfToken !== undefined) {
    headers[CSRF_HEADER] = csrfToken;
  }

  const response = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
    ...(options.signal !== undefined && { signal: options.signal }),
  });

  if (!response.ok) {
    const problem = await readProblem(response);
    const detail =
      typeof problem?.detail === 'string'
        ? problem.detail
        : `The request to ${path} failed with status ${String(response.status)}.`;

    throw new ApiError(response.status, problem, detail);
  }

  if (response.status === 204) {
    return undefined as Result;
  }
  return (await response.json()) as Result;
}

/** Builds a query string, leaving out anything the caller did not set. */
export function toQueryString(
  parameters: Readonly<Record<string, string | number | readonly string[] | undefined>>,
): string {
  const search = new URLSearchParams();

  for (const [name, value] of Object.entries(parameters)) {
    if (value === undefined || value === '') {
      continue;
    }
    // A repeated parameter, which is how the API expects several statuses.
    if (typeof value === 'object') {
      for (const entry of value) {
        search.append(name, entry);
      }
      continue;
    }
    search.set(name, String(value));
  }

  const query = search.toString();
  return query.length > 0 ? `?${query}` : '';
}
