'use client';

import { Box, Text } from '@mantine/core';
import Script from 'next/script';
import { useEffect, useId, useRef } from 'react';
import { getTurnstileSiteKey, isTurnstileEnabled } from '@/src/lib/turnstile/env';

declare global {
  interface Window {
    turnstile?: {
      remove: (widgetId: string) => void;
      render: (
        container: string | HTMLElement,
        options: {
          sitekey: string;
          callback?: (token: string) => void;
          'expired-callback'?: () => void;
          'error-callback'?: () => void;
          theme?: 'light' | 'dark' | 'auto';
        },
      ) => string;
      reset: (widgetId?: string) => void;
    };
  }
}

interface TurnstileWidgetProps {
  onTokenChange: (token: string) => void;
}

export function TurnstileWidget({ onTokenChange }: TurnstileWidgetProps) {
  const siteKey = getTurnstileSiteKey();
  const isEnabled = isTurnstileEnabled();
  const containerId = useId().replace(/:/g, '');
  const widgetIdRef = useRef<string | null>(null);

  useEffect(() => {
    const tryRender = () => {
      if (!isEnabled || !siteKey || !window.turnstile || widgetIdRef.current) {
        return;
      }

      widgetIdRef.current = window.turnstile.render(`#${containerId}`, {
        sitekey: siteKey,
        theme: 'dark',
        callback: (token) => {
          onTokenChange(token);
        },
        'expired-callback': () => {
          onTokenChange('');
        },
        'error-callback': () => {
          onTokenChange('');
        },
      });
    };

    const intervalId = window.setInterval(tryRender, 300);
    tryRender();

    return () => {
      window.clearInterval(intervalId);

      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [containerId, isEnabled, onTokenChange, siteKey]);

  if (!isEnabled) {
    return null;
  }

  return (
    <>
      <Script
        defer
        src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
        strategy="afterInteractive"
      />
      <Box
        id={containerId}
        style={{
          minHeight: 66,
        }}
      />
    </>
  );
}
