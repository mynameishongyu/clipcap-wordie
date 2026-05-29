'use client';

import { Button, Stack, Text, TextInput, Title } from '@mantine/core';
import type { ContextModalProps } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useMemo, useState } from 'react';
import { TurnstileWidget } from '@/src/modals/complete-registration/TurnstileWidget';

type CompleteRegistrationInnerProps = {
  sourceAction?: string;
};

function mapEmailAuthErrorMessage(message: string | undefined) {
  const normalizedMessage = message?.toLowerCase() ?? '';

  if (normalizedMessage.includes('email rate limit exceeded')) {
    return '当前邮箱发送过于频繁，请稍等一分钟后再试，或先检查刚刚收到的登录邮件。';
  }

  if (normalizedMessage.includes('for security purposes')) {
    return '发送过于频繁，请稍等一会儿再试。';
  }

  if (normalizedMessage.includes('over_email_send_rate_limit')) {
    return '当前项目的邮件发送次数已达到上限，请稍后再试。';
  }

  return message ?? '发送登录邮件失败，请稍后重试。';
}

function isLocalhostLike(origin: string) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(
    origin.trim(),
  );
}

export function CompleteRegistrationModal({
  innerProps,
}: ContextModalProps<CompleteRegistrationInnerProps>) {
  const [email, setEmail] = useState('');
  const [turnstileToken, setTurnstileToken] = useState('');
  const [isSubmittingAuth, setIsSubmittingAuth] = useState(false);

  const appOrigin = useMemo(() => {
    const configuredOrigin = process.env.NEXT_PUBLIC_APP_URL?.trim();
    const normalizedConfiguredOrigin =
      configuredOrigin?.replace(/\/+$/, '') ?? '';
    const browserOrigin =
      typeof window !== 'undefined'
        ? window.location.origin.replace(/\/+$/, '')
        : '';

    if (
      normalizedConfiguredOrigin &&
      (!browserOrigin ||
        !isLocalhostLike(normalizedConfiguredOrigin) ||
        isLocalhostLike(browserOrigin))
    ) {
      return normalizedConfiguredOrigin;
    }

    if (browserOrigin) {
      return browserOrigin;
    }

    return '';
  }, []);

  const handleEmailAuth = async () => {
    if (!email.trim()) {
      notifications.show({
        color: 'yellow',
        title: '邮箱不能为空',
        message: '请先输入邮箱地址。',
      });
      return;
    }

    try {
      setIsSubmittingAuth(true);

      const response = await fetch('/api/auth/email-sign-in', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          redirectTo: `${appOrigin}/auth/callback?next=/`,
          turnstileToken: turnstileToken || undefined,
        }),
      });

      const rawText = await response.text();
      const payload = (rawText ? JSON.parse(rawText) : {}) as {
        message?: string;
        data?: {
          ok: boolean;
        };
      };

      if (!response.ok) {
        throw new Error(mapEmailAuthErrorMessage(payload.message));
      }

      notifications.show({
        color: 'teal',
        title: '登录邮件已发送',
        message: '请去邮箱点击登录链接，回到首页后即可继续使用。',
      });
    } catch (error) {
      notifications.show({
        color: 'red',
        title: '发送失败',
        message:
          error instanceof Error
            ? error.message
            : '发送登录邮件失败，请稍后重试。',
      });
    } finally {
      setIsSubmittingAuth(false);
    }
  };

  return (
    <Stack gap="lg">
      <Stack align="center" gap="sm">
        <Text c="teal.4" fw={800} size="xl">
          ClipCap
        </Text>
        <Title order={3} ta="center">
          邮箱登录
        </Title>
        <Text c="dimmed" maw={360} size="sm" ta="center">
          输入邮箱后，我们会发送一封登录链接邮件。收到邮件后点击链接即可进入系统。
          {innerProps.sourceAction ? ` 当前操作：${innerProps.sourceAction}` : ''}
        </Text>
      </Stack>

      <Stack gap="md">
        <TextInput
          placeholder="输入邮箱地址"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.currentTarget.value)}
        />

        <TurnstileWidget onTokenChange={setTurnstileToken} />

        <Button
          fullWidth
          loading={isSubmittingAuth}
          radius="xl"
          size="lg"
          variant="white"
          onClick={handleEmailAuth}
        >
          登录
        </Button>

        <Text c="dimmed" size="xs" ta="center">
          收到邮件后点击登录链接即可进入系统。
        </Text>
      </Stack>
    </Stack>
  );
}
