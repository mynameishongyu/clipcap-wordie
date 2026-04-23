import { NextResponse } from 'next/server';
import {
  getCurrentProfile,
  updateProfileRegistration,
} from '@/src/lib/data/profile-repository';
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
  const { supabase, user } = await getAuthenticatedUser();

  if (!user) {
    return createUnauthorizedResponse();
  }

  try {
    const profile = await getCurrentProfile(supabase, user);

    return NextResponse.json({
      data: profile,
    });
  } catch (error) {
    return NextResponse.json(
      {
        code: 'PROFILE_FETCH_FAILED',
        message: error instanceof Error ? error.message : '读取资料失败，请稍后重试。',
      },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request) {
  const { supabase, user } = await getAuthenticatedUser();

  if (!user) {
    return createUnauthorizedResponse();
  }

  const body = (await request.json()) as Partial<{
    email: string;
    displayName: string;
    organizationName: string;
    useCase: string;
  }>;

  if (
    !body.email?.trim() ||
    !body.displayName?.trim() ||
    !body.organizationName?.trim() ||
    !body.useCase?.trim()
  ) {
    return NextResponse.json(
      {
        code: 'INVALID_PROFILE_REGISTRATION',
        message: '请完整填写联系邮箱、姓名、公司或团队，以及使用场景。',
      },
      { status: 400 },
    );
  }

  try {
    const profile = await updateProfileRegistration(supabase, user, {
      email: body.email.trim(),
      displayName: body.displayName.trim(),
      organizationName: body.organizationName.trim(),
      useCase: body.useCase.trim(),
    });

    return NextResponse.json({
      data: profile,
    });
  } catch (error) {
    return NextResponse.json(
      {
        code: 'PROFILE_REGISTRATION_FAILED',
        message: error instanceof Error ? error.message : '资料保存失败，请稍后重试。',
      },
      { status: 400 },
    );
  }
}
