import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '@/src/lib/supabase/admin';
import { createSupabaseServerClient } from '@/src/lib/supabase/server';

export const runtime = 'nodejs';
export const maxDuration = 60;

type BrowserRunLogEntry = {
  ts?: string;
  level?: string;
  scope?: string;
  message?: string;
  args?: unknown[];
  url?: string;
};

type BrowserRunLogRequestBody = {
  sessionId?: string;
  sequence?: number;
  final?: boolean;
  taskId?: string | null;
  meta?: Record<string, unknown>;
  entries?: BrowserRunLogEntry[];
};

const MAX_LOG_ENTRIES_PER_REQUEST = 500;
const MAX_SESSION_ID_LENGTH = 100;

function formatBrowserLogStorageTimestamp(date: Date) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const partMap = new Map(parts.map((part) => [part.type, part.value]));

  return `${partMap.get('year')}-${partMap.get('month')}-${partMap.get(
    'day',
  )}_${partMap.get('hour')}-${partMap.get('minute')}-${partMap.get('second')}`;
}

function createBrowserLogStorageFileName(params: {
  final: boolean;
  sequence: number;
}) {
  const prefix = params.final ? 'final' : 'part';
  const sequenceText = String(params.sequence).padStart(5, '0');
  const randomSuffix = crypto.randomUUID().slice(0, 8);

  return `${formatBrowserLogStorageTimestamp(
    new Date(),
  )}_${prefix}-${sequenceText}_${randomSuffix}.jsonl`;
}

function createUnauthorizedResponse() {
  return NextResponse.json(
    {
      code: 'UNAUTHORIZED',
      message: '请先登录后再继续。',
    },
    { status: 401 },
  );
}

function sanitizePathSegment(value: string, fallback: string) {
  const sanitized = value
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, MAX_SESSION_ID_LENGTH);

  return sanitized || fallback;
}

function normalizeLogEntries(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .slice(0, MAX_LOG_ENTRIES_PER_REQUEST)
    .filter((entry): entry is BrowserRunLogEntry => {
      if (!entry || typeof entry !== 'object') {
        return false;
      }

      const candidate = entry as BrowserRunLogEntry;
      return typeof candidate.message === 'string';
    })
    .map((entry) => ({
      ts: typeof entry.ts === 'string' ? entry.ts : new Date().toISOString(),
      level: typeof entry.level === 'string' ? entry.level : 'log',
      scope: typeof entry.scope === 'string' ? entry.scope : 'browser',
      message: entry.message ?? '',
      args: Array.isArray(entry.args) ? entry.args : [],
      url: typeof entry.url === 'string' ? entry.url : null,
    }));
}

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return createUnauthorizedResponse();
  }

  try {
    const body = (await request.json()) as BrowserRunLogRequestBody;
    const entries = normalizeLogEntries(body.entries);

    if (entries.length === 0) {
      return NextResponse.json(
        {
          code: 'BROWSER_LOG_EMPTY',
          message: '浏览器日志内容为空。',
        },
        { status: 400 },
      );
    }

    const taskId =
      typeof body.taskId === 'string' && body.taskId.trim()
        ? body.taskId.trim()
        : null;

    if (taskId) {
      const { data: task, error: taskError } = await supabase
        .from('generation_tasks')
        .select('id, owner_id')
        .eq('id', taskId)
        .single();

      if (taskError || !task || task.owner_id !== user.id) {
        return createUnauthorizedResponse();
      }
    }

    const admin = createSupabaseAdminClient();
    const sessionId = sanitizePathSegment(
      typeof body.sessionId === 'string' ? body.sessionId : '',
      'session',
    );
    const sequence =
      typeof body.sequence === 'number' && Number.isInteger(body.sequence)
        ? body.sequence
        : 0;
    const storageScope = taskId ? taskId : 'global';
    const storageFileName = createBrowserLogStorageFileName({
      final: Boolean(body.final),
      sequence,
    });
    const storagePath = `${user.id}/browser-logs/${storageScope}/${sessionId}/${storageFileName}`;
    const jsonl = entries
      .map((entry) =>
        JSON.stringify({
          ...entry,
          taskId,
          sessionId,
          meta: body.meta ?? {},
          uploadedAt: new Date().toISOString(),
          final: Boolean(body.final),
        }),
      )
      .join('\n');
    const { error: uploadError } = await admin.storage
      .from('generation-pdfs')
      .upload(storagePath, new Blob([jsonl], { type: 'text/plain' }), {
        contentType: 'text/plain; charset=utf-8',
        upsert: false,
      });

    if (uploadError) {
      return NextResponse.json(
        {
          code: 'BROWSER_LOG_UPLOAD_FAILED',
          message: uploadError.message,
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      ok: true,
      data: {
        storagePath,
        entryCount: entries.length,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        code: 'BROWSER_LOG_WRITE_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
