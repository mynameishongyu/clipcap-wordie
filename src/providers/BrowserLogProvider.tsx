'use client';

import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import {
  createBrowserRunLogger,
  type BrowserRunLoggerInstance,
} from '@/src/lib/browser/browser-run-logger';
import { useRegistrationGateStore } from '@/src/stores/registration-gate-store';

interface BrowserLogProviderProps {
  children: ReactNode;
}

export function BrowserLogProvider({ children }: BrowserLogProviderProps) {
  const { isAuthenticated, profile, registrationStatus, user } =
    useRegistrationGateStore();
  const loggerRef = useRef<BrowserRunLoggerInstance | null>(null);
  const loggedUserIdRef = useRef<string | null>(null);
  const userId = user?.id ?? null;

  useEffect(() => {
    if (!isAuthenticated || !userId) {
      loggedUserIdRef.current = null;
      return;
    }

    const logger = createBrowserRunLogger({
      scope: 'app',
      meta: {
        source: 'global-browser-log',
      },
    });

    loggerRef.current = logger;
    logger.start();

    const handleBeforeUnload = () => {
      void logger.finalize();
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      void logger.finalize().finally(() => {
        logger.stop();
      });
      loggerRef.current = null;
    };
  }, [isAuthenticated, userId]);

  useEffect(() => {
    if (!isAuthenticated || !user || !loggerRef.current) {
      if (!isAuthenticated || !user) {
        loggedUserIdRef.current = null;
      }
      return;
    }

    if (loggedUserIdRef.current === user.id) {
      return;
    }

    loggedUserIdRef.current = user.id;
    console.info('[Auth][Current User]', {
      id: user.id,
      email: user.email ?? null,
      role: user.role ?? null,
      registrationStatus,
      displayName: profile?.displayName ?? null,
    });
  }, [isAuthenticated, profile, registrationStatus, user]);

  return children;
}
