'use client';

import { List, Stack, Text, Title } from '@mantine/core';
import type { ContextModalProps } from '@mantine/modals';

type SlotReviewGuideInnerProps = Record<string, never>;

export function SlotReviewGuideModal(
  {}: ContextModalProps<SlotReviewGuideInnerProps>,
) {
  return (
    <Stack gap="lg">
      <Stack gap="xs">
        <Title order={3}>槽位核查使用说明</Title>
        <Text c="dimmed" size="sm">
          本页用于核查 DOCX 中抽取出的槽位、槽位含义，以及可选的 PDF
          页面证据定位。你可以修改槽位值，也可以重新框选 PDF 证据位置。
        </Text>
      </Stack>

      <List spacing="md" size="sm">
        <List.Item>
          <Text span fw={700}>
            1. 先选择右侧槽位
          </Text>
          <Text c="dimmed" component="div" mt={4}>
            点击右侧槽位卡片后，左侧 DOCX 预览会滚动到对应原文位置；如果有
            PDF 证据，中间 PDF 预览也会自动滚动到对应页和框选位置。
          </Text>
        </List.Item>
        <List.Item>
          <Text span fw={700}>
            2. 修改 DOCX 槽位值
          </Text>
          <Text c="dimmed" component="div" mt={4}>
            点击槽位卡片上的“修改”，然后在左侧 DOCX 预览中重新框选连续文本，确认无误后点击卡片里的“保存”。
          </Text>
        </List.Item>
        <List.Item>
          <Text span fw={700}>
            3. 修正 PDF 证据定位
          </Text>
          <Text c="dimmed" component="div" mt={4}>
            选中槽位后点击“调整当前槽位定位”，在中间 PDF 任意页面上拖拽画框，再点击“保存定位”。保存后会更新该槽位的 PDF 页码和 bbox。
          </Text>
        </List.Item>
        <List.Item>
          <Text span fw={700}>
            4. 保存模板
          </Text>
          <Text c="dimmed" component="div" mt={4}>
            所有槽位和 PDF 定位确认完成后，点击顶部“保存模板”。后续批量回填会使用你保存后的槽位结构。
          </Text>
        </List.Item>
      </List>
    </Stack>
  );
}
