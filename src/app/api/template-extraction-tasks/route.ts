import { NextResponse } from 'next/server';
import { getRawErrorMessage } from '@/src/lib/errors/raw-error';
import { logEvent } from '@/src/lib/logging/log-event';
import type { PdfVisionPageInput } from '@/src/lib/llm/fill-template-from-pdf';
import {
  countExtractableParagraphsFromRawText,
  extractTextFromDocxBuffer,
} from '@/src/lib/llm/extract-template-slots';
import { createSupabaseAdminClient } from '@/src/lib/supabase/admin';
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

function parsePdfVisionPages(rawValue: FormDataEntryValue | null) {
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    return [] as PdfVisionPageInput[];
  }

  const parsed = JSON.parse(rawValue) as unknown;

  if (!Array.isArray(parsed)) {
    throw new Error('pdfVisionPages must be an array.');
  }

  return parsed
    .map((item) => {
      const record =
        item && typeof item === 'object'
          ? (item as Record<string, unknown>)
          : {};
      const pageNumber = Number(record.page_number);
      const imageDataUrl = String(record.image_data_url ?? '');

      if (
        !Number.isInteger(pageNumber) ||
        pageNumber < 1 ||
        !imageDataUrl.startsWith('data:image/')
      ) {
        return null;
      }

      return {
        page_number: pageNumber,
        image_data_url: imageDataUrl,
      };
    })
    .filter((item): item is PdfVisionPageInput => Boolean(item));
}

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return createUnauthorizedResponse();
  }

  try {
    const formData = await request.formData();
    const file = formData.get('file');
    const pdfName = String(formData.get('pdfName') ?? '').trim();
    const pdfVisionPages = parsePdfVisionPages(formData.get('pdfVisionPages'));
    const prompt = String(formData.get('prompt') ?? '').trim();

    if (!(file instanceof File)) {
      return NextResponse.json(
        {
          code: 'DOCX_REQUIRED',
          message: '请先上传 DOCX 模板。',
        },
        { status: 400 },
      );
    }

    if (!file.name.toLowerCase().endsWith('.docx')) {
      return NextResponse.json(
        {
          code: 'INVALID_DOCX_FILE',
          message: '当前只支持上传 .docx 模板文件。',
        },
        { status: 400 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const uploadText = await extractTextFromDocxBuffer(buffer);

    if (!uploadText) {
      return NextResponse.json(
        {
          code: 'DOCX_TEXT_EMPTY',
          message: '当前 DOCX 未提取到可用文本，请检查文档内容后重试。',
        },
        { status: 400 },
      );
    }

    const totalParagraphs = countExtractableParagraphsFromRawText(uploadText);

    if (totalParagraphs === 0) {
      return NextResponse.json(
        {
          code: 'NO_EXTRACTABLE_PARAGRAPHS',
          message: '当前 DOCX 中没有可抽取的有效段落，请检查文档内容后重试。',
        },
        { status: 400 },
      );
    }

    const admin = createSupabaseAdminClient();
    const { data: task, error } = await admin
      .from('template_extraction_tasks')
      .insert({
        owner_id: user.id,
        source_docx_name: file.name,
        source_docx_base64: buffer.toString('base64'),
        source_pdf_name: pdfVisionPages.length > 0 ? pdfName || null : null,
        source_pdf_vision_pages:
          pdfVisionPages.length > 0 ? pdfVisionPages : null,
        prompt,
        status: 'pending',
        total_paragraphs: totalParagraphs,
        completed_paragraphs: 0,
      })
      .select(
        'id, status, source_docx_name, prompt, total_paragraphs, completed_paragraphs, processing_trace, created_at, started_at, finished_at, error_message',
      )
      .single();

    if (error || !task) {
      throw error ?? new Error('Failed to create template extraction task.');
    }

    await logEvent({
      ownerId: user.id,
      actorEmail: user.email ?? null,
      level: 'info',
      eventType: 'template_extraction_task_created',
      message: `Created template extraction task for ${file.name}.`,
      route: '/api/template-extraction-tasks',
      payload: {
        taskId: task.id,
        prompt,
        sourceDocxName: file.name,
        sourcePdfName: pdfVisionPages.length > 0 ? pdfName : null,
        pdfVisionPageCount: pdfVisionPages.length,
        totalParagraphs,
      },
    });

    return NextResponse.json({
      data: task,
    });
  } catch (error) {
    const rawMessage = getRawErrorMessage(error);

    await logEvent({
      ownerId: user.id,
      actorEmail: user.email ?? null,
      level: 'error',
      eventType: 'template_extraction_task_create_failed',
      message: rawMessage,
      route: '/api/template-extraction-tasks',
    });

    return NextResponse.json(
      {
        code: 'TEMPLATE_EXTRACTION_TASK_CREATE_FAILED',
        message: rawMessage,
      },
      { status: 500 },
    );
  }
}
