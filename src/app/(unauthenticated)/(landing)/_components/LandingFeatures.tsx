import { Card, Container, SimpleGrid, Stack, Text, Title } from '@mantine/core';

const features = [
  {
    title: 'Idea to Brief',
    description: 'Turn a sentence or source URL into a clear writing brief with audience, goal, tone, and outline.',
  },
  {
    title: 'Document Workspace',
    description: 'Keep drafts, references, revision history, and structured output in a per-project workspace.',
  },
  {
    title: 'Repurpose Faster',
    description: 'Transform one core article into newsletters, social posts, summaries, and landing page copy.',
  },
];

export function LandingFeatures() {
  return (
    <Container id="features" pb={64}>
      <Stack gap="xl">
        <Title order={2}>Built like the video app, tuned for words</Title>
        <SimpleGrid cols={{ base: 1, md: 3 }}>
          {features.map((feature) => (
            <Card key={feature.title} padding="xl" radius="lg" withBorder>
              <Stack>
                <Title order={3}>{feature.title}</Title>
                <Text c="dimmed">{feature.description}</Text>
              </Stack>
            </Card>
          ))}
        </SimpleGrid>
      </Stack>
    </Container>
  );
}
