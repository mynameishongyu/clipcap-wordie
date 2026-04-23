'use client';

import { Button, Card, Stack, Text, Title } from '@mantine/core';
import { useEffect } from 'react';
import { publishAuthSyncEvent } from '@/src/lib/auth/auth-sync';

export default function AuthCompletePage() {
  useEffect(() => {
    publishAuthSyncEvent();
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
            <Title order={2}>登录已完成</Title>
            <Text c="dimmed" size="sm">
              如果你最开始的首页标签页还开着，它现在会自动同步登录状态。当前这个页面不用再进入一个新的
              首页了，直接关闭即可。
            </Text>
          </Stack>

          <Button
            fullWidth
            radius="xl"
            variant="default"
            onClick={() => {
              window.close();
            }}
          >
            关闭当前页
          </Button>
        </Stack>
      </Card>
    </main>
  );
}
