import { NextResponse } from 'next/server';
import { createGeminiImageProxyFile } from '@/src/lib/gemini/image-proxy';
import { callGeminiNativeChatCompletion } from '@/src/lib/llm/gemini-native';
import { buildChatCompletionBody, getLlmRuntimeConfig } from '@/src/lib/llm/provider';
import { createSupabaseServerClient } from '@/src/lib/supabase/server';

export const runtime = 'nodejs';
export const maxDuration = 120;

const DEFAULT_BUCKET = 'generation-pdfs';

function createUnauthorizedResponse() {
  return NextResponse.json(
    {
      code: 'UNAUTHORIZED',
      message: '请先登录后再继续。',
    },
    { status: 401 },
  );
}

function inferMimeType(storagePath: string) {
  const normalized = storagePath.toLowerCase();

  if (normalized.endsWith('.png')) {
    return 'image/png';
  }

  if (normalized.endsWith('.webp')) {
    return 'image/webp';
  }

  return 'image/jpeg';
}

async function inspectProxyUrl(url: string) {
  const startedAt = Date.now();
  const head = await fetch(url, {
    method: 'HEAD',
    cache: 'no-store',
  });
  const getStartedAt = Date.now();
  const get = await fetch(url, {
    method: 'GET',
    cache: 'no-store',
  });
  const body = await get.arrayBuffer();

  return {
    ok: head.ok && get.ok,
    durationMs: Date.now() - startedAt,
    head: {
      ok: head.ok,
      status: head.status,
      statusText: head.statusText,
      contentType: head.headers.get('content-type'),
      contentLength: head.headers.get('content-length'),
      acceptRanges: head.headers.get('accept-ranges'),
      durationMs: getStartedAt - startedAt,
    },
    get: {
      ok: get.ok,
      status: get.status,
      statusText: get.statusText,
      contentType: get.headers.get('content-type'),
      contentLength: get.headers.get('content-length'),
      acceptRanges: get.headers.get('accept-ranges'),
      sampledBytes: body.byteLength,
      durationMs: Date.now() - getStartedAt,
    },
  };
}

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return createUnauthorizedResponse();
  }

  const body = (await request.json().catch(() => ({}))) as {
    bucket?: string;
    storagePath?: string;
    mimeType?: string;
  };
  const storagePath = body.storagePath?.trim();
  const bucket = body.bucket?.trim() || DEFAULT_BUCKET;
  const mimeType = body.mimeType?.trim() || (storagePath ? inferMimeType(storagePath) : '');

  if (!storagePath) {
    return NextResponse.json(
      {
        code: 'MISSING_STORAGE_PATH',
        message: 'Storage path is required.',
      },
      { status: 400 },
    );
  }

  if (bucket !== DEFAULT_BUCKET) {
    return NextResponse.json(
      {
        code: 'UNSUPPORTED_BUCKET',
        message: `Only ${DEFAULT_BUCKET} is supported by the Gemini image proxy.`,
      },
      { status: 400 },
    );
  }

  if (!mimeType.startsWith('image/')) {
    return NextResponse.json(
      {
        code: 'UNSUPPORTED_MIME_TYPE',
        message: 'MIME type must be image/*.',
      },
      { status: 400 },
    );
  }

  const llmConfig = getLlmRuntimeConfig('vision');
  const proxyFile = createGeminiImageProxyFile({
    bucket,
    storagePath,
    mimeType,
    displayName: `gemini-image-proxy-test-${Date.now()}`,
  });
  const proxyFetch = await inspectProxyUrl(proxyFile.uri);
  const geminiStartedAt = Date.now();

  try {
    const requestBody = buildChatCompletionBody(llmConfig, {
      messages: [
        {
          role: 'system',
          content:
            'You are testing whether an image URL can be fetched and read. Return compact JSON only.',
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Read this image and return {"can_read_image":true,"brief_description":"..."} if visible. If not visible, return {"can_read_image":false,"brief_description":"..."}',
            },
            {
              type: 'gemini_file',
              gemini_file: proxyFile,
            },
          ],
        },
      ],
    });
    const geminiResult = await callGeminiNativeChatCompletion({
      config: llmConfig,
      body: requestBody,
      requestLabel: 'deployed gemini image proxy test',
    });
    const text = geminiResult.payload.choices?.[0]?.message?.content ?? '';

    return NextResponse.json({
      input: {
        bucket,
        storagePath,
        mimeType,
      },
      proxy: {
        url: proxyFile.uri,
        displayName: proxyFile.displayName,
      },
      proxyFetch,
      geminiFetch: {
        ok: true,
        model: llmConfig.model,
        durationMs: Date.now() - geminiStartedAt,
        responseText: text,
        responsePayload: geminiResult.responsePayload,
      },
      result: 'Proxy fetch OK, Gemini fetch OK.',
    });
  } catch (error) {
    return NextResponse.json({
      input: {
        bucket,
        storagePath,
        mimeType,
      },
      proxy: {
        url: proxyFile.uri,
        displayName: proxyFile.displayName,
      },
      proxyFetch,
      geminiFetch: {
        ok: false,
        model: llmConfig.model,
        durationMs: Date.now() - geminiStartedAt,
        errorMessage: error instanceof Error ? error.message : String(error),
      },
      result: 'Proxy fetch OK, Gemini fetch FAILED.',
    });
  }
}
