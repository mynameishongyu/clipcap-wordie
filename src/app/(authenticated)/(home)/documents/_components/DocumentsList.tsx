import { Card, Stack, Text, Title } from '@mantine/core';

const documents = [
  'Homepage rewrite outline',
  'Case study interview summary',
  'Pricing page objections matrix',
  'Weekly newsletter draft',
];

export function DocumentsList() {
  return (
    <Stack>
      {documents.map((document) => (
        <Card key={document} padding="lg" radius="lg" withBorder>
          <Title order={4}>{document}</Title>
          <Text c="dimmed" size="sm">
            Structured placeholder content for the future word workspace.
          </Text>
        </Card>
      ))}
    </Stack>
  );
}
