'use client';

import { Button, Group, Stack, Text, TextInput, Title } from '@mantine/core';
import type { ContextModalProps } from '@mantine/modals';
import { useState } from 'react';

interface SaveTemplateModalInnerProps {
  initialName?: string;
  onSave: (templateName: string) => Promise<void>;
}

export function TemplateSaveModal({
  context,
  id,
  innerProps,
}: ContextModalProps<SaveTemplateModalInnerProps>) {
  const [templateName, setTemplateName] = useState(innerProps.initialName ?? '');
  const [errorMessage, setErrorMessage] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = async () => {
    const normalizedTemplateName = templateName.trim();

    if (!normalizedTemplateName) {
      setErrorMessage('请输入模板名称后再保存。');
      return;
    }

    setErrorMessage('');
    setIsSaving(true);

    try {
      await innerProps.onSave(normalizedTemplateName);
      context.closeModal(id);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Stack gap="lg">
      <Stack gap="xs">
        <Title order={3}>保存模板</Title>
        <Text c="dimmed" size="sm">
          请输入模板名称。只有填写名称后，当前模板和 DOCX 原文件才会保存到数据库。
        </Text>
      </Stack>

      <TextInput
        autoFocus
        error={errorMessage || undefined}
        label="模板名称"
        placeholder="石家庄新区科技支行-车贷"
        value={templateName}
        onChange={(event) => {
          setTemplateName(event.currentTarget.value);
          if (errorMessage) {
            setErrorMessage('');
          }
        }}
      />

      <Group justify="flex-end">
        <Button
          color="gray"
          radius="xl"
          variant="subtle"
          onClick={() => context.closeModal(id)}
        >
          返回
        </Button>
        <Button
          color="teal"
          loading={isSaving}
          radius="xl"
          onClick={handleSave}
        >
          保存
        </Button>
      </Group>
    </Stack>
  );
}
