'use client';

import { Badge, Group, Paper, Stack, Text, Title } from '@mantine/core';

const scenarios = [
  '合同模板抽取',
  '申报材料回填',
  '投标文件整理',
  '尽调信息汇总',
  '企业证照识别',
  '自定义模板场景',
];

export function HomeScenarioCards() {
  return (
    <Paper
      p="xl"
      radius={28}
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      <Stack gap="lg" align="center">
        <Badge color="teal" radius="sm" variant="outline">
          常见场景
        </Badge>
        <Title order={3} ta="center">
          适用于这些高频文档任务
        </Title>
        <Text c="#a9a293" maw={700} ta="center">
          你可以从合同、申报、投标、尽调等场景开始，也可以上传自定义模板直接进入槽位识别。
        </Text>
        <Group gap="sm" justify="center">
          {scenarios.map((scenario) => (
            <Paper
              key={scenario}
              px="md"
              py="sm"
              radius="xl"
              style={{
                background: '#262626',
                border: '1px solid rgba(255,255,255,0.05)',
              }}
            >
              <Text size="sm">{scenario}</Text>
            </Paper>
          ))}
        </Group>
      </Stack>
    </Paper>
  );
}
