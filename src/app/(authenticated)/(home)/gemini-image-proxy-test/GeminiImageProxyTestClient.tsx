'use client';

import { useMemo, useState } from 'react';
import {
  Button,
  Container,
  Group,
  Paper,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';

type TestResult = Record<string, unknown>;

const MIME_TYPE_OPTIONS = [
  { value: 'image/jpeg', label: 'image/jpeg' },
  { value: 'image/png', label: 'image/png' },
  { value: 'image/webp', label: 'image/webp' },
];

export function GeminiImageProxyTestClient() {
  const [storagePaths, setStoragePaths] = useState('');
  const [bucket, setBucket] = useState('generation-pdfs');
  const [mimeType, setMimeType] = useState('image/jpeg');
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const formattedResult = useMemo(
    () => (result ? JSON.stringify(result, null, 2) : ''),
    [result],
  );

  async function runTest() {
    setIsLoading(true);
    setErrorMessage('');
    setResult(null);

    try {
      const response = await fetch('/api/gemini-image-proxy-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          bucket,
          storagePaths: storagePaths
            .split(/\r?\n/)
            .map((storagePath) => storagePath.trim())
            .filter(Boolean),
          mimeType,
        }),
      });
      const payload = (await response.json().catch(() => null)) as TestResult | null;

      if (!response.ok) {
        const message =
          typeof payload?.message === 'string'
            ? payload.message
            : `Request failed with ${response.status}`;

        throw new Error(message);
      }

      setResult(payload ?? {});
      console.log('[Gemini Image Proxy Test]', payload);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Container py={32} size="md">
      <Stack gap="lg">
        <Stack gap={4}>
          <Title order={2}>Gemini Image Proxy Test</Title>
          <Text c="dimmed" size="sm">
            输入一个或多个 Supabase Storage path，测试 Gemini 是否能在同一次请求中读取 Vercel proxy URL。
          </Text>
        </Stack>

        <Paper p="md" radius="md" withBorder>
          <Stack gap="md">
            <TextInput
              label="Bucket"
              value={bucket}
              onChange={(event) => setBucket(event.currentTarget.value)}
            />
            <Textarea
              autosize
              label="Storage paths"
              minRows={7}
              placeholder={
                '58166df4-.../fill-pdf-pages/.../page-1.jpg\n58166df4-.../fill-pdf-pages/.../page-2.jpg\n58166df4-.../fill-pdf-pages/.../page-3.jpg\n58166df4-.../fill-pdf-pages/.../page-4.jpg'
              }
              value={storagePaths}
              onChange={(event) => setStoragePaths(event.currentTarget.value)}
            />
            <Select
              data={MIME_TYPE_OPTIONS}
              label="MIME type"
              value={mimeType}
              onChange={(value) => setMimeType(value ?? 'image/jpeg')}
            />
            <Group justify="flex-end">
              <Button
                disabled={!storagePaths.trim()}
                loading={isLoading}
                onClick={runTest}
              >
                开始测试
              </Button>
            </Group>
          </Stack>
        </Paper>

        {errorMessage ? (
          <Paper p="md" radius="md" withBorder>
            <Text c="red" size="sm">
              {errorMessage}
            </Text>
          </Paper>
        ) : null}

        <Textarea
          autosize
          label="Result"
          minRows={18}
          readOnly
          value={formattedResult}
        />
      </Stack>
    </Container>
  );
}
