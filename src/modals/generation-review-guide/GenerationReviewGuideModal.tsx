'use client';

import { List, Stack, Text, Title } from '@mantine/core';
import type { ContextModalProps } from '@mantine/modals';

type GenerationReviewGuideInnerProps = Record<string, never>;

export function GenerationReviewGuideModal(
  {}: ContextModalProps<GenerationReviewGuideInnerProps>,
) {
  return (
    <Stack gap="lg">
      <Stack gap="xs">
        <Title order={3}>使用说明</Title>
        <Text c="dimmed" size="sm">
          下方同时展示模板抽取出的原始槽位和最终填充槽位。左侧 DOCX
          预览会把模板原始槽位值在文档里高亮显示出来。
        </Text>
      </Stack>

      <List spacing="md" size="sm">
        <List.Item>
          <Text span fw={700}>
            1. 先看左侧模板预览
          </Text>
          <Text c="dimmed" component="div" mt={4}>
            左侧会展示 DOCX 模板预览，并把模板中的原始槽位值高亮显示出来，方便你快速确认当前核查的是哪一段模板内容。
          </Text>
        </List.Item>
        <List.Item>
          <Text span fw={700}>
            2. 对照右侧填充结果逐项核查
          </Text>
          <Text c="dimmed" component="div" mt={4}>
            右侧会展示最终填充槽位。请结合模板原始槽位、槽位含义和抽取内容，确认每一项是否填写正确。
          </Text>
        </List.Item>
        <List.Item>
          <Text span fw={700}>
            3. 确认完成后保存
          </Text>
          <Text c="dimmed" component="div" mt={4}>
            核查无误后点击“保存并关闭”。保存完成的任务项会进入可下载状态，后续可以回到批量生成列表继续查看或下载结果。
          </Text>
        </List.Item>
      </List>
    </Stack>
  );
}
