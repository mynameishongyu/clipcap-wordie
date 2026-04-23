import 'server-only';

import { createSupabaseAdminClient } from '@/src/lib/supabase/admin';

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

export async function logEvent(input: LogEventInput): Promise<LogEventResult> {
  try {
    const supabase = createSupabaseAdminClient();
    const { error } = await supabase.from('app_logs').insert({
      owner_id: input.ownerId ?? null,
      actor_email: input.actorEmail ?? null,
      level: input.level ?? 'info',
      event_type: input.eventType,
      message: input.message,
      route: input.route ?? null,
      template_id: input.templateId ?? null,
      task_id: input.taskId ?? null,
      task_item_id: input.taskItemId ?? null,
      payload: input.payload ?? {},
    });

    if (error) {
      console.error('Failed to write app log', {
        eventType: input.eventType,
        message: input.message,
        error,
      });

      return {
        ok: false,
        error: new Error(error.message),
      };
    }

    return { ok: true };
  } catch (error) {
    console.error('Unexpected app log failure', {
      eventType: input.eventType,
      message: input.message,
      error,
    });

    return {
      ok: false,
      error: error instanceof Error ? error : new Error('Unknown logEvent failure'),
    };
  }
}
