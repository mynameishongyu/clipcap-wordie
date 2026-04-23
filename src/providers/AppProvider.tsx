'use client';

import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import type { ReactNode } from 'react';
import { MantineThemeConfig } from '@/src/config/mantine-config';
import { ModalProvider } from '@/src/providers/ModalProvider';
import { QueryProvider } from '@/src/providers/QueryProvider';
import { RegistrationGateStoreProvider } from '@/src/stores/registration-gate-store';

interface AppProviderProps {
  children: ReactNode;
}

export function AppProvider({ children }: AppProviderProps) {
  return (
    <MantineProvider forceColorScheme="dark" theme={MantineThemeConfig}>
      <QueryProvider>
        <RegistrationGateStoreProvider>
          <ModalProvider>
            {children}
            <Notifications position="top-center" />
          </ModalProvider>
        </RegistrationGateStoreProvider>
      </QueryProvider>
    </MantineProvider>
  );
}
