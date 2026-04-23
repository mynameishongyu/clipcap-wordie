'use client';

import { openContextModal } from '@mantine/modals';

export function openGenerationReviewGuideModal() {
  openContextModal({
    modal: 'generationReviewGuide',
    title: '',
    centered: true,
    size: 620,
    innerProps: {},
  });
}
