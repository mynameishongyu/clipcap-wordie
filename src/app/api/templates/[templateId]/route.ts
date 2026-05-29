import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createUnauthorizedResponse } from '@/src/lib/api/responses';
import { getUserTemplateById } from '@/src/lib/data/templates-repository';
import { logEvent } from '@/src/lib/logging/log-event';
import { createSupabaseAdminClient } from '@/src/lib/supabase/admin';
import { createSupabaseServerClient } from '@/src/lib/supabase/server';

type StorageBucket = ReturnType<SupabaseClient['storage']['from']>;
type StorageListEntry = {
  id?: string | null;
  name: string;
  metadata?: unknown | null;
};


async function getAuthenticatedUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return { supabase, user };
}

function isStorageFolder(entry: StorageListEntry) {
  return !entry.id && entry.metadata === null;
}

async function listStorageObjectPathsByPrefix(
  bucket: StorageBucket,
  prefix: string,
) {
  const normalizedPrefix = prefix.replace(/\/+$/, '');
  const paths: string[] = [];

  async function visit(folderPath: string) {
    const limit = 100;
    let offset = 0;

    while (true) {
      const { data, error } = await bucket.list(folderPath, {
        limit,
        offset,
        sortBy: {
          column: 'name',
          order: 'asc',
        },
      });

      if (error) {
        throw error;
      }

      const entries = (data ?? []) as StorageListEntry[];

      for (const entry of entries) {
        const entryPath = `${folderPath}/${entry.name}`;

        if (isStorageFolder(entry)) {
          await visit(entryPath);
        } else {
          paths.push(entryPath);
        }
      }

      if (entries.length < limit) {
        break;
      }

      offset += limit;
    }
  }

  await visit(normalizedPrefix);

  return paths;
}

async function removeTemplateReferencePageStorage(input: {
  admin: SupabaseClient;
  ownerId: string;
  templateId: string;
}) {
  const bucket = input.admin.storage.from('generation-pdfs');
  const prefixes = [
    `${input.ownerId}/template-reference-pages/original/${input.templateId}`,
    `${input.ownerId}/template-reference-pages/annotated/${input.templateId}`,
  ];
  const storagePaths = Array.from(
    new Set(
      (
        await Promise.all(
          prefixes.map((prefix) => listStorageObjectPathsByPrefix(bucket, prefix)),
        )
      ).flat(),
    ),
  );

  if (storagePaths.length === 0) {
    return 0;
  }

  const { error } = await bucket.remove(storagePaths);

  if (error) {
    throw error;
  }

  return storagePaths.length;
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
          message: '未找到该模板，可能已经被删除。',
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
          message: '未找到该模板，可能已经被删除。',
        },
        { status: 404 },
      );
    }

    if (template.owner_id !== user.id) {
      return createUnauthorizedResponse();
    }

    const templateReferenceStoragePathCount =
      await removeTemplateReferencePageStorage({
        admin,
        ownerId: user.id,
        templateId,
      });

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
        templateReferenceStoragePathCount,
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
