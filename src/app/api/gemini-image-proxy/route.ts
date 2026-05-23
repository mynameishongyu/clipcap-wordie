import { NextResponse } from 'next/server';
import { verifyGeminiImageProxyToken } from '@/src/lib/gemini/image-proxy';
import { createSupabaseAdminClient } from '@/src/lib/supabase/admin';
import { getSupabaseSignedUrlExpiresInSeconds } from '@/src/lib/supabase/signed-url';

export const runtime = 'nodejs';
export const maxDuration = 60;

function getHeaderSnapshot(request: Request) {
  return {
    range: request.headers.get('range'),
    user_agent: request.headers.get('user-agent'),
    accept: request.headers.get('accept'),
    accept_encoding: request.headers.get('accept-encoding'),
    cf_connecting_ip: request.headers.get('cf-connecting-ip'),
    x_forwarded_for: request.headers.get('x-forwarded-for'),
  };
}

function logProxyEvent(
  eventName: 'RequestComplete' | 'RequestFailed' | 'InvalidToken',
  details: Record<string, unknown>,
) {
  const logger = eventName === 'RequestComplete' ? console.info : console.warn;

  logger(`[Gemini Image Proxy][${eventName}] ${JSON.stringify(details)}`);
}

async function handleGeminiImageProxyRequest(request: Request) {
  const requestStartedAt = Date.now();
  const requestUrl = new URL(request.url);
  const requestId =
    request.headers.get('x-vercel-id') ??
    request.headers.get('x-request-id') ??
    crypto.randomUUID();

  try {
    const token = requestUrl.searchParams.get('token') ?? '';
    const payload = verifyGeminiImageProxyToken(token);
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase.storage
      .from(payload.bucket)
      .createSignedUrl(payload.storagePath, getSupabaseSignedUrlExpiresInSeconds());

    if (error || !data?.signedUrl) {
      logProxyEvent('RequestFailed', {
        request_id: requestId,
        method: request.method,
        host: requestUrl.host,
        pathname: requestUrl.pathname,
        bucket: payload.bucket,
        storage_path: payload.storagePath,
        mime_type: payload.mimeType,
        token_expires_at_unix: payload.exp,
        failure_stage: 'create_supabase_signed_url',
        status: 404,
        error_message: error?.message ?? 'Unable to create storage signed URL.',
        duration_ms: Date.now() - requestStartedAt,
        request_headers: getHeaderSnapshot(request),
      });
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
      logProxyEvent('RequestFailed', {
        request_id: requestId,
        method: request.method,
        host: requestUrl.host,
        pathname: requestUrl.pathname,
        bucket: payload.bucket,
        storage_path: payload.storagePath,
        mime_type: payload.mimeType,
        token_expires_at_unix: payload.exp,
        failure_stage: 'fetch_supabase_signed_url',
        upstream_status: upstream.status,
        upstream_status_text: upstream.statusText,
        upstream_content_type: upstream.headers.get('content-type'),
        upstream_content_length: upstream.headers.get('content-length'),
        upstream_content_range: upstream.headers.get('content-range'),
        upstream_accept_ranges: upstream.headers.get('accept-ranges'),
        duration_ms: Date.now() - requestStartedAt,
        request_headers: getHeaderSnapshot(request),
      });
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

    logProxyEvent('RequestComplete', {
      request_id: requestId,
      method: request.method,
      host: requestUrl.host,
      pathname: requestUrl.pathname,
      bucket: payload.bucket,
      storage_path: payload.storagePath,
      mime_type: payload.mimeType,
      token_expires_at_unix: payload.exp,
      response_status: upstream.status,
      upstream_status_text: upstream.statusText,
      upstream_content_type: upstream.headers.get('content-type'),
      response_content_type: headers.get('content-type'),
      upstream_content_length: contentLength,
      response_content_length: headers.get('content-length'),
      upstream_content_range: contentRange,
      response_content_range: headers.get('content-range'),
      upstream_accept_ranges: upstream.headers.get('accept-ranges'),
      response_accept_ranges: headers.get('accept-ranges'),
      duration_ms: Date.now() - requestStartedAt,
      request_headers: getHeaderSnapshot(request),
    });

    return new Response(request.method === 'HEAD' ? null : upstream.body, {
      status: upstream.status,
      headers,
    });
  } catch (error) {
    logProxyEvent('InvalidToken', {
      request_id: requestId,
      method: request.method,
      host: requestUrl.host,
      pathname: requestUrl.pathname,
      status: 401,
      error_message: error instanceof Error ? error.message : String(error),
      duration_ms: Date.now() - requestStartedAt,
      request_headers: getHeaderSnapshot(request),
    });
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
