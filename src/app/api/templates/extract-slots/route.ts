import { NextResponse } from 'next/server';
import { extractTemplateSlotsFromDocx } from '@/src/lib/llm/extract-template-slots';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    const prompt = String(formData.get('prompt') ?? '');

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

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const result = await extractTemplateSlotsFromDocx({
      buffer,
      fileName: file.name,
      prompt,
    });

    return NextResponse.json({
      data: {
        file_name: file.name,
        prompt,
        document_info: result.document_info,
        extraction_result: result.extraction_result,
        upload_text: result.uploadText,
        upload_html: result.uploadHtml,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        code: 'TEMPLATE_SLOT_EXTRACTION_FAILED',
        message: error instanceof Error ? error.message : '槽位识别失败，请稍后重试。',
      },
      { status: 500 },
    );
  }
}
