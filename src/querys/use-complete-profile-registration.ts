'use client';

import { useMutation } from '@tanstack/react-query';

interface CompleteProfileRegistrationInput {
  email: string;
  displayName: string;
  organizationName: string;
  useCase: string;
}

export function useCompleteProfileRegistration() {
  return useMutation({
    mutationFn: async (input: CompleteProfileRegistrationInput) => {
      const response = await fetch('/api/profile', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
      });

      const payload = (await response.json()) as {
        code?: string;
        message?: string;
        data?: {
          id: string;
          email: string | null;
          display_name: string | null;
          organization_name: string | null;
          use_case: string | null;
          registration_status: 'pending' | 'completed';
          onboarded_at: string | null;
        };
      };

      if (!response.ok || !payload.data) {
        throw new Error(payload.message ?? '资料保存失败，请稍后重试。');
      }

      return payload.data;
    },
  });
}
