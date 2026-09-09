import {
  type ApiKeyCreationRequest,
  type ApiKeyCreationResponse,
  type ApiKeyResponse,
  type ApplicationCreationRequest,
  type ApplicationResponse,
  type AuthenticatedUser,
  type LoginRequest,
  type NotificationCreationRequest,
  type NotificationEventResponse,
  type NotificationResponse,
  type QrCodeResponse,
  type RegisterRequest,
  type WhatsAppSessionResponse,
} from '@platform/contracts';
import { type NotificationStatus } from '@platform/domain';
import {
  useMutation,
  type UseMutationResult,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';

import { forgetCsrfToken, rememberCsrfToken, request, toQueryString } from './client';

/**
 * Query keys are hierarchical so that one invalidation covers every filtered
 * variant beneath it. Flat keys mean a send has to know which list filters are
 * currently mounted in order to refresh them, which it cannot.
 */
export const queryKeys = {
  session: ['session'] as const,
  applications: ['applications'] as const,
  application: (applicationId: string) => ['applications', applicationId] as const,
  apiKeys: (applicationId: string) => ['applications', applicationId, 'api-keys'] as const,
  connections: (applicationId: string) => ['applications', applicationId, 'connections'] as const,
  connection: (applicationId: string, connectionId: string) =>
    ['applications', applicationId, 'connections', connectionId] as const,
  qrCode: (applicationId: string, connectionId: string) =>
    ['applications', applicationId, 'connections', connectionId, 'qr-code'] as const,
  notifications: (applicationId: string) =>
    ['applications', applicationId, 'notifications'] as const,
  notificationList: (applicationId: string, filters: NotificationFilters) =>
    ['applications', applicationId, 'notifications', 'list', filters] as const,
  notification: (applicationId: string, notificationId: string) =>
    ['applications', applicationId, 'notifications', notificationId] as const,
  notificationEvents: (applicationId: string, notificationId: string) =>
    ['applications', applicationId, 'notifications', notificationId, 'events'] as const,
  readiness: ['readiness'] as const,
};

export interface NotificationFilters {
  readonly status?: NotificationStatus;
  readonly recipient?: string;
  readonly cursor?: string;
}

export interface SessionResponse {
  readonly user: AuthenticatedUser;
  readonly csrfToken: string;
}

const applicationPath = (applicationId: string): string =>
  `/dashboard/applications/${applicationId}`;

export function useSession(): UseQueryResult<SessionResponse | null> {
  return useQuery({
    queryKey: queryKeys.session,
    queryFn: async () => {
      try {
        const session = await request<SessionResponse>('/dashboard/auth/session');
        rememberCsrfToken(session.csrfToken);
        return session;
      } catch {
        // Not signed in is an answer, not an error: the router needs a
        // resolved value to decide where to send someone.
        forgetCsrfToken();
        return null;
      }
    },
    retry: false,
    staleTime: 60_000,
  });
}

export function useLogin(): UseMutationResult<SessionResponse, Error, LoginRequest> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (body: LoginRequest) => {
      const session = await request<SessionResponse>('/dashboard/auth/login', {
        method: 'POST',
        body,
      });
      rememberCsrfToken(session.csrfToken);
      return session;
    },
    onSuccess: (session) => {
      queryClient.setQueryData(queryKeys.session, session);
    },
  });
}

export function useRegister(): UseMutationResult<SessionResponse, Error, RegisterRequest> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (body: RegisterRequest) => {
      const session = await request<SessionResponse>('/dashboard/auth/register', {
        method: 'POST',
        body,
      });
      rememberCsrfToken(session.csrfToken);
      return session;
    },
    onSuccess: (session) => {
      queryClient.setQueryData(queryKeys.session, session);
    },
  });
}

export function useLogout(): UseMutationResult<void, Error, void> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      await request<void>('/dashboard/auth/logout', { method: 'POST' });
    },
    onSuccess: () => {
      forgetCsrfToken();
      // Set to null rather than cleared. Clearing leaves the session unknown
      // rather than decided, and the router cannot send someone to the sign-in
      // screen on the strength of "not loaded yet" — which left the dashboard
      // sitting on a page it could no longer read.
      queryClient.setQueryData(queryKeys.session, null);
      // Everything else was read under an identity that no longer applies.
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== queryKeys.session[0],
      });
    },
  });
}

