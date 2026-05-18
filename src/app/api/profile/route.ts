import { NextResponse } from 'next/server';
import { getRawErrorMessage } from '@/src/lib/errors/raw-error';
import {
  getCurrentProfile,
  updateProfileRegistration,
} from '@/src/lib/data/profile-repository';
import { logErrorEvent } from '@/src/lib/logging/log-event';
import { createSupabaseServerClient } from '@/src/lib/supabase/server';

function createUnauthorizedResponse() {
  return NextResponse.json(
    {
      code: 'UNAUTHORIZED',
      message: '请先登录后再继续。',
    },
    { status: 401 },
  );
}

async function getAuthenticatedUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return { supabase, user };
}

export async function GET() {
  let ownerId: string | null = null;
  let actorEmail: string | null = null;

  try {
    const { supabase, user } = await getAuthenticatedUser();

    if (!user) {
      return createUnauthorizedResponse();
    }

    ownerId = user.id;
    actorEmail = user.email ?? null;

    const profile = await getCurrentProfile(supabase, user);

    return NextResponse.json({
      data: profile,
    });
  } catch (error) {
    await logErrorEvent({
      ownerId,
      actorEmail,
      eventType: 'profile_fetch_failed',
      error,
      route: '/api/profile',
    });

    return NextResponse.json(
      {
        code: 'PROFILE_FETCH_FAILED',
        message: getRawErrorMessage(error),
      },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request) {
  let ownerId: string | null = null;
  let actorEmail: string | null = null;

  try {
    const { supabase, user } = await getAuthenticatedUser();

    if (!user) {
      return createUnauthorizedResponse();
    }

    ownerId = user.id;
    actorEmail = user.email ?? null;

    const body = (await request.json()) as Partial<{
      displayName: string;
      organizationName: string;
      useCase: string;
    }>;

    if (
      !body.displayName?.trim() ||
      !body.organizationName?.trim() ||
      !body.useCase?.trim()
    ) {
      return NextResponse.json(
        {
          code: 'INVALID_PROFILE_REGISTRATION',
          message: '请完整填写姓名、公司或团队，以及使用场景。',
        },
        { status: 400 },
      );
    }

    const profile = await updateProfileRegistration(supabase, user, {
      displayName: body.displayName.trim(),
      organizationName: body.organizationName.trim(),
      useCase: body.useCase.trim(),
    });

    return NextResponse.json({
      data: profile,
    });
  } catch (error) {
    await logErrorEvent({
      ownerId,
      actorEmail,
      eventType: 'profile_registration_failed',
      error,
      route: '/api/profile',
    });

    return NextResponse.json(
      {
        code: 'PROFILE_REGISTRATION_FAILED',
        message: getRawErrorMessage(error),
      },
      { status: 400 },
    );
  }
}
