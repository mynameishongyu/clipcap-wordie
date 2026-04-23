'use client';

import { ModalsProvider } from '@mantine/modals';
import type { ReactNode } from 'react';
import { BatchGenerateModal } from '@/src/modals/batch-generate';
import { CompleteRegistrationModal } from '@/src/modals/complete-registration';
import { GenerationReviewGuideModal } from '@/src/modals/generation-review-guide';
import { TemplateSaveModal } from '@/src/modals/save-template';
import { UsageGuideModal } from '@/src/modals/usage-guide';

const modalRegistry = {
  batchGenerate: BatchGenerateModal,
  completeRegistration: CompleteRegistrationModal,
  generationReviewGuide: GenerationReviewGuideModal,
  saveTemplate: TemplateSaveModal,
  usageGuide: UsageGuideModal,
};

interface ModalProviderProps {
  children: ReactNode;
}

export function ModalProvider({ children }: ModalProviderProps) {
  return <ModalsProvider modals={modalRegistry}>{children}</ModalsProvider>;
}
