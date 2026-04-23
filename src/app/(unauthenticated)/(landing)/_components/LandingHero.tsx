'use client';

import { Badge, Button, Container, Group, Paper, Stack, Text, Title } from '@mantine/core';
import Link from 'next/link';

export function LandingHero() {
  return (
    <Container py={64}>
      <Paper
        p={36}
        radius="xl"
        style={{
          background: 'linear-gradient(145deg, rgba(167, 243, 208, 0.12), rgba(255, 255, 255, 0.03))',
          border: '1px solid rgba(255, 255, 255, 0.08)',
        }}
      >
        <Stack gap="lg">
          <Badge color="lime" radius="sm" variant="light" w="fit-content">
            ClipCap Word
          </Badge>
          <Title order={1} style={{ fontSize: 'clamp(2.5rem, 7vw, 4.8rem)' }}>
            Turn rough ideas into polished writing systems.
          </Title>
          <Text c="dimmed" maw={720} size="lg">
            Draft briefs, outlines, long-form articles, landing page copy, and repurposed social posts
            inside one structured AI workspace.
          </Text>
          <Group>
            <Button component={Link} href="/home" radius="xl" size="lg">
              Open Workspace
            </Button>
            <Button component="a" href="#features" radius="xl" size="lg" variant="default">
              See Structure
            </Button>
          </Group>
        </Stack>
      </Paper>
    </Container>
  );
}