export function useApplications(): UseQueryResult<ApplicationResponse[]> {
  return useQuery({
    queryKey: queryKeys.applications,
    queryFn: async () => {
      const result = await request<{ data: ApplicationResponse[] }>('/dashboard/applications');
      return result.data;
    },
  });
}

export function useApplication(applicationId: string): UseQueryResult<ApplicationResponse> {
  return useQuery({
    queryKey: queryKeys.application(applicationId),
    queryFn: async () => request<ApplicationResponse>(applicationPath(applicationId)),
  });
}

export function useCreateApplication(): UseMutationResult<
  ApplicationResponse,
  Error,
  ApplicationCreationRequest
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (body: ApplicationCreationRequest) =>
      request<ApplicationResponse>('/dashboard/applications', { method: 'POST', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.applications });
    },
  });
}

export function useApiKeys(applicationId: string): UseQueryResult<ApiKeyResponse[]> {
  return useQuery({
    queryKey: queryKeys.apiKeys(applicationId),
    queryFn: async () => {
      const result = await request<{ data: ApiKeyResponse[] }>(
        `${applicationPath(applicationId)}/api-keys`,
      );
      return result.data;
    },
  });
}

export function useCreateApiKey(
  applicationId: string,
): UseMutationResult<ApiKeyCreationResponse, Error, ApiKeyCreationRequest> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (body: ApiKeyCreationRequest) =>
      request<ApiKeyCreationResponse>(`${applicationPath(applicationId)}/api-keys`, {
        method: 'POST',
        body,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys(applicationId) });
    },
  });
}

export function useRevokeApiKey(applicationId: string): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (apiKeyId: string) => {
      await request<void>(`${applicationPath(applicationId)}/api-keys/${apiKeyId}`, {
        method: 'DELETE',
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys(applicationId) });
    },
  });
}

export function useConnections(applicationId: string): UseQueryResult<WhatsAppSessionResponse[]> {
  return useQuery({
    queryKey: queryKeys.connections(applicationId),
    queryFn: async () => {
      const result = await request<{ data: WhatsAppSessionResponse[] }>(
        `${applicationPath(applicationId)}/whatsapp-sessions`,
      );
      return result.data;
    },
  });
}

/**
 * Polls while a connection is mid-flight and stops once it settles.
 *
 * The interval is a function of the answer rather than a constant, because the
 * two states have opposite needs: somebody watching a QR code wants to know
 * within a second that it worked, and a connection that has been working for a
 * week does not deserve a request every two seconds forever.
 */
export function useConnection(
  applicationId: string,
  connectionId: string,
): UseQueryResult<WhatsAppSessionResponse> {
  return useQuery({
    queryKey: queryKeys.connection(applicationId, connectionId),
    queryFn: async () =>
      request<WhatsAppSessionResponse>(
        `${applicationPath(applicationId)}/whatsapp-sessions/${connectionId}`,
      ),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === 'SCAN_QR_CODE' || status === 'STARTING') {
        return 2000;
      }
      return status === 'WORKING' ? 30_000 : 10_000;
    },
    // A tab nobody is looking at is not waiting for a code.
    refetchIntervalInBackground: false,
  });
}

export function useCreateConnection(
  applicationId: string,
): UseMutationResult<WhatsAppSessionResponse, Error, { displayName: string }> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (body: { displayName: string }) =>
      request<WhatsAppSessionResponse>(`${applicationPath(applicationId)}/whatsapp-sessions`, {
        method: 'POST',
        body,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.connections(applicationId) });
    },
  });
}

export type ConnectionAction = 'start' | 'stop' | 'logout';

export function useConnectionAction(
  applicationId: string,
  connectionId: string,
): UseMutationResult<WhatsAppSessionResponse, Error, ConnectionAction> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (action: ConnectionAction) =>
      request<WhatsAppSessionResponse>(
        `${applicationPath(applicationId)}/whatsapp-sessions/${connectionId}/${action}`,
        { method: 'POST' },
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.connections(applicationId) });
    },
  });
}

export function useDeleteConnection(applicationId: string): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (connectionId: string) => {
      await request<void>(`${applicationPath(applicationId)}/whatsapp-sessions/${connectionId}`, {
        method: 'DELETE',
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.connections(applicationId) });
    },
  });
}

