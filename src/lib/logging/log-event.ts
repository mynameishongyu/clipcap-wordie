import 'server-only';

import { getRawErrorMessage } from '@/src/lib/errors/raw-error';

export type AppLogLevel = 'info' | 'warning' | 'error';

export interface LogEventInput {
  ownerId?: string | null;
  actorEmail?: string | null;
  level?: AppLogLevel;
  eventType: string;
  message: string;
  route?: string | null;
  templateId?: string | null;
  taskId?: string | null;
  taskItemId?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface LogEventResult {
  ok: boolean;
  error?: Error;
}

const MAX_LOG_SERIALIZATION_DEPTH = 8;

function serializeLogValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (value === null || typeof value === 'undefined') {
    return value;
  }

  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'symbol' || typeof value === 'function') {
    return String(value);
  }

  if (depth >= MAX_LOG_SERIALIZATION_DEPTH) {
    return '[Max serialization depth reached]';
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeLogValue(item, seen, depth + 1));
  }

  if (typeof value !== 'object') {
    return String(value);
  }

  if (seen.has(value)) {
    return '[Circular reference]';
  }

  seen.add(value);

  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {
    constructorName: value.constructor?.name ?? null,
  };
  const propertyNames = new Set([
    ...Object.getOwnPropertyNames(value),
    ...Object.keys(record),
  ]);
  const symbolProperties = Object.getOwnPropertySymbols(value);

  for (const propertyName of propertyNames) {
    try {
      output[propertyName] = serializeLogValue(
        record[propertyName],
        seen,
        depth + 1,
      );
    } catch (error) {
      output[propertyName] =
        `[Failed to serialize property: ${getRawErrorMessage(error)}]`;
    }
  }

  for (const symbolProperty of symbolProperties) {
    try {
      output[symbolProperty.toString()] = serializeLogValue(
        (value as Record<symbol, unknown>)[symbolProperty],
        seen,
        depth + 1,
      );
    } catch (error) {
      output[symbolProperty.toString()] =
        `[Failed to serialize symbol property: ${getRawErrorMessage(error)}]`;
    }
  }

  seen.delete(value);

  return output;
}

function serializeErrorForLog(error: unknown) {
  return serializeLogValue(error, new WeakSet<object>(), 0);
}

function getErrorCauseMessage(error: Error) {
  const cause = (error as Error & { cause?: unknown }).cause;

  if (!cause) {
    return null;
  }

  if (typeof cause === 'string') {
    return cause;
  }

  if (cause instanceof Error) {
    return cause.message;
  }

  if (typeof cause === 'object') {
    const causeRecord = cause as Record<string, unknown>;

    if (typeof causeRecord.message === 'string') {
      return causeRecord.message;
    }
  }

  return getRawErrorMessage(cause);
}

export function buildErrorLogPayload(
  error: unknown,
  extra?: Record<string, unknown> | null,
): Record<string, unknown> {
  const serializedError = serializeErrorForLog(error);

  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    const causeRecord =
      cause && typeof cause === 'object'
        ? (cause as Record<string, unknown>)
        : null;

    return {
      errorName: error.name,
      errorMessage: error.message,
      errorStack: error.stack ?? null,
      errorCause: getErrorCauseMessage(error),
      errorCode:
        causeRecord && typeof causeRecord.code === 'string'
          ? causeRecord.code
          : null,
      errorErrno:
        causeRecord && typeof causeRecord.errno === 'number'
          ? causeRecord.errno
          : null,
      errorSyscall:
        causeRecord && typeof causeRecord.syscall === 'string'
          ? causeRecord.syscall
          : null,
      errorAddress:
        causeRecord && typeof causeRecord.address === 'string'
          ? causeRecord.address
          : null,
      errorPort:
        causeRecord && typeof causeRecord.port === 'number'
          ? causeRecord.port
          : null,
      errorRawString: String(error),
      errorSerialized: serializedError,
      ...(extra ?? {}),
    };
  }

  return {
    errorName: 'UnknownError',
    errorMessage:
      typeof error === 'string'
        ? error
        : error && typeof error === 'object'
          ? JSON.stringify(error)
          : String(error),
    errorStack: null,
    errorRawString: String(error),
    errorSerialized: serializedError,
    ...(extra ?? {}),
  };
}

export async function logErrorEvent(
  input: Omit<LogEventInput, 'level' | 'message' | 'payload'> & {
    error: unknown;
    message?: string;
    payload?: Record<string, unknown> | null;
  },
): Promise<LogEventResult> {
  return logEvent({
    ...input,
    level: 'error',
    message: input.message ?? getRawErrorMessage(input.error),
    payload: buildErrorLogPayload(input.error, input.payload),
  });
}

export async function logEvent(input: LogEventInput): Promise<LogEventResult> {
  // debugger;
  try {
    const consoleMethod =
      input.level === 'error'
        ? console.error
        : input.level === 'warning'
          ? console.warn
          : console.info;

    consoleMethod('[App Log Disabled]', {
      ownerId: input.ownerId ?? null,
      actorEmail: input.actorEmail ?? null,
      level: input.level ?? 'info',
      eventType: input.eventType,
      message: input.message,
      route: input.route ?? null,
      templateId: input.templateId ?? null,
      taskId: input.taskId ?? null,
      taskItemId: input.taskItemId ?? null,
      payload: input.payload ?? {},
    });
    return { ok: true };
  } catch (error) {
    console.error('Unexpected disabled app log failure', {
      eventType: input.eventType,
      message: input.message,
      error,
    });

    return {
      ok: false,
      error:
        error instanceof Error ? error : new Error(getRawErrorMessage(error)),
    };
  }
}
