'use client';

import { Badge, Box, Card, Group, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useEffect, useState } from 'react';

const examples = [
  {
    eyebrow: '步骤一',
    title: '上传模板并识别槽位',
    description: '从 DOCX 模板中提取字段位置、表格结构和待填内容，生成可回填的槽位清单。',
    status: '正在识别模板结构与字段位置',
    renderVisual: (isActive: boolean) => (
      <Box
        p="md"
        style={{
          background: '#f8f8f4',
          borderRadius: '18px',
          minHeight: 180,
          border: '1px solid #ece8dd',
          transition: 'transform 320ms ease, box-shadow 320ms ease',
          transform: isActive ? 'translateY(-4px)' : 'translateY(0)',
          boxShadow: isActive ? '0 22px 44px rgba(56, 211, 159, 0.16)' : 'none',
        }}
      >
        <Box
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1.4fr',
            gap: 12,
            alignItems: 'stretch',
            height: '100%',
          }}
        >
          <Box
            style={{
              background: '#e6ede8',
              borderRadius: 14,
              position: 'relative',
              overflow: 'hidden',
            }}
          >
            <Box
              style={{
                position: 'absolute',
                inset: 0,
                background: isActive
                  ? 'linear-gradient(120deg, transparent 20%, rgba(56, 211, 159, 0.24) 50%, transparent 80%)'
                  : 'transparent',
                transform: isActive ? 'translateX(100%)' : 'translateX(-100%)',
                transition: 'transform 900ms ease',
              }}
            />
          </Box>
          <Stack gap={8} justify="center">
            <Box h={14} style={{ background: '#dbe5dc', borderRadius: 999 }} />
            <Box
              h={14}
              w={isActive ? '84%' : '70%'}
              style={{
                background: '#38d39f',
                borderRadius: 999,
                transition: 'width 320ms ease',
              }}
            />
            <Box h={14} style={{ background: '#dbe5dc', borderRadius: 999 }} />
            <Box h={14} w="56%" style={{ background: '#dbe5dc', borderRadius: 999 }} />
          </Stack>
        </Box>
      </Box>
    ),
  },
  {
    eyebrow: '步骤二',
    title: '从 PDF 中抽取对应内容',
    description: '系统会从扫描件、附件或申报材料中识别企业名、金额、日期、编号等信息。',
    status: '正在批量提取企业名、金额、日期等字段',
    renderVisual: (isActive: boolean) => (
      <Box
        p="lg"
        style={{
          background: '#f8f8f4',
          borderRadius: '18px',
          minHeight: 180,
          border: '1px solid #ece8dd',
          transition: 'transform 320ms ease, box-shadow 320ms ease',
          transform: isActive ? 'translateY(-4px)' : 'translateY(0)',
          boxShadow: isActive ? '0 22px 44px rgba(56, 211, 159, 0.16)' : 'none',
        }}
      >
        <Stack gap="md" justify="center" h="100%">
          <Text c="#12a57a" fw={700} size="xs">
            + EXTRACT FROM PDF
          </Text>
          <Box
            p="md"
            style={{
              background: '#ffffff',
              borderRadius: 16,
              boxShadow: '0 20px 40px rgba(0,0,0,0.08)',
              transition: 'transform 320ms ease',
              transform: isActive ? 'scale(1.02)' : 'scale(1)',
            }}
          >
            <Stack gap={10}>
              <Text fw={600} size="sm">
                企业营业执照
              </Text>
              <Box h={12} style={{ background: '#e4eee7', borderRadius: 999 }} />
              <Box h={12} w={isActive ? '92%' : '80%'} style={{ background: '#e4eee7', borderRadius: 999, transition: 'width 320ms ease' }} />
              <Group gap={8}>
                {[0, 1, 2, 3].map((index) => (
                  <Box
                    key={index}
                    h={3}
                    w={24}
                    style={{
                      background: '#38d39f',
                      borderRadius: 999,
                      opacity: isActive ? 1 : 0.6,
                      transform: isActive ? `scaleX(${1 + index * 0.08})` : 'scaleX(1)',
                      transition: `opacity 320ms ease, transform 320ms ease ${index * 60}ms`,
                    }}
                  />
                ))}
              </Group>
            </Stack>
          </Box>
        </Stack>
      </Box>
    ),
  },
  {
    eyebrow: '步骤三',
    title: '自动回填并输出结果',
    description: '所有抽取结果都会映射回槽位，保留来源证据，方便人工校验与继续编辑。',
    status: '正在将抽取结果映射回模板槽位',
    renderVisual: (isActive: boolean) => (
      <Box
        p="md"
        style={{
          background: '#f8f8f4',
          borderRadius: '18px',
          minHeight: 180,
          border: '1px solid #ece8dd',
          transition: 'transform 320ms ease, box-shadow 320ms ease',
          transform: isActive ? 'translateY(-4px)' : 'translateY(0)',
          boxShadow: isActive ? '0 22px 44px rgba(56, 211, 159, 0.16)' : 'none',
        }}
      >
        <Group align="flex-start" grow h="100%" wrap="nowrap">
          <Stack gap={10}>
            <Box h={18} style={{ background: '#ece8dd', borderRadius: 999 }} />
            <Box h={54} style={{ background: '#ffffff', borderRadius: 12, border: '1px solid #ece8dd' }} />
            <Group grow>
              <Box h={64} style={{ background: '#ffffff', borderRadius: 12, border: '1px solid #ece8dd' }} />
              <Box h={64} style={{ background: '#ffffff', borderRadius: 12, border: '1px solid #ece8dd' }} />
            </Group>
          </Stack>
          <Box
            style={{
              minHeight: 150,
              background: '#eaf2ee',
              borderRadius: 14,
              border: '1px solid #d6e4db',
              flex: 1,
              position: 'relative',
              overflow: 'hidden',
            }}
          >
            <Box
              style={{
                position: 'absolute',
                inset: isActive ? '18% 12% 18% 12%' : '22% 18% 22% 18%',
                background: 'rgba(56, 211, 159, 0.18)',
                borderRadius: 12,
                transition: 'inset 320ms ease, background 320ms ease',
              }}
            />
          </Box>
        </Group>
      </Box>
    ),
  },
];

