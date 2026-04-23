import { generateObject } from 'ai';
import mammoth from 'mammoth';
import {
  templateSlotExtractionResultSchema,
  type TemplateSlotExtractionResult,
} from '@/src/app/api/types/template-slot-extraction';
import { getTextLlmModel } from '@/src/lib/llm/env';
import { createTextLlmClient } from '@/src/lib/llm/openai-compatible';

const EXTRACTION_SYSTEM_PROMPT = `你是法律文书模板槽位抽取助手。
任务：只针对传入的当前段落，抽取与“被申请人 / 被告 / 借款人”等目标主体直接相关的槽位信息。

要求：
1. 只返回 JSON，不要返回解释、Markdown 或代码块。
2. 只抽取当前段落中实际出现的信息，不要编造，不要补全未出现的字段。
3. items 按原文出现顺序输出，不要去重。
4. 每次输入只代表单个段落，你只能基于当前段落输出结果。
5. original_value 必须保持原文格式。
6. original_doc_position 必须是能定位原文的完整短句或片段，并且必须来自当前段落。
7. 忽略申请人、法院、仲裁委、代理人等无关主体。
8. 默认重点字段包括：姓名、身份证号、民族、性别、出生日期、住址、联系电话、金额、百分数、日期、利率、分期期数。
9. 如果用户补充说明里明确要求抽取其他字段，也必须一起抽取，例如车牌号、汽车品牌、车型、合同编号、银行卡号等。
10. field_category 不必限制在默认字段范围内，只要该字段真实出现在当前段落，且符合用户要求或模板抽取目的，就可以输出。
11. 同一段中如果出现多个日期、多个金额、多个百分数、多个利率、多个分期期数，只要它们含义不同，就必须分别输出，不能合并，也不能遗漏。
12. 尤其要注意区分并分别抽取：签署日期、办理日期、逾期开始日期、截止日期、出生日期、还款相关日期等不同语义的日期。

固定返回格式：
{
  "document_info": {
    "document_name": "文档全称"
  },
  "extraction_result": [
    {
      "paragraph_index": 0,
      "paragraph_title": "段落标题",
      "items": [
        {
          "sequence": 1,
          "paragraph_index": 0,
          "field_category": "字段类别",
          "original_value": "原始具体值",
          "meaning_to_applicant": "该值对被申请人的含义",
          "original_doc_position": "原文定位片段"
        }
      ]
    }
  ]
}`;

export async function extractTextFromDocxBuffer(buffer: Buffer) {
  const { value } = await mammoth.extractRawText({ buffer });
  return value.trim();
}

export async function extractHtmlFromDocxBuffer(buffer: Buffer) {
  const { value } = await mammoth.convertToHtml({ buffer });
  return value.trim();
}

interface ExtractedParagraph {
  paragraph_index: number;
  paragraph_title: string;
  paragraph_text: string;
}

const EXTRACTION_CONCURRENCY = 4;

function buildParagraphTitle(paragraphText: string, paragraphIndex: number) {
  const normalized = paragraphText.replace(/\s+/g, ' ').trim();

  if (!normalized) {
    return `第 ${paragraphIndex + 1} 段`;
  }

  if (normalized.length <= 24) {
    return normalized;
  }

  return `${normalized.slice(0, 24)}...`;
}

function extractParagraphsFromRawText(uploadText: string): ExtractedParagraph[] {
  return uploadText
    .split(/\n{2,}/)
    .map((paragraphText) => paragraphText.trim())
    .filter(Boolean)
    .map((paragraphText, paragraphIndex) => ({
      paragraph_index: paragraphIndex,
      paragraph_title: buildParagraphTitle(paragraphText, paragraphIndex),
      paragraph_text: paragraphText,
    }));
}

