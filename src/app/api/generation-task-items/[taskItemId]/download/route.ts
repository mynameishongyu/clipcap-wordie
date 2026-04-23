import { NextResponse } from 'next/server';
import type { GenerationReviewedItem } from '@/src/app/api/types/generation-task';
import { generateReviewedDocxBuffer } from '@/src/lib/docx/generate-reviewed-docx';
import { createSupabaseServerClient } from '@/src/lib/supabase/server';
import type { SlotReviewSessionPayload } from '@/src/lib/templates/slot-review-session';

function createUnauthorizedResponse() {
  return NextResponse.json(
    {
      code: 'UNAUTHORIZED',
      message: '请先登录后再继续。',
    },
    { status: 401 },
  );
}

export async function GET(
  request: Request,
  context: { params: Promise<{ taskItemId: string }> },
) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return createUnauthorizedResponse();
  }

  const { taskItemId } = await context.params;
  const { data: item, error } = await supabase
    .from('generation_task_items')
    .select('id, task_id, source_pdf_name, status, review_payload, llm_output')
    .eq('id', taskItemId)
    .single();

  if (error || !item) {
    return NextResponse.json(
      {
        code: 'GENERATION_TASK_ITEM_NOT_FOUND',
        message: '未找到该任务项。',
      },
      { status: 404 },
    );
  }

  if (item.status !== 'reviewed') {
    return NextResponse.json(
      {
        code: 'GENERATION_TASK_ITEM_NOT_REVIEWED',
        message: '请先完成核查，核查通过后才能下载。',
      },
      { status: 400 },
    );
  }

  const { data: task, error: taskError } = await supabase
    .from('generation_tasks')
    .select('id, template_id')
    .eq('id', item.task_id)
    .single();

  if (taskError || !task?.template_id) {
    return NextResponse.json(
      {
        code: 'GENERATION_TASK_TEMPLATE_NOT_FOUND',
        message: '当前任务缺少关联模板，无法生成核查后的 DOCX。',
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
        message: '当前模板缺少 DOCX 回填数据，无法生成核查后的下载结果。',
      },
      { status: 404 },
    );
  }

  const reviewedItems =
    ((item.review_payload as { extracted_items?: GenerationReviewedItem[] } | null)?.extracted_items ??
      (item.llm_output as { extracted_items?: GenerationReviewedItem[] } | null)?.extracted_items ??
      []) as GenerationReviewedItem[];

  const reviewedDocxBuffer = await generateReviewedDocxBuffer({
    templatePayload: template.slot_review_payload,
    reviewedItems,
  });

  const sourceBaseName = item.source_pdf_name.replace(/\.pdf$/i, '').trim() || 'generation-result';
  const templateBaseName =
    template.upload_docx_name?.replace(/\.docx$/i, '').trim() || 'template';
  const requestedFileName = new URL(request.url).searchParams.get('filename')?.trim() ?? '';
  const fileName =
    requestedFileName || `${templateBaseName}-${sourceBaseName}-核查结果.docx`;

  return new NextResponse(new Uint8Array(reviewedDocxBuffer), {
    status: 200,
    headers: {
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
    },
  });
}
