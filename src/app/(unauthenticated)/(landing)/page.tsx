import { Container, Stack } from '@mantine/core';
import { HomeHero } from '@/src/components/home/HomeHero';
import { HomeRecentProjects } from '@/src/components/home/HomeRecentProjects';

export default function LandingPage() {
  return (
    <Container py={28}>
      <Stack gap={40}>
        <HomeHero />
        <HomeRecentProjects />
      </Stack>
    </Container>
  );
}
