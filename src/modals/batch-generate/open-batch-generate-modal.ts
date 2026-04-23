'use client';

import { openContextModal } from '@mantine/modals';

interface OpenBatchGenerateModalInput {
  templateId: string;
  templateName: string;
}

export function openBatchGenerateModal(input: OpenBatchGenerateModalInput) {
  openContextModal({
    modal: 'batchGenerate',
    title: '',
    centered: true,
    padding: 0,
    size: 860,
    innerProps: input,
  });
}
