import { Container } from '@mantine/core';
import { SlotReviewWorkspace } from '../_components/SlotReviewWorkspace';

export default function SlotReviewPage() {
  return (
    <Container fluid px={24} py={32}>
      <SlotReviewWorkspace />
    </Container>
  );
}
