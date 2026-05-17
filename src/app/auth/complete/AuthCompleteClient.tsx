'use client';

import { Card, Stack, Text, Title } from '@mantine/core';
import { useEffect } from 'react';
import { publishAuthSyncEvent } from '@/src/lib/auth/auth-sync';
import { getSupabaseBrowserClient } from '@/src/lib/supabase/client';

export function AuthCompleteClient() {
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();

    const syncAuthBackToOriginalPage = async () => {
      try {
        await supabase.auth.getUser();
      } catch {
        // Ignore client-side user sync failures and still notify the original page.
      }

      publishAuthSyncEvent();
    };

    void syncAuthBackToOriginalPage();

    const secondSyncTimer = window.setTimeout(() => {
      void syncAuthBackToOriginalPage();
    }, 1200);

    return () => {
      window.clearTimeout(secondSyncTimer);
    };
  }, []);

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
      }}
    >
      <Card
        padding="xl"
        radius="xl"
        withBorder
        style={{ width: 'min(460px, 100%)' }}
      >
        <Stack gap="md">
          <Stack gap="xs">
            <Text c="teal.4" fw={800} size="lg">
              ClipCap
            </Text>
            <Title order={2}>登录完成</Title>
            <Text c="dimmed" size="sm">
              原来的 ClipCap 页面现在应该已经同步成登录成功状态。这个页面不会自动关闭，方便查看地址栏和调试信息。
            </Text>
          </Stack>
        </Stack>
      </Card>
    </main>
  );
}
