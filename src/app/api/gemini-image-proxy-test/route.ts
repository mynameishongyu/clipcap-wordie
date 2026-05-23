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
    storagePaths?: string[];
    mimeType?: string;
  };
  const storagePaths = (
    Array.isArray(body.storagePaths)
      ? body.storagePaths
      : body.storagePath
        ? body.storagePath.split(/\r?\n/)
        : []
  )
    .map((storagePath) => storagePath.trim())
    .filter(Boolean);
  const bucket = body.bucket?.trim() || DEFAULT_BUCKET;
  const mimeType =
    body.mimeType?.trim() ||
    (storagePaths[0] ? inferMimeType(storagePaths[0]) : '');

  if (storagePaths.length === 0) {
    return NextResponse.json(
      {
        code: 'MISSING_STORAGE_PATH',
        message: 'At least one storage path is required.',
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
  const proxyFiles = storagePaths.map((storagePath, index) =>
    createGeminiImageProxyFile({
      bucket,
      storagePath,
      mimeType: body.mimeType?.trim() || inferMimeType(storagePath),
      displayName: `gemini-image-proxy-test-${index + 1}-${Date.now()}`,
    }),
  );
  const proxyFetches = await Promise.all(
    proxyFiles.map(async (proxyFile, index) => ({
      index: index + 1,
      storagePath: storagePaths[index],
      proxyUrl: proxyFile.uri,
      ...(await inspectProxyUrl(proxyFile.uri)),
    })),
  );
  const geminiStartedAt = Date.now();

  try {
    const content: Array<
      | { type: 'text'; text: string }
      | {
          type: 'gemini_file';
          gemini_file: (typeof proxyFiles)[number];
        }
    > = [
      {
        type: 'text',
        text: `Read these ${proxyFiles.length} image(s). Return compact JSON with {"can_read_all_images":true,"images":[{"index":1,"can_read_image":true,"brief_description":"..."}]}. If any image is not visible, mark can_read_image false for that index.`,
      },
    ];

    proxyFiles.forEach((proxyFile, index) => {
      content.push({
        type: 'text',
        text: `Image ${index + 1}, storage_path=${storagePaths[index]}`,
      });
      content.push({
        type: 'gemini_file',
        gemini_file: proxyFile,
      });
    });

    const requestBody = buildChatCompletionBody(llmConfig, {
      messages: [
        {
          role: 'system',
          content:
            'You are testing whether image URLs can be fetched and read. Return compact JSON only.',
        },
        {
          role: 'user',
          content,
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
        storagePaths,
        mimeType,
        imageCount: proxyFiles.length,
      },
      proxies: proxyFiles.map((proxyFile, index) => ({
        index: index + 1,
        storagePath: storagePaths[index],
        url: proxyFile.uri,
        displayName: proxyFile.displayName,
        mimeType: proxyFile.mimeType,
      })),
      proxyFetches,
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
        storagePaths,
        mimeType,
        imageCount: proxyFiles.length,
      },
      proxies: proxyFiles.map((proxyFile, index) => ({
        index: index + 1,
        storagePath: storagePaths[index],
        url: proxyFile.uri,
        displayName: proxyFile.displayName,
        mimeType: proxyFile.mimeType,
      })),
      proxyFetches,
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
