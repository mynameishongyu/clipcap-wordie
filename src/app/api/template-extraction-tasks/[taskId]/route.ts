import { NextResponse } from 'next/server';
import {
  templatePdfEvidenceResultSchema,
  templateSlotExtractionResultSchema,
} from '@/src/app/api/types/template-slot-extraction';
import { getRawErrorMessage } from '@/src/lib/errors/raw-error';
import { createSupabaseServerClient } from '@/src/lib/supabase/server';

export const runtime = 'nodejs';

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
  _request: Request,
  context: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await context.params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return createUnauthorizedResponse();
  }

  try {
    const { data: task, error } = await supabase
      .from('template_extraction_tasks')
      .select(
        'id, status, source_docx_name, source_pdf_name, prompt, total_paragraphs, completed_paragraphs, processing_trace, upload_text, upload_html, result, pdf_evidence, error_message, created_at, started_at, finished_at',
      )
      .eq('id', taskId)
      .eq('owner_id', user.id)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!task) {
      return NextResponse.json(
        {
          code: 'TEMPLATE_EXTRACTION_TASK_NOT_FOUND',
          message: 'Template extraction task not found.',
        },
        { status: 404 },
      );
    }

    const parsedResult = task.result
      ? templateSlotExtractionResultSchema.safeParse(task.result).success
        ? templateSlotExtractionResultSchema.parse(task.result)
        : null
      : null;
    const parsedPdfEvidence = task.pdf_evidence
      ? templatePdfEvidenceResultSchema.safeParse(task.pdf_evidence).success
        ? templatePdfEvidenceResultSchema.parse(task.pdf_evidence)
        : null
      : null;

    return NextResponse.json({
      data: {
        ...task,
        result: parsedResult,
        pdf_evidence: parsedPdfEvidence,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        code: 'TEMPLATE_EXTRACTION_TASK_READ_FAILED',
        message: getRawErrorMessage(error),
      },
      { status: 500 },
    );
  }
}
