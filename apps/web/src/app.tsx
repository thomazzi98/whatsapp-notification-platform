import { type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router';

import { useSession } from './api/queries';
import { Loading } from './components/ui';
import { ApiKeysPage } from './routes/api-keys';
import { ApplicationLayout } from './routes/application-layout';
import { ApplicationsPage } from './routes/applications';
import { ConnectionPage } from './routes/connection';
import { ConnectionsPage } from './routes/connections';
import { NotificationPage } from './routes/notification';
import { NotificationsPage } from './routes/notifications';
import { OverviewPage } from './routes/overview';
import { SendPage } from './routes/send';
import { SignInPage } from './routes/sign-in';
import { SystemStatusPage } from './routes/system-status';

/**
 * The tenant lives in the path, not in a context set by a dropdown.
 *
 * Every screen is then linkable and survives a refresh, and a URL pasted into a
 * ticket opens the same application for whoever follows it — which is not true
 * of a selection kept in memory.
 */
export function App(): ReactNode {
  const session = useSession();

  if (session.isPending) {
    return <Loading label="Checking your session…" />;
  }

  if (session.data === null || session.data === undefined) {
    return (
      <Routes>
        <Route path="/sign-in" element={<SignInPage />} />
        <Route path="*" element={<Navigate to="/sign-in" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/sign-in" element={<Navigate to="/applications" replace />} />
      <Route path="/applications" element={<ApplicationsPage />} />
      <Route path="/applications/:applicationId" element={<ApplicationLayout />}>
        <Route index element={<OverviewPage />} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="notifications/:notificationId" element={<NotificationPage />} />
        <Route path="send" element={<SendPage />} />
        <Route path="connections" element={<ConnectionsPage />} />
        <Route path="connections/:connectionId" element={<ConnectionPage />} />
        <Route path="api-keys" element={<ApiKeysPage />} />
        <Route path="status" element={<SystemStatusPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/applications" replace />} />
    </Routes>
  );
}