export function HomeWorkflowExample() {
  const [activeStep, setActiveStep] = useState(0);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setActiveStep((current) => (current + 1) % examples.length);
    }, 2600);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  return (
    <Stack gap="xl" pt={32}>
      <Stack align="center" gap={10}>
        <Badge color="teal" radius="sm" variant="outline">
          流程示例
        </Badge>
        <Title order={2} ta="center" style={{ fontSize: 'clamp(2rem, 4vw, 3rem)' }}>
          按这个节奏完成一次抽取任务
        </Title>
        <Text c="#b4ad9f" maw={760} ta="center">
          从模板识别，到 PDF 抽取，再到槽位回填，整个流程始终围绕“可验证、可编辑、可导出”的结果展开。
        </Text>
      </Stack>

      <SimpleGrid cols={{ base: 1, md: 3 }} spacing="xl">
        {examples.map((example, index) => {
          const isActive = index === activeStep;

          return (
            <Card
              key={example.title}
              padding="lg"
              radius={24}
              style={{
                background: 'transparent',
                color: '#f4efe5',
                opacity: isActive ? 1 : 0.72,
                transform: isActive ? 'translateY(-6px)' : 'translateY(0)',
                transition: 'opacity 320ms ease, transform 320ms ease',
              }}
            >
              <Stack gap="lg">
                {example.renderVisual(isActive)}
                <Stack gap={6} align="center">
                  <Text c="#38d39f" fw={700} size="xs">
                    {example.eyebrow}
                  </Text>
                  <Title order={3} ta="center">
                    {example.title}
                  </Title>
                  <Text c="#a9a293" size="sm" ta="center">
                    {example.description}
                  </Text>
                </Stack>
              </Stack>
            </Card>
          );
        })}
      </SimpleGrid>

      <Stack align="center" gap={12}>
        <Group gap={8}>
          {examples.map((example, index) => (
            <Box
              key={example.title}
              style={{
                width: index === activeStep ? 36 : 10,
                height: 10,
                borderRadius: 999,
                background: index === activeStep ? '#38d39f' : 'rgba(255,255,255,0.18)',
                transition: 'width 280ms ease, background 280ms ease',
              }}
            />
          ))}
        </Group>
        <Text c="#d7d1c5" size="sm" ta="center">
          {examples[activeStep]?.status}
        </Text>
      </Stack>
    </Stack>
  );
}
