'use client';

type BrowserRunLogLevel = 'log' | 'info' | 'warn' | 'error';

type BrowserRunLogEntry = {
  ts: string;
  level: BrowserRunLogLevel;
  scope: string;
  message: string;
  args: unknown[];
  url: string;
};

type BrowserRunLoggerOptions = {
  scope: string;
  taskId?: string | null;
  meta?: Record<string, unknown>;
  flushIntervalMs?: number;
  maxBufferedEntries?: number;
};

type ConsoleMethod = (...args: unknown[]) => void;

const MAX_SERIALIZE_DEPTH = 5;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_MAX_BUFFERED_ENTRIES = 80;
const MAX_SERIALIZED_STRING_LENGTH = 2000;

function redactStringForBrowserLog(value: string) {
  if (/^data:image\//i.test(value)) {
    return `[Image data URL omitted, length=${value.length}]`;
  }

  if (value.length > MAX_SERIALIZED_STRING_LENGTH) {
    return `${value.slice(0, MAX_SERIALIZED_STRING_LENGTH)}...[truncated ${value.length - MAX_SERIALIZED_STRING_LENGTH} chars]`;
  }

  return value;
}

function isSensitiveLogKey(key: string) {
  const normalizedKey = key.toLowerCase();
  return (
    normalizedKey.includes('apikey') ||
    normalizedKey.includes('api_key') ||
    normalizedKey.includes('authorization') ||
    normalizedKey.includes('bearer') ||
    normalizedKey.includes('cookie') ||
    normalizedKey.includes('password') ||
    normalizedKey.includes('secret') ||
    normalizedKey.includes('token')
  );
}

function serializeForBrowserLog(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || typeof value === 'undefined') {
    return value;
  }

  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    if (typeof value === 'string') {
      return redactStringForBrowserLog(value);
    }

    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'symbol' || typeof value === 'function') {
    return String(value);
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack ?? null,
    };
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (depth >= MAX_SERIALIZE_DEPTH) {
    return '[Max serialization depth reached]';
  }

  if (typeof value !== 'object') {
    return String(value);
  }

  if (seen.has(value)) {
    return '[Circular reference]';
  }

  seen.add(value);

  if (Array.isArray(value)) {
    const output = value.map((item) =>
      serializeForBrowserLog(item, depth + 1, seen),
    );
    seen.delete(value);
    return output;
  }

  if (value instanceof Blob) {
    seen.delete(value);
    return {
      constructorName: value.constructor.name,
      size: value.size,
      type: value.type,
    };
  }

  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {
    constructorName: value.constructor?.name ?? null,
  };

  Object.keys(record).forEach((key) => {
    try {
      if (isSensitiveLogKey(key)) {
        output[key] = '[Redacted]';
        return;
      }

      output[key] = serializeForBrowserLog(record[key], depth + 1, seen);
    } catch (error) {
      output[key] =
        error instanceof Error
          ? `[Failed to serialize: ${error.message}]`
          : '[Failed to serialize]';
    }
  });

  seen.delete(value);
  return output;
}

function stringifyMessage(args: unknown[]) {
  return args
    .map((arg) => {
      if (typeof arg === 'string') {
        return redactStringForBrowserLog(arg);
      }

      if (arg instanceof Error) {
        return `${arg.name}: ${arg.message}`;
      }

      try {
        return JSON.stringify(serializeForBrowserLog(arg));
      } catch {
        return String(arg);
      }
    })
    .join(' ');
}

class BrowserRunLogger {
  private readonly scope: string;
  private readonly sessionId: string;
  private readonly meta: Record<string, unknown>;
  private readonly flushIntervalMs: number;
  private readonly maxBufferedEntries: number;
  private taskId: string | null;
  private buffer: BrowserRunLogEntry[] = [];
  private sequence = 0;
  private flushTimer: number | null = null;
  private started = false;
  private finalFlushed = false;
  private originals: Record<BrowserRunLogLevel, ConsoleMethod> | null = null;

  constructor(options: BrowserRunLoggerOptions) {
    this.scope = options.scope;
    this.taskId = options.taskId ?? null;
    this.meta = options.meta ?? {};
    this.flushIntervalMs =
      options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxBufferedEntries =
      options.maxBufferedEntries ?? DEFAULT_MAX_BUFFERED_ENTRIES;
    this.sessionId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  start() {
    if (this.started) {
      return;
    }

    this.started = true;
    this.originals = {
      log: console.log.bind(console),
      info: console.info.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
    };

    (['log', 'info', 'warn', 'error'] as const).forEach((level) => {
      console[level] = (...args: unknown[]) => {
        this.originals?.[level]?.(...args);
        this.enqueue(level, args);
      };
    });

    this.enqueue('info', [
      '[Browser Log Storage] Browser run logger started',
      {
        scope: this.scope,
        sessionId: this.sessionId,
        taskId: this.taskId,
        meta: this.meta,
      },
    ]);
  }

  setTaskId(taskId: string | null) {
    if (this.taskId === taskId) {
      return;
    }

    this.taskId = taskId;
    this.enqueue('info', [
      '[Browser Log Storage] Task id updated',
      { taskId: this.taskId },
    ]);
    void this.flush();
  }

  async finalize() {
    if (this.finalFlushed) {
      return;
    }

    this.finalFlushed = true;
    this.enqueue('info', [
      '[Browser Log Storage] Browser run logger finalizing',
      { taskId: this.taskId, sessionId: this.sessionId },
    ]);
    await this.flush({ final: true });
  }

  stop() {
    if (this.flushTimer !== null) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.originals) {
      console.log = this.originals.log as typeof console.log;
      console.info = this.originals.info as typeof console.info;
      console.warn = this.originals.warn as typeof console.warn;
      console.error = this.originals.error as typeof console.error;
    }

    this.started = false;
  }

  private enqueue(level: BrowserRunLogLevel, args: unknown[]) {
    const firstArg = args[0];

    if (
      typeof firstArg === 'string' &&
      firstArg.startsWith('[Browser Log Storage]')
    ) {
      return;
    }

    this.buffer.push({
      ts: new Date().toISOString(),
      level,
      scope: this.scope,
      message: stringifyMessage(args),
      args: args.map((arg) => serializeForBrowserLog(arg)),
      url: window.location.href,
    });

    if (this.buffer.length >= this.maxBufferedEntries) {
      void this.flush();
      return;
    }

    this.scheduleFlush();
  }

  private scheduleFlush() {
    if (this.flushTimer !== null) {
      return;
    }

    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.flushIntervalMs);
  }

  private async flush(options?: { final?: boolean }) {
    if (this.flushTimer !== null) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.buffer.length === 0) {
      return;
    }

    const entries = this.buffer.splice(0, this.buffer.length);
    const currentSequence = this.sequence;
    this.sequence += 1;

    try {
      const response = await fetch(
        '/api/browser-logs',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            sessionId: this.sessionId,
            sequence: currentSequence,
            final: Boolean(options?.final),
            taskId: this.taskId,
            meta: this.meta,
            entries,
          }),
          keepalive: Boolean(options?.final),
        },
      );

      if (!response.ok) {
        const details = await response.text().catch(() => '');
        throw new Error(
          `Browser log upload failed (${response.status}): ${details}`,
        );
      }
    } catch (error) {
      this.buffer.unshift(...entries);
      this.originals?.warn?.('[Browser Log Storage] Flush failed', error);
    }
  }
}

export function createBrowserRunLogger(options: BrowserRunLoggerOptions) {
  return new BrowserRunLogger(options);
}

export type BrowserRunLoggerInstance = BrowserRunLogger;
