import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';

import { App } from './app';
import './styles.css';

const rootElement = document.querySelector('#root');

if (rootElement === null) {
  throw new Error('The document has no #root element to mount into.');
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Refetching every time a window regains focus is noise on a dashboard
      // whose live screens already poll on their own schedule.
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 5000,
    },
  },
});

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
