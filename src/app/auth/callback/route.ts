import { NextResponse } from 'next/server';
import { logErrorEvent } from '@/src/lib/logging/log-event';
import { createSupabaseServerClient } from '@/src/lib/supabase/server';

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get('code');
  const next = requestUrl.searchParams.get('next') ?? '/home';
  const completeUrl = new URL('/auth/complete', requestUrl.origin);
  completeUrl.searchParams.set('next', next);

  try {
    if (code) {
      const supabase = await createSupabaseServerClient();
      await supabase.auth.exchangeCodeForSession(code);
    }
  } catch (error) {
    await logErrorEvent({
      actorEmail: null,
      eventType: 'auth_callback_exchange_failed',
      error,
      route: '/auth/callback',
      payload: {
        next,
        hasCode: Boolean(code),
      },
    });

    completeUrl.searchParams.set('auth_error', 'callback_exchange_failed');
  }

  return NextResponse.redirect(completeUrl);
}
