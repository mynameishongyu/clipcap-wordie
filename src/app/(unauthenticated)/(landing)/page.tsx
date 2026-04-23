import { Stack } from '@mantine/core';
import { LandingFeatures } from './_components/LandingFeatures';
import { LandingHero } from './_components/LandingHero';

export default function LandingPage() {
  return (
    <Stack gap={0}>
      <LandingHero />
      <LandingFeatures />
    </Stack>
  );
}
