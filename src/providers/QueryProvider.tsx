'use client';

import {
  QueryClient,
  QueryClientProvider,
  type QueryClient as QueryClientType,
} from '@tanstack/react-query';
import type { ReactNode } from 'react';

interface QueryProviderProps {
  children: ReactNode;
  client?: QueryClientType;
}

export function QueryProvider({ children, client }: QueryProviderProps) {
  const queryClient = client ?? new QueryClient();

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
