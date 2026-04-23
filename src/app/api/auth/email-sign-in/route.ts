import { NextResponse } from 'next/server';
import { logEvent } from '@/src/lib/logging/log-event';
import { createSupabaseAdminClient } from '@/src/lib/supabase/admin';
import { isTurnstileEnabled } from '@/src/lib/turnstile/env';
import { verifyTurnstileToken } from '@/src/lib/turnstile/verify-turnstile-token';

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Partial<{
      email: string;
      redirectTo: string;
      turnstileToken: string;
    }>;

    if (!body.email?.trim()) {
      return NextResponse.json(
        {
          code: 'EMAIL_REQUIRED',
          message: '请先输入邮箱地址。',
        },
        { status: 400 },
      );
    }

    if (isTurnstileEnabled()) {
      if (!body.turnstileToken?.trim()) {
        return NextResponse.json(
          {
            code: 'TURNSTILE_REQUIRED',
            message: '请先完成 Cloudflare 人机验证。',
          },
          { status: 400 },
        );
      }

      const turnstile = await verifyTurnstileToken(body.turnstileToken.trim());

      if (!turnstile.success) {
        return NextResponse.json(
          {
            code: 'TURNSTILE_FAILED',
            message: 'Cloudflare 验证失败，请刷新后重试。',
            data: turnstile['error-codes'] ?? [],
          },
          { status: 400 },
        );
      }
    }

    const supabase = createSupabaseAdminClient();
    const { error } = await supabase.auth.signInWithOtp({
      email: body.email.trim(),
      options: {
        emailRedirectTo: body.redirectTo,
      },
    });

    if (error) {
      await logEvent({
        actorEmail: body.email.trim().toLowerCase(),
        level: 'error',
        eventType: 'auth_email_sign_in_failed',
        message: error.message,
        route: '/api/auth/email-sign-in',
        payload: {
          redirectTo: body.redirectTo ?? null,
        },
      });

      return NextResponse.json(
        {
          code: 'EMAIL_SIGN_IN_FAILED',
          message: error.message,
        },
        { status: 400 },
      );
    }

    await logEvent({
      actorEmail: body.email.trim().toLowerCase(),
      level: 'info',
      eventType: 'auth_email_sign_in_requested',
      message: 'Email sign-in link sent successfully.',
      route: '/api/auth/email-sign-in',
      payload: {
        redirectTo: body.redirectTo ?? null,
      },
    });

    return NextResponse.json({
      data: {
        ok: true,
      },
    });
  } catch (error) {
    await logEvent({
      actorEmail: null,
      level: 'error',
      eventType: 'auth_email_sign_in_unexpected',
      message: error instanceof Error ? error.message : 'Unexpected email sign-in failure.',
      route: '/api/auth/email-sign-in',
    });

    return NextResponse.json(
      {
        code: 'EMAIL_SIGN_IN_UNEXPECTED',
        message: error instanceof Error ? error.message : '发送登录邮件失败，请稍后重试。',
      },
      { status: 500 },
    );
  }
}
