import { createHmac, timingSafeEqual } from 'crypto';
import type { GeminiVisionFile } from '@/src/lib/llm/gemini-vision-file';

const DEFAULT_GEMINI_IMAGE_PROXY_TOKEN_EXPIRES_IN_SECONDS = 10 * 60;
const DEFAULT_GEMINI_IMAGE_PROXY_BUCKET = 'generation-pdfs';

export interface GeminiImageProxyTokenPayload {
  bucket: string;
  storagePath: string;
  mimeType: string;
  exp: number;
}

function base64UrlEncode(value: string) {
  return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function getProxySecret() {
  const secret =
    process.env.VERCEL_GEMINI_IMAGE_PROXY_SECRET ??
    process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!secret?.trim()) {
    throw new Error(
      'Missing VERCEL_GEMINI_IMAGE_PROXY_SECRET or SUPABASE_SERVICE_ROLE_KEY.',
    );
  }

  return secret;
}

function signPayload(payload: string) {
  return createHmac('sha256', getProxySecret()).update(payload).digest('base64url');
}

export function getGeminiImageProxyTokenExpiresInSeconds() {
  const parsed = Number(
    process.env.VERCEL_GEMINI_IMAGE_PROXY_TOKEN_EXPIRES_IN_SECONDS,
  );

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_GEMINI_IMAGE_PROXY_TOKEN_EXPIRES_IN_SECONDS;
  }

  return Math.max(1, Math.floor(parsed));
}

export function getGeminiImageProxyBaseUrl() {
  const explicitBaseUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();

  if (explicitBaseUrl) {
    return explicitBaseUrl.replace(/\/+$/, '');
  }

  const vercelUrl = process.env.VERCEL_URL?.trim();

  if (vercelUrl) {
    return `https://${vercelUrl.replace(/\/+$/, '')}`;
  }

  throw new Error(
    'Missing NEXT_PUBLIC_APP_URL for Gemini image proxy URL generation.',
  );
}

export function createGeminiImageProxyToken(input: {
  bucket?: string;
  storagePath: string;
  mimeType: string;
}) {
  const payload = base64UrlEncode(
    JSON.stringify({
      bucket: input.bucket ?? DEFAULT_GEMINI_IMAGE_PROXY_BUCKET,
      storagePath: input.storagePath,
      mimeType: input.mimeType,
      exp:
        Math.floor(Date.now() / 1000) +
        getGeminiImageProxyTokenExpiresInSeconds(),
    } satisfies GeminiImageProxyTokenPayload),
  );
  const signature = signPayload(payload);

  return `${payload}.${signature}`;
}

export function verifyGeminiImageProxyToken(
  token: string,
): GeminiImageProxyTokenPayload {
  const [payload, signature] = token.split('.');

  if (!payload || !signature) {
    throw new Error('Invalid Gemini image proxy token.');
  }

  const expectedSignature = signPayload(payload);
  const signatureBuffer = Buffer.from(signature);
  const expectedSignatureBuffer = Buffer.from(expectedSignature);

  if (
    signatureBuffer.length !== expectedSignatureBuffer.length ||
    !timingSafeEqual(signatureBuffer, expectedSignatureBuffer)
  ) {
    throw new Error('Invalid Gemini image proxy token signature.');
  }

  const parsed = JSON.parse(
    base64UrlDecode(payload),
  ) as Partial<GeminiImageProxyTokenPayload>;

  if (!parsed.exp || parsed.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Gemini image proxy token expired.');
  }

  if (
    parsed.bucket !== DEFAULT_GEMINI_IMAGE_PROXY_BUCKET ||
    !parsed.storagePath ||
    !parsed.mimeType?.startsWith('image/')
  ) {
    throw new Error('Gemini image proxy token has invalid image metadata.');
  }

  return {
    bucket: parsed.bucket,
    storagePath: parsed.storagePath,
    mimeType: parsed.mimeType,
    exp: parsed.exp,
  };
}

export function getGeminiImageProxyUrlExpiresAt(url: string) {
  try {
    const requestUrl = new URL(url);
    const token = requestUrl.searchParams.get('token');

    if (!token) {
      return null;
    }

    const payload = verifyGeminiImageProxyToken(token);

    return new Date(payload.exp * 1000).toISOString();
  } catch {
    return null;
  }
}

export function createGeminiImageProxyUrl(input: {
  bucket?: string;
  storagePath: string;
  mimeType: string;
}) {
  const token = createGeminiImageProxyToken(input);

  return `${getGeminiImageProxyBaseUrl()}/api/gemini-image-proxy?token=${encodeURIComponent(
    token,
  )}`;
}

export function createGeminiImageProxyFile(input: {
  storagePath: string;
  mimeType: string;
  sizeBytes?: number | null;
  displayName: string;
  bucket?: string;
}): GeminiVisionFile {
  return {
    uri: createGeminiImageProxyUrl({
      bucket: input.bucket,
      storagePath: input.storagePath,
      mimeType: input.mimeType,
    }),
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes ?? 0,
    displayName: input.displayName,
  };
}
