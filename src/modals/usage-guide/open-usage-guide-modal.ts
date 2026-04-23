'use client';

import { openContextModal } from '@mantine/modals';

export function openUsageGuideModal() {
  openContextModal({
    modal: 'usageGuide',
    title: '',
    centered: true,
    size: 620,
    innerProps: {},
  });
}