/**
 * Never cached, and only fetched while the provider is actually offering one.
 *
 * Codes expire in well under a minute and the provider issues a limited number
 * before the connection fails, so a cached image is a code that cannot work and
 * an attempt spent for nothing.
 */
export function useQrCode(
  applicationId: string,
  connectionId: string,
  isScannable: boolean,
): UseQueryResult<QrCodeResponse> {
  return useQuery({
    queryKey: queryKeys.qrCode(applicationId, connectionId),
    queryFn: async () =>
      request<QrCodeResponse>(
        `${applicationPath(applicationId)}/whatsapp-sessions/${connectionId}/qr-code`,
      ),
    enabled: isScannable,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchInterval: isScannable ? 15_000 : false,
    refetchIntervalInBackground: false,
  });
}

export interface NotificationPage {
  readonly data: NotificationResponse[];
  readonly nextCursor: string | null;
}

export function useNotifications(
  applicationId: string,
  filters: NotificationFilters,
): UseQueryResult<NotificationPage> {
  return useQuery({
    queryKey: queryKeys.notificationList(applicationId, filters),
    queryFn: async () =>
      request<NotificationPage>(
        `${applicationPath(applicationId)}/notifications${toQueryString({
          status: filters.status,
          recipient: filters.recipient,
          cursor: filters.cursor,
          limit: 25,
        })}`,
      ),
    // A list of in-flight deliveries is stale the moment it renders.
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
}

/**
 * Follows one notification while it is still moving, and stops once it cannot.
 */
export function useNotification(
  applicationId: string,
  notificationId: string,
): UseQueryResult<NotificationResponse> {
  return useQuery({
    queryKey: queryKeys.notification(applicationId, notificationId),
    queryFn: async () =>
      request<NotificationResponse>(
        `${applicationPath(applicationId)}/notifications/${notificationId}`,
      ),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === undefined) {
        return 3000;
      }
      const isSettled = status === 'FAILED' || status === 'CANCELLED';
      // DELIVERED is terminal for the status, but a read receipt can still
      // arrive, so it keeps a slow poll rather than stopping outright.
      return isSettled ? false : 3000;
    },
    refetchIntervalInBackground: false,
  });
}

export function useNotificationEvents(
  applicationId: string,
  notificationId: string,
): UseQueryResult<NotificationEventResponse[]> {
  return useQuery({
    queryKey: queryKeys.notificationEvents(applicationId, notificationId),
    queryFn: async () => {
      const result = await request<{ data: NotificationEventResponse[] }>(
        `${applicationPath(applicationId)}/notifications/${notificationId}/events`,
      );
      return result.data;
    },
    refetchInterval: 3000,
    refetchIntervalInBackground: false,
  });
}

export function useSendNotification(
  applicationId: string,
): UseMutationResult<NotificationResponse, Error, NotificationCreationRequest> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (body: NotificationCreationRequest) =>
      request<NotificationResponse>(`${applicationPath(applicationId)}/notifications`, {
        method: 'POST',
        body,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.notifications(applicationId) });
    },
  });
}

export function useCancelNotification(
  applicationId: string,
): UseMutationResult<NotificationResponse, Error, string> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (notificationId: string) =>
      request<NotificationResponse>(
        `${applicationPath(applicationId)}/notifications/${notificationId}/cancel`,
        { method: 'POST' },
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.notifications(applicationId) });
    },
  });
}

export interface ReadinessResponse {
  readonly status: 'ready' | 'not_ready';
  readonly checks: Readonly<
    Record<string, { status: string; durationMilliseconds: number; reason?: string }>
  >;
}

/**
 * Not-ready is an answer, not a failure.
 *
 * The probe reports 503 with a body naming the dependency that is down, and
 * that body is the entire value of the screen: turning it into a thrown error
 * would leave an operator looking at "something went wrong" during exactly the
 * incident this page exists for.
 */
export function useReadiness(): UseQueryResult<ReadinessResponse> {
  return useQuery({
    queryKey: queryKeys.readiness,
    queryFn: async () => {
      // A 503 with a body is the answer, not a failure: it carries the reason
      // each dependency gave. What is a failure is a response that is not the
      // document at all — a proxy error page, or nothing.
      const response = await fetch('/ready');

      try {
        return (await response.json()) as ReadinessResponse;
      } catch {
        throw new Error(`The API answered ${String(response.status)} without a readiness report.`);
      }
    },
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    retry: false,
  });
}