async function extractParagraphsInBatches(params: {
  provider: ReturnType<typeof createTextLlmClient>;
  fileName: string;
  prompt: string;
  paragraphs: ExtractedParagraph[];
}) {
  const extractedParagraphs: Array<{
    paragraph_index: number;
    paragraph_title: string;
    items: Array<{
      sequence: number;
      paragraph_index?: number | null;
      field_category: string;
      original_value: string;
      meaning_to_applicant: string;
      original_doc_position: string;
    }>;
  }> = [];

  for (let index = 0; index < params.paragraphs.length; index += EXTRACTION_CONCURRENCY) {
    const batch = params.paragraphs.slice(index, index + EXTRACTION_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((paragraph) =>
        extractSlotsForParagraph({
          provider: params.provider,
          fileName: params.fileName,
          prompt: params.prompt,
          paragraph,
        }),
      ),
    );

    for (const result of batchResults) {
      if (!result || result.items.length === 0) {
        continue;
      }

      extractedParagraphs.push(result);
    }
  }

  return extractedParagraphs;
}

async function extractSlotsForParagraph(params: {
  provider: ReturnType<typeof createTextLlmClient>;
  fileName: string;
  prompt: string;
  paragraph: ExtractedParagraph;
}) {
  const { object } = await generateObject({
    model: params.provider.chatModel(getTextLlmModel()),
    schema: templateSlotExtractionResultSchema,
    timeout: 60000,
    prompt: [
      EXTRACTION_SYSTEM_PROMPT,
      `文件名：${params.fileName}`,
      params.prompt ? `用户补充说明：${params.prompt}` : '用户补充说明：无',
      `当前段落序号：${params.paragraph.paragraph_index}`,
      `当前段落标题：${params.paragraph.paragraph_title}`,
      '特别注意：如果用户要求抽取汽车牌照、汽车品牌、车型或其他默认字段范围之外的内容，只要它们真实出现在当前段落，也必须作为独立槽位输出。',
      '如果当前段落里出现多个不同含义的日期、金额、百分数或利率，必须分别输出，保持原文顺序，不能遗漏任何一个。',
      '以下是待抽取的当前段落，请严格按上面的 JSON 结构返回：',
      params.paragraph.paragraph_text,
    ].join('\n\n'),
  });

  const extractedParagraph = object.extraction_result[0];

  if (!extractedParagraph) {
    return null;
  }

  return {
    paragraph_index: params.paragraph.paragraph_index,
    paragraph_title:
      extractedParagraph.paragraph_title?.trim() || params.paragraph.paragraph_title,
    items: extractedParagraph.items.map((item) => ({
      ...item,
      paragraph_index: params.paragraph.paragraph_index,
    })),
  };
}

export async function extractTemplateSlotsFromDocx(params: {
  buffer: Buffer;
  prompt: string;
  fileName: string;
}): Promise<TemplateSlotExtractionResult & { uploadText: string; uploadHtml: string }> {
  const uploadText = await extractTextFromDocxBuffer(params.buffer);
  const uploadHtml = await extractHtmlFromDocxBuffer(params.buffer);

  if (!uploadText) {
    throw new Error('DOCX 中没有提取到可用文本，请检查模板内容后重试。');
  }

  const paragraphs = extractParagraphsFromRawText(uploadText);

  if (paragraphs.length === 0) {
    throw new Error('DOCX 中没有识别到可用段落，请检查模板内容后重试。');
  }

  const provider = createTextLlmClient();
  const extractedParagraphs = await extractParagraphsInBatches({
    provider,
    fileName: params.fileName,
    prompt: params.prompt,
    paragraphs,
  });

  extractedParagraphs.sort((left, right) => left.paragraph_index - right.paragraph_index);

  let nextSequence = 1;
  const normalizedExtractionResult = extractedParagraphs.map((paragraph) => ({
    ...paragraph,
    items: paragraph.items.map((item) => ({
      ...item,
      sequence: nextSequence++,
    })),
  }));

  return {
    document_info: {
      document_name: params.fileName,
    },
    extraction_result: normalizedExtractionResult,
    uploadText,
    uploadHtml,
  };
}
