import { z } from 'zod';
import {
  getTextLlmApiKey,
  getTextLlmBaseUrl,
  getTextLlmModel,
  getVisionLlmApiKey,
  getVisionLlmBaseUrl,
  getVisionLlmModel,
} from '@/src/lib/llm/env';

export interface GenerationSlotSchemaItem {
  slot_key: string;
  field_category: string;
  meaning_to_applicant: string;
}

export interface PdfPageInput {
  page_number: number;
  text: string;
}

export interface PdfVisionPageInput {
  page_number: number;
  image_data_url: string;
}

interface ModelMatch {
  value?: string;
  snippet?: string;
  page_number?: number | null;
}

interface ModelResultCandidate {
  slot_key?: string;
  slot_name?: string;
  final_value?: string;
  matches?: ModelMatch[];
}

const generationExtractedItemSchema = z.object({
  slot_key: z.string(),
  field_category: z.string(),
  meaning_to_applicant: z.string(),
  original_value: z.string(),
  evidence: z.string().nullable().optional(),
  evidence_page_numbers: z.array(z.number().int()).optional().default([]),
  notes: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
});

const generationPdfFillResultSchema = z.object({
  document_summary: z.string().nullable().optional(),
  extracted_items: z.array(generationExtractedItemSchema).optional().default([]),
});

const PDF_SLOT_FILL_TEXT_TIMEOUT_MS = 90000;
const PDF_SLOT_FILL_VISION_TIMEOUT_MS = 180000;
const MAX_TEXT_PAGES_PER_CHUNK = 2;
const MAX_TEXT_CHARS_PER_CHUNK = 2200;

function normalizeJsonText(rawContent: string) {
  const trimmed = rawContent.trim();
  const withoutCodeFence = trimmed
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  if (withoutCodeFence.startsWith('{') || withoutCodeFence.startsWith('[')) {
    return withoutCodeFence;
  }

  const firstBrace = withoutCodeFence.indexOf('{');
  const lastBrace = withoutCodeFence.lastIndexOf('}');

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return withoutCodeFence.slice(firstBrace, lastBrace + 1);
  }

  return withoutCodeFence;
}

function repairCommonJsonBarewords(rawJson: string) {
  return rawJson
    .replace(
      /(:\s*)(无|空|未知|未提及|未找到|暂无|缺失|没有)(?=\s*[,}\]])/g,
      '$1null',
    )
    .replace(
      /([\[,]\s*)(无|空|未知|未提及|未找到|暂无|缺失|没有)(?=\s*[,}\]])/g,
      '$1null',
    );
}

function parseModelJson<T>(rawContent: string): T {
  const normalized = normalizeJsonText(rawContent);
  const repaired = repairCommonJsonBarewords(normalized);

  try {
    return JSON.parse(repaired) as T;
  } catch (error) {
    const preview = repaired.slice(0, 240);
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`模型返回的 JSON 解析失败：${reason}。片段：${preview}`);
  }
}

