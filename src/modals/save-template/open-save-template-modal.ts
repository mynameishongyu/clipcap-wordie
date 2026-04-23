'use client';

import { openContextModal } from '@mantine/modals';

interface OpenSaveTemplateModalInput {
  initialName?: string;
  onSave: (templateName: string) => Promise<void>;
}

export function openSaveTemplateModal(input: OpenSaveTemplateModalInput) {
  openContextModal({
    modal: 'saveTemplate',
    title: '',
    centered: true,
    size: 520,
    innerProps: input,
  });
}
