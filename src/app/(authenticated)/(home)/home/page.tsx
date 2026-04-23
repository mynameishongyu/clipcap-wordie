import { Container, Stack } from '@mantine/core';
import { HomeHero } from './_components/HomeHero';
import { HomeRecentProjects } from './_components/HomeRecentProjects';

export default function HomePage() {
  return (
    <Container py={28}>
      <Stack gap={40}>
        <HomeHero />
        <HomeRecentProjects />
      </Stack>
    </Container>
  );
}
