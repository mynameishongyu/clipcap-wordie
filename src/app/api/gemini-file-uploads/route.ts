import { NextResponse } from 'next/server';
import {
  cleanupGeminiUploadedFiles,
  getGeminiFilePipelineConcurrency,
  summarizeCleanupResults,
  uploadGeminiFileStream,
  type UploadedGeminiFile,
} from '@/src/lib/llm/gemini-file-api';
import { getLlmRuntimeConfig } from '@/src/lib/llm/provider';
import { createSupabaseServerClient } from '@/src/lib/supabase/server';

export const runtime = 'nodejs';
export const maxDuration = 300;

function createUnauthorizedResponse() {
  return NextResponse.json(
    {
      code: 'UNAUTHORIZED',
      message: 'Please sign in before continuing.',
    },
    { status: 401 },
  );
}

async function getAuthenticatedUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return user;
}

function parsePositiveHeaderNumber(value: string | null) {
  if (!value) {
    return null;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getDisplayName(request: Request) {
  const rawValue = request.headers.get('x-display-name')?.trim();

  if (!rawValue) {
    return `browser-pdf-page-${crypto.randomUUID()}`;
  }

  return rawValue.slice(0, 200);
}

function normalizeCleanupFile(value: unknown): UploadedGeminiFile | null {
  const record =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
  const uri = String(record.uri ?? '').trim();
  const name = String(record.name ?? '').trim();
  const mimeType = String(
    record.mimeType ?? record.mime_type ?? 'application/octet-stream',
  ).trim();
  const sizeBytes = Number(record.sizeBytes ?? record.size_bytes ?? 0);
  const displayName = String(
    record.displayName ?? record.display_name ?? name ?? uri,
  ).trim();

  if (!uri || !name) {
    return null;
  }

  return {
    uri,
    name,
    mimeType: mimeType || 'application/octet-stream',
    sizeBytes: Number.isFinite(sizeBytes) ? Math.max(0, sizeBytes) : 0,
    displayName: displayName || name || uri,
  };
}

export async function GET() {
  const user = await getAuthenticatedUser();

  if (!user) {
    return createUnauthorizedResponse();
  }

  const llmConfig = getLlmRuntimeConfig('vision');

  return NextResponse.json({
    data: {
      provider: llmConfig.provider,
      model: llmConfig.model,
      enabled: llmConfig.provider === 'gemini',
      concurrency: getGeminiFilePipelineConcurrency(),
    },
  });
}

export async function POST(request: Request) {
  const user = await getAuthenticatedUser();

  if (!user) {
    return createUnauthorizedResponse();
  }

  const llmConfig = getLlmRuntimeConfig('vision');

  if (llmConfig.provider !== 'gemini') {
    return NextResponse.json(
      {
        code: 'GEMINI_FILE_UPLOAD_DISABLED',
        message:
          'Current VISION_LLM provider is not Gemini, so Gemini File API upload is disabled.',
      },
      { status: 400 },
    );
  }

  const stream = request.body;

  if (!stream) {
    return NextResponse.json(
      {
        code: 'GEMINI_FILE_UPLOAD_EMPTY_BODY',
        message: 'Upload body is empty.',
      },
      { status: 400 },
    );
  }

  const mimeType =
    request.headers.get('content-type')?.split(';')[0]?.trim() ??
    'application/octet-stream';
  const sizeBytes =
    parsePositiveHeaderNumber(request.headers.get('x-file-size')) ??
    parsePositiveHeaderNumber(request.headers.get('content-length'));
  const displayName = getDisplayName(request);
  const startedAt = Date.now();

  if (!sizeBytes) {
    return NextResponse.json(
      {
        code: 'GEMINI_FILE_UPLOAD_SIZE_REQUIRED',
        message:
          'Missing x-file-size header; Gemini File API resumable upload cannot start.',
      },
      { status: 400 },
    );
  }

  console.info(
    `[Gemini File API][BrowserUploadStart] ${JSON.stringify({
      display_name: displayName,
      mime_type: mimeType,
      size_bytes: sizeBytes,
      model: llmConfig.model,
    })}`,
  );

  try {
    const file = await uploadGeminiFileStream({
      config: llmConfig,
      stream,
      sizeBytes,
      mimeType,
      displayName,
      signal: request.signal,
    });
    const durationMs = Date.now() - startedAt;

    console.info(
      `[Gemini File API][BrowserUploadComplete] ${JSON.stringify({
        display_name: displayName,
        file_name: file.name ?? null,
        file_uri: file.uri,
        mime_type: file.mimeType,
        size_bytes: file.sizeBytes,
        duration_ms: durationMs,
      })}`,
    );

    return NextResponse.json({
      data: {
        file: {
          uri: file.uri,
          name: file.name ?? null,
          mime_type: file.mimeType,
          size_bytes: file.sizeBytes,
          display_name: file.displayName,
          uploaded_at: new Date().toISOString(),
        },
      },
    });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);

    console.warn(
      `[Gemini File API][BrowserUploadFailed] ${JSON.stringify({
        display_name: displayName,
        mime_type: mimeType,
        size_bytes: sizeBytes,
        duration_ms: durationMs,
        error_message: message,
      })}`,
    );

    return NextResponse.json(
      {
        code: 'GEMINI_FILE_UPLOAD_FAILED',
        message,
      },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  const user = await getAuthenticatedUser();

  if (!user) {
    return createUnauthorizedResponse();
  }

  const llmConfig = getLlmRuntimeConfig('vision');
  const body = (await request.json().catch(() => null)) as {
    files?: unknown[];
  } | null;
  const files = Array.isArray(body?.files)
    ? body.files
        .map(normalizeCleanupFile)
        .filter((file): file is UploadedGeminiFile => Boolean(file))
    : [];

  if (files.length === 0) {
    return NextResponse.json({
      data: {
        cleanup_results: [],
      },
    });
  }

  const cleanupResults = await cleanupGeminiUploadedFiles({
    config: llmConfig,
    files,
  });

  return NextResponse.json({
    data: {
      cleanup_results: summarizeCleanupResults(cleanupResults),
    },
  });
}
