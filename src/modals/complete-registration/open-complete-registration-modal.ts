'use client';

import { openContextModal } from '@mantine/modals';

interface OpenCompleteRegistrationModalOptions {
  sourceAction?: string;
}

export function openCompleteRegistrationModal(
  options: OpenCompleteRegistrationModalOptions = {},
) {
  openContextModal({
    modal: 'completeRegistration',
    title: null,
    innerProps: {
      sourceAction: options.sourceAction,
    },
    radius: 'xl',
    size: 520,
    centered: true,
  });
}
