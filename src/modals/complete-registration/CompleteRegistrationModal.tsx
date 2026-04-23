'use client';

import { Button, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import { closeAllModals, type ContextModalProps } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useEffect, useMemo, useRef, useState } from 'react';
import { isTurnstileEnabled } from '@/src/lib/turnstile/env';
import { TurnstileWidget } from '@/src/modals/complete-registration/TurnstileWidget';
import { useCompleteProfileRegistration } from '@/src/querys/use-complete-profile-registration';
import { useRegistrationGateStore } from '@/src/stores/registration-gate-store';

type CompleteRegistrationInnerProps = {
  sourceAction?: string;
};

const useCaseOptions = [
  { label: '合同模板抽取', value: 'contract-extraction' },
  { label: '申报材料回填', value: 'submission-fill' },
  { label: '投标文件整理', value: 'bidding-documents' },
  { label: '尽调信息汇总', value: 'due-diligence' },
  { label: '自定义模板流程', value: 'custom-template' },
];

function mapEmailAuthErrorMessage(message: string | undefined) {
  const normalizedMessage = message?.toLowerCase() ?? '';

  if (normalizedMessage.includes('email rate limit exceeded')) {
    return '当前邮箱发送过于频繁，请稍等一分钟后再试，或先检查刚刚收到的登录邮件。';
  }

  if (normalizedMessage.includes('for security purposes')) {
    return '发送过于频繁，请稍等一会儿再试。';
  }

  if (normalizedMessage.includes('over_email_send_rate_limit')) {
    return '当前项目的邮件发送次数已触达上限，请稍后再试。';
  }

  return message ?? '发送登录邮件失败，请稍后重试。';
}

export function CompleteRegistrationModal({
  innerProps,
}: ContextModalProps<CompleteRegistrationInnerProps>) {
  const { isAuthenticated, profile, registrationStatus, setProfile } = useRegistrationGateStore();
  const wasAuthenticatedRef = useRef(isAuthenticated);
  const [email, setEmail] = useState(profile?.email ?? '');
  const [displayName, setDisplayName] = useState(profile?.displayName ?? '');
  const [organizationName, setOrganizationName] = useState(profile?.organizationName ?? '');
  const [useCase, setUseCase] = useState<string | null>(profile?.useCase ?? null);
  const [turnstileToken, setTurnstileToken] = useState('');
  const [isSubmittingAuth, setIsSubmittingAuth] = useState(false);
  const turnstileEnabled = isTurnstileEnabled();
  const completeProfileRegistrationMutation = useCompleteProfileRegistration();

  const isRegistrationFormVisible = isAuthenticated && registrationStatus !== 'completed';
  const isProfileSubmitDisabled =
    !displayName.trim() ||
    !email.trim() ||
    !organizationName.trim() ||
    !useCase ||
    completeProfileRegistrationMutation.isPending;

  const titleText = useMemo(() => {
    if (isRegistrationFormVisible) {
      return '补全注册资料';
    }

    return '邮箱登录';
  }, [isRegistrationFormVisible]);

  const subtitleText = useMemo(() => {
    if (isRegistrationFormVisible) {
      return '填写姓名、联系邮箱和使用场景后，我们会把资料保存到 Supabase 的 profiles 表里。';
    }

    return '输入邮箱后，我们会发送一封登录链接邮件。收到邮件后点击链接即可进入系统。';
  }, [isRegistrationFormVisible]);

  useEffect(() => {
    if (!wasAuthenticatedRef.current && isAuthenticated) {
      closeAllModals();
    }

    wasAuthenticatedRef.current = isAuthenticated;
  }, [isAuthenticated]);

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
          redirectTo: `${window.location.origin}/auth/callback?next=/home`,
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
        message: '请去邮箱点击登录链接，回到首页后继续补全资料。',
      });
    } catch (error) {
      notifications.show({
        color: 'red',
        title: '发送失败',
        message: error instanceof Error ? error.message : '发送登录邮件失败，请稍后重试。',
      });
    } finally {
      setIsSubmittingAuth(false);
    }
  };

  const handleCompleteProfile = async () => {
    if (isProfileSubmitDisabled) {
      return;
    }

    try {
      const payload = await completeProfileRegistrationMutation.mutateAsync({
        email: email.trim().toLowerCase(),
        displayName: displayName.trim(),
        organizationName: organizationName.trim(),
        useCase: useCase!,
      });

      setProfile({
        id: payload.id,
        displayName: payload.display_name ?? '',
        email: payload.email,
        organizationName: payload.organization_name ?? '',
        useCase: payload.use_case ?? '',
        onboardedAt: payload.onboarded_at,
      });

      notifications.show({
        color: 'teal',
        title: '注册完成',
        message: '资料已经保存，可以开始上传文件和执行抽取任务了。',
      });

      closeAllModals();
    } catch (error) {
      notifications.show({
        color: 'red',
        title: '保存失败',
        message: error instanceof Error ? error.message : '资料保存失败，请稍后重试。',
      });
    }
  };

  return (
    <Stack gap="lg">
      <Stack align="center" gap="sm">
        <Text c="teal.4" fw={800} size="xl">
          ClipCap
        </Text>
        <Title order={3} ta="center">
          {titleText}
        </Title>
        <Text c="dimmed" maw={360} size="sm" ta="center">
          {subtitleText}
          {innerProps.sourceAction ? ` 当前操作：${innerProps.sourceAction}` : ''}
        </Text>
      </Stack>

      {isRegistrationFormVisible ? (
        <Stack gap="md">
          <TextInput
            label="姓名"
            placeholder="请输入你的姓名"
            value={displayName}
            onChange={(event) => setDisplayName(event.currentTarget.value)}
          />

          <TextInput
            label="联系邮箱"
            placeholder="请输入常用邮箱"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.currentTarget.value)}
          />

          <TextInput
            label="公司或团队"
            placeholder="例如：法务团队 / 投标团队 / 咨询项目组"
            value={organizationName}
            onChange={(event) => setOrganizationName(event.currentTarget.value)}
          />

          <Select
            data={useCaseOptions}
            label="主要使用场景"
            placeholder="请选择你最常处理的文档任务"
            value={useCase}
            onChange={setUseCase}
          />

          <Button
            disabled={isProfileSubmitDisabled}
            fullWidth
            loading={completeProfileRegistrationMutation.isPending}
            radius="xl"
            size="md"
            onClick={handleCompleteProfile}
          >
            完成注册并开始使用
          </Button>
        </Stack>
      ) : (
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
      )}
    </Stack>
  );
}
