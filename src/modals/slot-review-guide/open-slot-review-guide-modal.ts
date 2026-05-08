'use client';

import { openContextModal } from '@mantine/modals';

export function openSlotReviewGuideModal() {
  openContextModal({
    modal: 'slotReviewGuide',
    title: '',
    centered: true,
    size: 660,
    innerProps: {},
  });
}
