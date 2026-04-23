import { Container, Stack, Text, Title } from '@mantine/core';
import { DocumentsList } from './_components/DocumentsList';

export default function DocumentsPage() {
  return (
    <Container py={48}>
      <Stack>
        <div>
          <Title order={2}>Documents</Title>
          <Text c="dimmed">A companion route to mirror the original project grouping with a writing-first focus.</Text>
        </div>
        <DocumentsList />
      </Stack>
    </Container>
  );
}
