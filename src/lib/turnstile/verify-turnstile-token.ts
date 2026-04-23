import 'server-only';

import { headers } from 'next/headers';
import { getTurnstileSecretKey } from '@/src/lib/turnstile/env';

interface TurnstileVerificationResult {
  success: boolean;
  ['error-codes']?: string[];
}

/**
 * Verifies a Cloudflare Turnstile token with the server-side Siteverify API before allowing auth or other protected actions.
 */
export async function verifyTurnstileToken(token: string) {
  const requestHeaders = await headers();
  const remoteIp =
    requestHeaders.get('cf-connecting-ip') ??
    requestHeaders.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    undefined;

  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      secret: getTurnstileSecretKey(),
      response: token,
      remoteip: remoteIp,
    }),
    cache: 'no-store',
  });

  const result = (await response.json()) as TurnstileVerificationResult;

  return result;
}
