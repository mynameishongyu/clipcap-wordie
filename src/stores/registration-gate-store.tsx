'use client';

import type { User } from '@supabase/supabase-js';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AUTH_SYNC_BROADCAST_CHANNEL,
  AUTH_SYNC_EVENT_TYPE,
  AUTH_SYNC_STORAGE_KEY,
} from '@/src/lib/auth/auth-sync';
import { getSupabaseBrowserClient } from '@/src/lib/supabase/client';

export type RegistrationStatus = 'anonymous' | 'pending' | 'completed';

export interface RegistrationProfile {
  id: string;
  displayName: string;
  email: string | null;
  organizationName: string;
  useCase: string;
  onboardedAt: string | null;
}

interface RegistrationGateStoreValue {
  isLoading: boolean;
  isAuthenticated: boolean;
  profile: RegistrationProfile | null;
  registrationStatus: RegistrationStatus;
  user: User | null;
  setProfile: (profile: RegistrationProfile | null) => void;
  signOut: () => Promise<void>;
}

const RegistrationGateStoreContext = createContext<RegistrationGateStoreValue | null>(null);

interface RegistrationGateStoreProviderProps {
  children: ReactNode;
}

export function RegistrationGateStoreProvider({ children }: RegistrationGateStoreProviderProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [profile, setProfile] = useState<RegistrationProfile | null>(null);
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();

    const hydrateSessionFromUrl = async () => {
      if (typeof window === 'undefined') {
        return;
      }

      const hash = window.location.hash;

      if (!hash.startsWith('#')) {
        return;
      }

      const params = new URLSearchParams(hash.slice(1));
      const accessToken = params.get('access_token');
      const refreshToken = params.get('refresh_token');
      const errorCode = params.get('error_code');

      if (errorCode || !accessToken || !refreshToken) {
        return;
      }

      const { error } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });

      if (!error) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }
    };

    const syncCurrentUser = async () => {
      await hydrateSessionFromUrl();

      const {
        data: { user: currentUser },
      } = await supabase.auth.getUser();

      setUser(currentUser);

      if (!currentUser) {
        setProfile(null);
        setIsLoading(false);
        return;
      }

      try {
        const response = await fetch('/api/profile', {
          cache: 'no-store',
        });

        if (!response.ok) {
          setProfile(null);
          setIsLoading(false);
          return;
        }

        const payload = (await response.json()) as {
          data: {
            id: string;
            email: string | null;
            display_name: string | null;
            organization_name: string | null;
            use_case: string | null;
            registration_status: 'pending' | 'completed';
            onboarded_at: string | null;
          };
        };

        setProfile({
          id: payload.data.id,
          displayName: payload.data.display_name ?? '',
          email: payload.data.email,
          organizationName: payload.data.organization_name ?? '',
          useCase: payload.data.use_case ?? '',
          onboardedAt: payload.data.onboarded_at,
        });
      } finally {
        setIsLoading(false);
      }
    };

    void syncCurrentUser();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(() => {
      setIsLoading(true);
      void syncCurrentUser();
    });

    const handleExternalAuthSync = () => {
      window.location.reload();
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== AUTH_SYNC_STORAGE_KEY || !event.newValue) {
        return;
      }

      try {
        const payload = JSON.parse(event.newValue) as { type?: string };

        if (payload.type === AUTH_SYNC_EVENT_TYPE) {
          handleExternalAuthSync();
        }
      } catch {
        // Ignore malformed storage payloads from stale tabs.
      }
    };

    window.addEventListener('storage', handleStorage);

    const channel =
      typeof window.BroadcastChannel !== 'undefined'
        ? new window.BroadcastChannel(AUTH_SYNC_BROADCAST_CHANNEL)
        : null;

    channel?.addEventListener('message', (event) => {
      try {
        const payload =
          typeof event.data === 'string'
            ? (JSON.parse(event.data) as { type?: string })
            : (event.data as { type?: string });

        if (payload?.type === AUTH_SYNC_EVENT_TYPE) {
          handleExternalAuthSync();
        }
      } catch {
        // Ignore malformed broadcast payloads from stale tabs.
      }
    });

    return () => {
      subscription.unsubscribe();
      window.removeEventListener('storage', handleStorage);
      channel?.close();
    };
  }, []);

  const value = useMemo<RegistrationGateStoreValue>(
    () => ({
      isLoading,
      isAuthenticated: Boolean(user),
      profile,
      registrationStatus: !user ? 'anonymous' : profile?.organizationName && profile?.useCase ? 'completed' : 'pending',
      user,
      setProfile: (nextProfile) => {
        setProfile(nextProfile);
      },
      signOut: async () => {
        const supabase = getSupabaseBrowserClient();
        await supabase.auth.signOut();
      },
    }),
    [isLoading, profile, user],
  );

  return (
    <RegistrationGateStoreContext.Provider value={value}>
      {children}
    </RegistrationGateStoreContext.Provider>
  );
}

/**
 * Exposes the current frontend registration-gate state for task entry and upload actions.
 * Throws when used outside the app-level provider so protected actions never silently bypass setup.
 */
export function useRegistrationGateStore() {
  const context = useContext(RegistrationGateStoreContext);

  if (!context) {
    throw new Error('useRegistrationGateStore must be used within RegistrationGateStoreProvider');
  }

  return context;
}
