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
          先上传 DOCX 模板识别槽位，再进入槽位编辑页面检查、修改、删除或手动新增槽位。
        </Text>
      </Stack>

      <List spacing="md" size="sm">
        <List.Item>
          <Text span fw={700}>
            1. 上传 DOCX 模板并开始识别
          </Text>
          <Text c="dimmed" component="div" mt={4}>
            上传 `.docx` 模板后点击“开始识别槽位”，系统会先解析文档，再调用大模型逐段抽取槽位结果。
          </Text>
        </List.Item>
        <List.Item>
          <Text span fw={700}>
            2. 检查系统默认抽取内容
          </Text>
          <Text c="dimmed" component="div" mt={4}>
            基础抽取内容包括：姓名、身份证号、民族、性别、出生日期、住址、联系电话、金额、百分数、日期、利率、分期。
          </Text>
        </List.Item>
        <List.Item>
          <Text span fw={700}>
            3. 如需其它槽位，可在输入框补充说明
          </Text>
          <Text c="dimmed" component="div" mt={4}>
            你可以在首页输入框里补充“还需要抽取哪些字段/槽位”，例如合同编号、车牌号、担保方式等，系统会把这些要求一起带给模型。
          </Text>
        </List.Item>
      </List>
    </Stack>
  );
}
