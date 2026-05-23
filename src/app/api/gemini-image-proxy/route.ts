import { NextResponse } from 'next/server';
import { verifyGeminiImageProxyToken } from '@/src/lib/gemini/image-proxy';
import { createSupabaseAdminClient } from '@/src/lib/supabase/admin';
import { getSupabaseSignedUrlExpiresInSeconds } from '@/src/lib/supabase/signed-url';

export const runtime = 'nodejs';
export const maxDuration = 60;

async function handleGeminiImageProxyRequest(request: Request) {
  try {
    const token = new URL(request.url).searchParams.get('token') ?? '';
    const payload = verifyGeminiImageProxyToken(token);
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase.storage
      .from(payload.bucket)
      .createSignedUrl(payload.storagePath, getSupabaseSignedUrlExpiresInSeconds());

    if (error || !data?.signedUrl) {
      return NextResponse.json(
        {
          code: 'GEMINI_IMAGE_PROXY_SIGN_FAILED',
          message: error?.message ?? 'Unable to create storage signed URL.',
        },
        { status: 404 },
      );
    }

    const upstreamHeaders = new Headers();
    const range = request.headers.get('range');

    if (range) {
      upstreamHeaders.set('range', range);
    }

    const upstream = await fetch(data.signedUrl, {
      method: request.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: upstreamHeaders,
      cache: 'no-store',
    });

    if (!upstream.ok || (request.method !== 'HEAD' && !upstream.body)) {
      return NextResponse.json(
        {
          code: 'GEMINI_IMAGE_PROXY_FETCH_FAILED',
          message: `Storage fetch failed: ${upstream.status} ${upstream.statusText}`,
        },
        { status: upstream.status || 502 },
      );
    }

    const headers = new Headers();
    headers.set('Content-Type', upstream.headers.get('content-type') ?? payload.mimeType);
    headers.set('Cache-Control', 'no-store');
    headers.set('Accept-Ranges', upstream.headers.get('accept-ranges') ?? 'bytes');
    headers.set('Content-Disposition', 'inline');

    const contentLength = upstream.headers.get('content-length');
    const contentRange = upstream.headers.get('content-range');

    if (contentLength) {
      headers.set('Content-Length', contentLength);
    }

    if (contentRange) {
      headers.set('Content-Range', contentRange);
    }

    return new Response(request.method === 'HEAD' ? null : upstream.body, {
      status: upstream.status,
      headers,
    });
  } catch (error) {
    return NextResponse.json(
      {
        code: 'GEMINI_IMAGE_PROXY_INVALID_TOKEN',
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 401 },
    );
  }
}

export async function GET(request: Request) {
  return handleGeminiImageProxyRequest(request);
}

export async function HEAD(request: Request) {
  return handleGeminiImageProxyRequest(request);
}
