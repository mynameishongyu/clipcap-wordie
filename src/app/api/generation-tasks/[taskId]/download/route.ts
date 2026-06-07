import JSZip from 'jszip';
import { NextResponse } from 'next/server';
import type { GenerationReviewedItem } from '@/src/app/api/types/generation-task';
import { generateReviewedDocxBuffer } from '@/src/lib/docx/generate-reviewed-docx';
import { createSupabaseServerClient } from '@/src/lib/supabase/server';
import type { SlotReviewSessionPayload } from '@/src/lib/templates/slot-review-session';

type BatchDownloadTaskItem = {
  id: string;
  source_pdf_name: string;
  status: string;
  review_payload: unknown;
  llm_output: unknown;
  created_at: string;
};

function createUnauthorizedResponse() {
  return NextResponse.json(
    {
      code: 'UNAUTHORIZED',
      message: '请先登录后再继续。',
    },
    { status: 401 },
  );
}

function sanitizeZipEntryName(value: string) {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/g, '');
}

function ensureUniqueZipEntryName(fileName: string, usedNames: Set<string>) {
  const safeName = sanitizeZipEntryName(fileName) || 'generation-result.docx';
  const baseName = safeName.replace(/\.docx$/i, '');
  let nextName = safeName.toLowerCase().endsWith('.docx')
    ? safeName
    : `${safeName}.docx`;
  let suffix = 2;

  while (usedNames.has(nextName)) {
    nextName = `${baseName}-${suffix}.docx`;
    suffix += 1;
  }

  usedNames.add(nextName);

  return nextName;
}

function normalizeReviewedItems(item: BatchDownloadTaskItem) {
  const reviewedItems = ((
    item.review_payload as { extracted_items?: GenerationReviewedItem[] } | null
  )?.extracted_items ??
    (item.llm_output as { extracted_items?: GenerationReviewedItem[] } | null)
      ?.extracted_items ??
    []) as GenerationReviewedItem[];

  return reviewedItems;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ taskId: string }> },
) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return createUnauthorizedResponse();
  }

  const { taskId } = await context.params;
  const { data: task, error: taskError } = await supabase
    .from('generation_tasks')
    .select('id, owner_id, template_id, template_name_snapshot')
    .eq('id', taskId)
    .single();

  if (taskError || !task) {
    return NextResponse.json(
      {
        code: 'GENERATION_TASK_NOT_FOUND',
        message: '未找到该批量生成任务。',
      },
      { status: 404 },
    );
  }

  if (task.owner_id !== user.id) {
    return createUnauthorizedResponse();
  }

  if (!task.template_id) {
    return NextResponse.json(
      {
        code: 'GENERATION_TASK_TEMPLATE_NOT_FOUND',
        message: '当前任务缺少关联模板，无法生成批量下载结果。',
      },
      { status: 404 },
    );
  }

  const { data: template, error: templateError } = await supabase
    .from('templates')
    .select('upload_docx_name, slot_review_payload')
    .eq('id', task.template_id)
    .eq('owner_id', user.id)
    .maybeSingle<{
      upload_docx_name?: string | null;
      slot_review_payload?: SlotReviewSessionPayload | null;
    }>();

  if (templateError || !template?.slot_review_payload) {
    return NextResponse.json(
      {
        code: 'GENERATION_TASK_TEMPLATE_PAYLOAD_NOT_FOUND',
        message: '当前模板缺少 DOCX 回填数据，无法生成批量下载结果。',
      },
      { status: 404 },
    );
  }

  const { data: items, error: itemsError } = await supabase
    .from('generation_task_items')
    .select(
      'id, source_pdf_name, status, review_payload, llm_output, created_at',
    )
    .eq('task_id', taskId)
    .in('status', ['review_pending', 'reviewed'])
    .order('created_at', { ascending: true })
    .returns<BatchDownloadTaskItem[]>();

  if (itemsError) {
    return NextResponse.json(
      {
        code: 'GENERATION_TASK_ITEMS_FETCH_FAILED',
        message: itemsError.message,
      },
      { status: 500 },
    );
  }

  const downloadableItems = items ?? [];

  if (downloadableItems.length === 0) {
    return NextResponse.json(
      {
        code: 'GENERATION_TASK_NO_DOWNLOADABLE_ITEMS',
        message: '当前批量任务还没有可下载的成功结果。',
      },
      { status: 400 },
    );
  }

  const zip = new JSZip();
  const usedNames = new Set<string>();
  const templateBaseName =
    template.upload_docx_name?.replace(/\.docx$/i, '').trim() ||
    task.template_name_snapshot?.trim() ||
    'template';

  for (const [index, item] of downloadableItems.entries()) {
    const reviewedItems = normalizeReviewedItems(item);
    const reviewedDocxBuffer = await generateReviewedDocxBuffer({
      templatePayload: template.slot_review_payload,
      reviewedItems,
    });
    const sourceBaseName =
      item.source_pdf_name.replace(/\.pdf$/i, '').trim() ||
      `generation-result-${index + 1}`;
    const reviewLabel = item.status === 'reviewed' ? '核查结果' : '未核查结果';
    const zipEntryName = ensureUniqueZipEntryName(
      `${templateBaseName}-${sourceBaseName}-${reviewLabel}.docx`,
      usedNames,
    );

    zip.file(zipEntryName, reviewedDocxBuffer);
  }

  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
  const requestedFileName =
    new URL(request.url).searchParams.get('filename')?.trim() ?? '';
  const fallbackFileName = `${task.template_name_snapshot ?? templateBaseName}-本批成功结果.zip`;
  const fileName = requestedFileName || fallbackFileName;

  return new NextResponse(new Uint8Array(zipBuffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
    },
  });
}
