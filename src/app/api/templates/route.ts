import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { saveTemplateRequestSchema } from '@/src/app/api/types/template-library';
import {
  listUserTemplates,
  saveUserTemplate,
} from '@/src/lib/data/templates-repository';
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
    const templates = await listUserTemplates(supabase, user);

    return NextResponse.json({
      data: templates,
    });
  } catch (error) {
    return NextResponse.json(
      {
        code: 'TEMPLATE_LIST_FAILED',
        message:
          error instanceof Error
            ? error.message
            : '读取模板列表失败，请稍后重试。',
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const { supabase, user } = await getAuthenticatedUser();

  if (!user) {
    return createUnauthorizedResponse();
  }

  try {
    const input = saveTemplateRequestSchema.parse(await request.json());
    const savedTemplate = await saveUserTemplate(supabase, user, {
      templateId: input.templateId,
      templateName: input.templateName,
      slotReviewPayload: input.slotReviewPayload,
      slotPreview: input.slotPreview,
    });

    return NextResponse.json({
      data: savedTemplate,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        {
          code: 'INVALID_TEMPLATE_SAVE_REQUEST',
          message: error.issues[0]?.message ?? '模板保存参数不完整。',
        },
        { status: 400 },
      );
    }

    return NextResponse.json(
      {
        code: 'TEMPLATE_SAVE_FAILED',
        message:
          error instanceof Error
            ? error.message
            : '模板保存失败，请稍后重试。',
      },
      { status: 400 },
    );
  }
}
