'use client';

import { List, Stack, Text, Title } from '@mantine/core';
import type { ContextModalProps } from '@mantine/modals';

type UsageGuideInnerProps = Record<string, never>;

export function UsageGuideModal({}: ContextModalProps<UsageGuideInnerProps>) {
  return (
    <Stack gap="lg">
      <Stack gap="xs">
        <Title order={3}>使用说明</Title>
        <Text c="dimmed" size="sm">
          DOCX 模板是必传文件，用来抽取槽位并生成槽位含义。扫描 PDF
          是可选证据文件；上传 PDF 时，系统会额外把 DOCX 槽位值关联到 PDF
          页面位置。
        </Text>
      </Stack>

      <List spacing="md" size="sm">
        <List.Item>
          <Text span fw={700}>
            1. 上传 DOCX 模板
          </Text>
          <Text c="dimmed" component="div" mt={4}>
            只上传 DOCX 时，可以直接点击“开始识别槽位”。系统会识别模板中的姓名、性别、日期、金额等槽位，并生成每个槽位的含义。
          </Text>
        </List.Item>
        <List.Item>
          <Text span fw={700}>
            2. 可选上传扫描 PDF 证据
          </Text>
          <Text c="dimmed" component="div" mt={4}>
            如果同时上传扫描 PDF，浏览器会先把 PDF 渲染成页图并上传到存储，然后视觉模型会在页图中定位槽位值，返回页码、框选位置、证据文本和置信度。
          </Text>
        </List.Item>
        <List.Item>
          <Text span fw={700}>
            3. 在槽位核查页检查和调整
          </Text>
          <Text c="dimmed" component="div" mt={4}>
            进入核查页后，可以检查、修改、删除或手动新增槽位。有 PDF
            证据时，页面会展示对应 PDF 页图和定位框；没有 PDF
            时，只展示 DOCX 预览和槽位清单。
          </Text>
        </List.Item>
      </List>
    </Stack>
  );
}
