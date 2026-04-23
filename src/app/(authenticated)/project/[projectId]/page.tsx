import { Badge, Container, Grid, Paper, Stack, Text, Title } from '@mantine/core';

interface ProjectPageProps {
  params: Promise<{
    projectId: string;
  }>;
}

export default async function ProjectPage({ params }: ProjectPageProps) {
  const { projectId } = await params;

  return (
    <Container py={32} size="xl">
      <Grid>
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Paper p="lg" radius="lg" withBorder>
            <Stack>
              <Badge color="lime" variant="light" w="fit-content">
                Project Chat
              </Badge>
              <Title order={3}>Workspace thread</Title>
              <Text c="dimmed">
                This left column mirrors the conversation-oriented structure from the video app. Hook your
                prompts, comments, and revision requests here.
              </Text>
            </Stack>
          </Paper>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Paper p="lg" radius="lg" withBorder>
            <Stack>
              <Title order={2}>Project: {projectId}</Title>
              <Text c="dimmed">
                Use this area for outline previews, generated drafts, source notes, and export actions.
              </Text>
            </Stack>
          </Paper>
        </Grid.Col>
      </Grid>
    </Container>
  );
}
