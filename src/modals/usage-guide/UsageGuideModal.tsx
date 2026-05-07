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
          槽位抽取需要同时上传 DOCX 模板和扫描 PDF。系统会先识别 DOCX
          中的槽位，再把槽位值关联到 PDF 的对应页面。
        </Text>
      </Stack>

      <List spacing="md" size="sm">
        <List.Item>
          <Text span fw={700}>
            1. 上传 DOCX 模板和扫描 PDF
          </Text>
          <Text c="dimmed" component="div" mt={4}>
            DOCX 用来定义需要抽取的槽位内容，PDF
            用来做页面证据定位。两个文件都上传后，才可以点击“开始识别槽位”。
          </Text>
        </List.Item>
        <List.Item>
          <Text span fw={700}>
            2. 识别 DOCX 槽位并关联 PDF 页面
          </Text>
          <Text c="dimmed" component="div" mt={4}>
            系统会调用文本模型抽取 DOCX 槽位，并调用视觉模型 OCR 扫描
            PDF，再把姓名、性别、日期、金额等槽位值匹配到 PDF 页。
          </Text>
        </List.Item>
        <List.Item>
          <Text span fw={700}>
            3. 在槽位编辑页检查和调整
          </Text>
          <Text c="dimmed" component="div" mt={4}>
            进入编辑页后，可以检查、修改、删除或手动新增槽位；左侧槽位会展示关联到的
            PDF 页，右侧可查看 DOCX 原文和 PDF 证据预览。
          </Text>
        </List.Item>
      </List>
    </Stack>
  );
}