function normalizeSlotIdentifier(value: string | null | undefined) {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[：:，,。、“”"'`（）()\[\]【】{}<>《》\-_/]/g, '');
}

function findResultForSlot(
  slot: GenerationSlotSchemaItem,
  results: ModelResultCandidate[] | undefined,
  options?: { fallbackToSingleResult?: boolean },
) {
  if (!results?.length) {
    return null;
  }

  const normalizedSlotKey = normalizeSlotIdentifier(slot.slot_key);
  const normalizedSlotName = normalizeSlotIdentifier(slot.field_category);

  const bySlotKey = results.find(
    (candidate) => normalizeSlotIdentifier(candidate.slot_key) === normalizedSlotKey,
  );

  if (bySlotKey) {
    return bySlotKey;
  }

  const byExactName = results.find(
    (candidate) => normalizeSlotIdentifier(candidate.slot_name) === normalizedSlotName,
  );

  if (byExactName) {
    return byExactName;
  }

  const byLooseName = results.find((candidate) => {
    const normalizedCandidateName = normalizeSlotIdentifier(candidate.slot_name);

    return (
      Boolean(normalizedCandidateName) &&
      (normalizedCandidateName.includes(normalizedSlotName) ||
        normalizedSlotName.includes(normalizedCandidateName))
    );
  });

  if (byLooseName) {
    return byLooseName;
  }

  if (options?.fallbackToSingleResult && results.length === 1) {
    return results[0] ?? null;
  }

  return null;
}

function resolveChatCompletionsUrl(baseUrl: string) {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');

  if (normalizedBaseUrl.endsWith('/chat/completions')) {
    return normalizedBaseUrl;
  }

  return `${normalizedBaseUrl}/chat/completions`;
}

function resolveResponsesUrl(baseUrl: string) {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');

  if (normalizedBaseUrl.endsWith('/responses')) {
    return normalizedBaseUrl;
  }

  return `${normalizedBaseUrl}/responses`;
}

function getSlotSemanticHint(slotName: string) {
  if (slotName.includes('身份证')) {
    return '目标字段是自然人的身份证号/身份证号码/公民身份号码/证件号码，通常是 15 到 18 位字符，可能以 X 结尾。';
  }

  if (slotName.includes('电话') || slotName.includes('手机') || slotName.includes('联系')) {
    return '目标字段是联系电话/联系方式/手机号，通常是 11 位手机号，也可能带区号或分隔符。';
  }

  if (slotName.includes('出生')) {
    return '目标字段是出生日期/生日/生于，常见格式有 YYYY年M月D日、YYYY-M-D、YYYY/MM/DD。';
  }

  if (slotName.includes('住址') || slotName.includes('地址')) {
    return '目标字段是住址/联系地址/通讯地址/住所地/户籍地址，通常是较长的中文地址串。';
  }

  return '请根据槽位名称的语义，在个人信息或合同主体信息中寻找最可能对应的值。';
}

function getSlotKeywords(slotName: string) {
  const base = [slotName, '被申请人', '被告', '借款人', '乙方', '客户', '共同借款人'];

  if (slotName.includes('身份证')) {
    return [...base, '身份证', '公民身份号码', '身份证号', '证件号码'];
  }

  if (slotName.includes('电话') || slotName.includes('手机') || slotName.includes('联系')) {
    return [...base, '电话', '手机', '联系电话', '联系方式', '手机号'];
  }

  if (slotName.includes('出生')) {
    return [...base, '出生', '出生日期', '生日', '生于'];
  }

  if (slotName.includes('住址') || slotName.includes('地址')) {
    return [...base, '住址', '地址', '住所地', '联系地址', '通讯地址', '户籍地址'];
  }

  return base;
}

function scorePageForSlot(slotName: string, page: PdfPageInput) {
  const keywords = getSlotKeywords(slotName);
  let score = 0;

  for (const keyword of keywords) {
    if (page.text.includes(keyword)) {
      score += keyword === slotName ? 4 : 1;
    }
  }

  if (
    page.text.includes('身份证') ||
    page.text.includes('借款人') ||
    page.text.includes('客户') ||
    page.text.includes('申请人') ||
    page.text.includes('姓名') ||
    page.text.includes('地址') ||
    page.text.includes('电话')
  ) {
    score += 1;
  }

  return score;
}

function buildSlotContexts(slotName: string, pages: PdfPageInput[]) {
  const rankedPages = pages
    .map((page) => ({
      page,
      score: scorePageForSlot(slotName, page),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.page.page_number - right.page.page_number);

  const sourcePages = rankedPages.length > 0 ? rankedPages.map((item) => item.page) : pages;
  const orderedPages = [...sourcePages].sort((left, right) => left.page_number - right.page_number);
  const contexts: Array<{ pageNumbers: number[]; chunkText: string }> = [];
  let currentPages: number[] = [];
  let currentText = '';

  const flush = () => {
    if (!currentPages.length || !currentText.trim()) {
      return;
    }

    contexts.push({
      pageNumbers: [...currentPages],
      chunkText: currentText.trim(),
    });
    currentPages = [];
    currentText = '';
  };

  for (const page of orderedPages) {
    const pageText = `[第 ${page.page_number} 页]\n${page.text}\n`;

    if (
      currentPages.length >= MAX_TEXT_PAGES_PER_CHUNK ||
      currentText.length + pageText.length > MAX_TEXT_CHARS_PER_CHUNK
    ) {
      flush();
    }

    currentPages.push(page.page_number);
    currentText += pageText;
  }

  flush();
  return contexts;
}

function extractVisionOutputText(payload: unknown) {
  const candidate = payload as {
    output_text?: unknown;
    output?: Array<{ content?: Array<{ text?: unknown }> }>;
  };

  if (typeof candidate?.output_text === 'string' && candidate.output_text.trim()) {
    return candidate.output_text;
  }

  const outputText = candidate?.output
    ?.flatMap((item) => item?.content ?? [])
    ?.map((item) => item?.text)
    ?.find((value): value is string => typeof value === 'string' && Boolean(value.trim()));

  return outputText ?? '';
}

async function extractSlotWithTextModel(input: {
  documentName: string;
  slot: GenerationSlotSchemaItem;
  pageNumbers: number[];
  chunkText: string;
}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PDF_SLOT_FILL_TEXT_TIMEOUT_MS);

  try {
    const upstream = await fetch(resolveChatCompletionsUrl(getTextLlmBaseUrl()), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getTextLlmApiKey()}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: getTextLlmModel(),
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              '你是 PDF 槽位填充助手。只针对当前提供的单个槽位名称和 PDF 页面片段内容，找出这个槽位在片段中可能对应的值，并返回能定位的原文截取片段。只返回 JSON。',
          },
          {
            role: 'user',
            content: JSON.stringify({
              document_name: input.documentName,
              slot_key: input.slot.slot_key,
              slot_name: input.slot.field_category,
              slot_hint: input.slot.meaning_to_applicant || getSlotSemanticHint(input.slot.field_category),
              strict_requirement: 'Return the exact same slot_key in results[0].slot_key.',
              page_numbers: input.pageNumbers,
              content: input.chunkText,
              output_schema: {
                results: [
                  {
                    slot_key: input.slot.slot_key,
                    slot_name: input.slot.field_category,
                    final_value: '最终确定的填充值',
                    matches: [
                      {
                        value: '对应值',
                        snippet: '包含对应值的原文片段',
                        page_number: 1,
                      },
                    ],
                  },
                ],
              },
            }),
          },
        ],
      }),
    });

    if (!upstream.ok) {
      const details = await upstream.text();
      throw new Error(`文本模型请求失败（${upstream.status}）：${details}`);
    }

    const payload = await upstream.json();
    const rawContent = payload?.choices?.[0]?.message?.content;

    if (typeof rawContent !== 'string' || !rawContent.trim()) {
      return {
        extracted_items: [],
        document_summary: '',
      };
    }

    const normalized = parseModelJson<{
      results?: ModelResultCandidate[];
    }>(rawContent);

    const firstResult = findResultForSlot(input.slot, normalized.results, {
      fallbackToSingleResult: true,
    });
    const firstMatch = firstResult?.matches?.find(
      (match) =>
        typeof match?.value === 'string' &&
        Boolean(match.value.trim()) &&
        typeof match?.snippet === 'string' &&
        Boolean(match.snippet.trim()),
    );

    if (!firstResult && !firstMatch) {
      return {
        extracted_items: [],
        document_summary: '',
      };
    }

    return {
      document_summary: '',
      extracted_items: [
        {
          slot_key: input.slot.slot_key,
          field_category: input.slot.field_category,
          meaning_to_applicant: input.slot.meaning_to_applicant,
          original_value: firstResult?.final_value?.trim() || firstMatch?.value?.trim() || '',
          evidence: firstMatch?.snippet?.trim() || '',
          evidence_page_numbers:
            typeof firstMatch?.page_number === 'number'
              ? [firstMatch.page_number]
              : input.pageNumbers,
          notes: '',
          confidence: null,
        },
      ],
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('文本槽位抽取超时，请稍后重试。');
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function extractSlotsWithVisionModel(input: {
  documentName: string;
  slots: GenerationSlotSchemaItem[];
  visionPages: PdfVisionPageInput[];
}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PDF_SLOT_FILL_VISION_TIMEOUT_MS);

  try {
    const content: Array<
      | { type: 'input_image'; image_url: string }
      | { type: 'input_text'; text: string }
    > = input.visionPages.map((page) => ({
      type: 'input_image',
      image_url: page.image_data_url,
    }));

    content.push({
      type: 'input_text',
      text: JSON.stringify({
        task: '请逐页查看这些 PDF 页面图像，针对给定槽位列表穷尽式抽取对应值。每个槽位都要返回一个 final_value，以及所有能支撑该槽位的原文片段 matches。只返回 JSON。',
        document_name: input.documentName,
        slot_names: input.slots.map((slot) => slot.field_category),
        slot_definitions: input.slots.map((slot) => ({
          slot_key: slot.slot_key,
          slot_name: slot.field_category,
          slot_meaning:
            slot.meaning_to_applicant || getSlotSemanticHint(slot.field_category),
        })),
        page_numbers: input.visionPages.map((page) => page.page_number),
        strict_requirement:
          'Each result item must include the exact slot_key copied from slot_definitions.',
        slot_hints: Object.fromEntries(
          input.slots.map((slot) => [
            slot.field_category,
            slot.meaning_to_applicant || getSlotSemanticHint(slot.field_category),
          ]),
        ),
        output_schema: {
          results: [
            {
              slot_name: '槽位名称',
              final_value: '最终确定的填充值',
              matches: [
                {
                  value: '对应值',
                  snippet: '包含对应值的原文片段',
                  page_number: 1,
                },
              ],
            },
          ],
        },
      }),
    });

    const upstream = await fetch(resolveResponsesUrl(getVisionLlmBaseUrl()), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getVisionLlmApiKey()}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: getVisionLlmModel(),
        input: [
          {
            role: 'user',
            content,
          },
        ],
      }),
    });

    if (!upstream.ok) {
      const details = await upstream.text();
      throw new Error(`视觉模型请求失败（${upstream.status}）：${details}`);
    }

    const payload = await upstream.json();
    const rawContent = extractVisionOutputText(payload);

    if (!rawContent) {
      return {
        document_summary: '',
        extracted_items: [],
      };
    }

    const normalized = parseModelJson<{
      results?: ModelResultCandidate[];
    }>(rawContent);

    const extracted_items = input.slots.flatMap((slot) => {
      const result = findResultForSlot(slot, normalized.results);
      const firstMatch = result?.matches?.find(
        (match) =>
          typeof match?.value === 'string' &&
          Boolean(match.value.trim()) &&
          typeof match?.snippet === 'string' &&
          Boolean(match.snippet.trim()),
      );

      if (!result && !firstMatch) {
        return [];
      }

      return [
        {
          slot_key: slot.slot_key,
          field_category: slot.field_category,
          meaning_to_applicant: slot.meaning_to_applicant,
          original_value: result?.final_value?.trim() || firstMatch?.value?.trim() || '',
          evidence: firstMatch?.snippet?.trim() || '',
          evidence_page_numbers:
            result?.matches
              ?.map((match) => match?.page_number)
              .filter((value): value is number => typeof value === 'number') ?? [],
          notes: '',
          confidence: null,
        },
      ];
    });

    return {
      document_summary: '',
      extracted_items,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('视觉模型处理超时了，请稍后重试。');
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function mergeTextResults(
  slots: GenerationSlotSchemaItem[],
  results: z.infer<typeof generationPdfFillResultSchema>[],
) {
  return {
    document_summary: '',
    extracted_items: slots.map((slot) => {
      const preferredMatch =
        results
          .flatMap((result) =>
            result.extracted_items.filter((item) => item.slot_key === slot.slot_key),
          )
          .find((item) => item.original_value.trim()) ?? null;

      return {
        slot_key: slot.slot_key,
        field_category: slot.field_category,
        meaning_to_applicant: slot.meaning_to_applicant,
        original_value: preferredMatch?.original_value ?? '',
        evidence: preferredMatch?.evidence ?? '',
        evidence_page_numbers: preferredMatch?.evidence_page_numbers ?? [],
        notes: preferredMatch?.notes ?? '',
        confidence: preferredMatch?.confidence ?? null,
      };
    }),
  };
}

export async function fillTemplateSlotsFromPdf(params: {
  pdfFileName: string;
  templateName: string;
  templatePrompt: string;
  slots: GenerationSlotSchemaItem[];
  pages: PdfPageInput[];
  visionPages?: PdfVisionPageInput[];
  likelyScanned?: boolean;
  totalTextLength?: number;
}) {
  if (params.slots.length === 0) {
    return {
      document_summary: '',
      extracted_items: [],
    };
  }

  const validPages = params.pages.filter((page) => page.text.trim().length > 0);
  const validVisionPages = (params.visionPages ?? []).filter((page) =>
    page.image_data_url.startsWith('data:image/'),
  );

  const shouldUseVision =
    validVisionPages.length > 0 &&
    (params.likelyScanned === true ||
      validPages.length === 0 ||
      validPages.every((page) => page.text.trim().length <= 10) ||
      (typeof params.totalTextLength === 'number' &&
        params.totalTextLength <= Math.max(20, validPages.length * 10)));

  if (shouldUseVision) {
    return extractSlotsWithVisionModel({
      documentName: params.pdfFileName,
      slots: params.slots,
      visionPages: validVisionPages,
    });
  }

  const allResults: z.infer<typeof generationPdfFillResultSchema>[] = [];

  for (const slot of params.slots) {
    const contexts = buildSlotContexts(slot.field_category, validPages);

    for (const context of contexts) {
      const result = await extractSlotWithTextModel({
        documentName: params.pdfFileName,
        slot,
        pageNumbers: context.pageNumbers,
        chunkText: context.chunkText,
      });

      allResults.push(result);
    }
  }

  return mergeTextResults(params.slots, allResults);
}
