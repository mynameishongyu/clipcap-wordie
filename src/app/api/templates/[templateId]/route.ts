import { NextResponse } from 'next/server';
import { getUserTemplateById } from '@/src/lib/data/templates-repository';
import { logEvent } from '@/src/lib/logging/log-event';
import { createSupabaseAdminClient } from '@/src/lib/supabase/admin';
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

export async function GET(
  _request: Request,
  context: { params: Promise<{ templateId: string }> },
) {
  const { supabase, user } = await getAuthenticatedUser();

  if (!user) {
    return createUnauthorizedResponse();
  }

  try {
    const { templateId } = await context.params;
    const template = await getUserTemplateById(supabase, user, templateId);

    if (!template) {
      return NextResponse.json(
        {
          code: 'TEMPLATE_NOT_FOUND',
          message: '未找到该模板，可能已被删除。',
        },
        { status: 404 },
      );
    }

    return NextResponse.json({
      data: template,
    });
  } catch (error) {
    return NextResponse.json(
      {
        code: 'TEMPLATE_FETCH_FAILED',
        message:
          error instanceof Error
            ? error.message
            : '读取模板详情失败，请稍后重试。',
      },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ templateId: string }> },
) {
  const { supabase, user } = await getAuthenticatedUser();

  if (!user) {
    return createUnauthorizedResponse();
  }

  try {
    const { templateId } = await context.params;
    const admin = createSupabaseAdminClient();

    const { data: template, error: templateError } = await admin
      .from('templates')
      .select('id, owner_id, template_name')
      .eq('id', templateId)
      .single();

    if (templateError || !template) {
      return NextResponse.json(
        {
          code: 'TEMPLATE_NOT_FOUND',
          message: '未找到该模板，可能已被删除。',
        },
        { status: 404 },
      );
    }

    if (template.owner_id !== user.id) {
      return createUnauthorizedResponse();
    }

    const { data: relatedTasks, error: relatedTasksError } = await admin
      .from('generation_tasks')
      .select('id')
      .eq('owner_id', user.id)
      .eq('template_id', templateId);

    if (relatedTasksError) {
      throw relatedTasksError;
    }

    const taskIds = (relatedTasks ?? []).map((task) => task.id);

    if (taskIds.length > 0) {
      const { data: relatedItems, error: relatedItemsError } = await admin
        .from('generation_task_items')
        .select('source_pdf_path, output_docx_path')
        .in('task_id', taskIds);

      if (relatedItemsError) {
        throw relatedItemsError;
      }

      const storagePaths = Array.from(
        new Set(
          (relatedItems ?? [])
            .flatMap((item) => [item.source_pdf_path, item.output_docx_path])
            .filter(
              (value): value is string =>
                typeof value === 'string' && value.trim().length > 0,
            ),
        ),
      );

      if (storagePaths.length > 0) {
        const { error: removeStorageError } = await admin.storage
          .from('generation-pdfs')
          .remove(storagePaths);

        if (removeStorageError) {
          throw removeStorageError;
        }
      }

      const { error: deleteTasksError } = await admin
        .from('generation_tasks')
        .delete()
        .eq('owner_id', user.id)
        .eq('template_id', templateId);

      if (deleteTasksError) {
        throw deleteTasksError;
      }
    }

    const { error: deleteTemplateError } = await admin
      .from('templates')
      .delete()
      .eq('id', templateId)
      .eq('owner_id', user.id);

    if (deleteTemplateError) {
      throw deleteTemplateError;
    }

    await logEvent({
      ownerId: user.id,
      actorEmail: user.email ?? null,
      level: 'info',
      eventType: 'template_deleted',
      message: 'Template and related resources deleted.',
      route: '/api/templates/[templateId]',
      templateId,
      payload: {
        templateName: template.template_name ?? null,
        relatedTaskCount: taskIds.length,
      },
    });

    return NextResponse.json({
      data: {
        id: templateId,
      },
    });
  } catch (error) {
    await logEvent({
      ownerId: user.id,
      actorEmail: user.email ?? null,
      level: 'error',
      eventType: 'template_delete_failed',
      message: error instanceof Error ? error.message : 'Failed to delete template.',
      route: '/api/templates/[templateId]',
      templateId: (await context.params).templateId,
    });

    return NextResponse.json(
      {
        code: 'TEMPLATE_DELETE_FAILED',
        message:
          error instanceof Error
            ? error.message
            : '删除模板失败，请稍后重试。',
      },
      { status: 500 },
    );
  }
}
