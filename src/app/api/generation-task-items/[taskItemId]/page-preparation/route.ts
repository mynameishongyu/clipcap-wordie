import { after, NextResponse } from 'next/server';
import { readdir, readFile } from 'fs/promises';
import { extname, isAbsolute, resolve } from 'path';
import { Agent, fetch as undiciFetch } from 'undici';
import {
  appendProcessingTrace,
  buildStoredPageImageFileApiVisionPages,
  createUnauthorizedResponse,
  generationTaskItemSelect,
  cleanupGeminiFileApiFilesForTrace,
  collectGeminiFileApiFilesFromAssets,
  buildStoredPageImageSupabaseSignedUrlVisionPages,
  type PdfPageImageAsset,
  type GenerationTaskItemRecord,
  getErrorMessage,
  loadVisionPagesFromStoredAssets,
  normalizePdfPageImageAssets,
  normalizeVisionPages,
  recalculateTaskSummary,
} from '@/src/lib/generation-task-items/runtime';
import { getOptionalEnv } from '@/src/lib/llm/env';
import { callGeminiNativeChatCompletion } from '@/src/lib/llm/gemini-native';
import type { GeminiVisionFile } from '@/src/lib/llm/gemini-vision-file';
import {
  geminiPageFilterResponseSchema,
  withProviderJsonResponseFormat,
} from '@/src/lib/llm/gemini-json-schemas';
import { parseModelJsonOutput } from '@/src/lib/llm/json-output';
import {
  createLlmUsageAccumulator,
  recordLlmUsageFromPayload,
  summarizeLlmUsage,
  type LlmUsageAccumulator,
} from '@/src/lib/llm/usage';
import {
  buildChatCompletionBody,
  buildChatCompletionHeaders,
  getLlmRuntimeConfig,
  getLlmRuntimeTraceConfig,
} from '@/src/lib/llm/provider';
import type {
  GenerationSlotSchemaItem,
  PdfVisionPageInput,
} from '@/src/lib/llm/fill-template-from-pdf';
import { buildErrorLogPayload, logEvent } from '@/src/lib/logging/log-event';
import { getGeminiImageProxyUrlExpiresAt } from '@/src/lib/gemini/image-proxy';
import { createSupabaseAdminClient } from '@/src/lib/supabase/admin';
import { createSupabaseServerClient } from '@/src/lib/supabase/server';

export const runtime = 'nodejs';
export const maxDuration = 300;

const PAGE_FILTER_BATCH_SIZE_DEFAULT = 4;
const PAGE_FILTER_BATCH_SIZE_MAX = 32;
const PAGE_FILTER_REQUEST_TIMEOUT_MS = 180000;
const PAGE_FILTER_DROP_EXAMPLES_DIR_DEFAULT = 'pdf_page_filter_drop_examples';
const PAGE_FILTER_DROP_EXAMPLES_MAX = 4;
const PAGE_FILTER_DROP_EXAMPLE_MIME_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
]);
/*
const PAGE_FILTER_SYSTEM_PROMPT =
  '你是一个视觉 PDF 页面过滤助手。请根据内置过滤规则判断候选页面是否适合后续文档槽位回填。只返回紧凑 JSON，不要输出额外解释。';
*/
const PDF_FILTER_VISION_LLM_REASONING_EFFORT_ENV =
  'PDF_FILTER_VISION_LLM_REASONING_EFFORT';
const READABLE_PAGE_FILTER_SYSTEM_PROMPT_ZH =
  '你是一个视觉 PDF 页面过滤助手。请根据页面图片判断候选页面是否适合后续文档槽位回填。只返回紧凑 JSON，不要输出额外解释。';
const PAGE_FILTER_SYSTEM_PROMPT_EN =
  'You are a visual PDF page filtering assistant. Decide whether each candidate page image should be used for downstream document slot filling. Return compact JSON only, with no extra explanation.';
const PDF_FILL_LLM_OPTIONS = {
  reasoningEffortEnvName: PDF_FILTER_VISION_LLM_REASONING_EFFORT_ENV,
} as const;
const llmFetchDispatcher = new Agent({
  connect: {
    timeout: 60000,
  },
});

type PageFilterDecision = {
  page_number: number;
  decision: 'keep' | 'drop' | 'review';
  reason: string;
  confidence: number | null;
};

type PageFilterDropExample = {
  file_name: string;
  image_data_url: string;
};

type PageFilterGeminiFileReference = {
  uri: string;
  name?: string | null;
  mime_type: string;
  size_bytes?: number | null;
  display_name?: string | null;
  uploaded_at: string;
  expires_at: string | null;
  request_label: string;
};

function hasUsableReferencePdfEvidence(slot: GenerationSlotSchemaItem) {
  const reference = slot.reference_pdf_evidence;
  const bbox = reference?.example_bbox;

  return (
    typeof reference?.example_page_number === 'number' &&
    Number.isInteger(reference.example_page_number) &&
    reference.example_page_number > 0 &&
    Boolean(bbox) &&
    typeof bbox?.x === 'number' &&
    typeof bbox?.y === 'number' &&
    typeof bbox?.width === 'number' &&
    typeof bbox?.height === 'number' &&
    bbox.width > 0 &&
    bbox.height > 0
  );
}

function buildPageFilterPages(pageImageAssets: PdfPageImageAsset[]) {
  return pageImageAssets
    .slice()
    .sort(
      (left, right) => left.uploaded_page_number - right.uploaded_page_number,
    )
    .map((asset) => ({
      uploadedPageNumber: asset.uploaded_page_number,
      originalPageNumber: asset.original_page_number,
      storagePath: asset.storage_path,
      imageUrl: null,
      rotationApplied:
        typeof asset.rotation_applied === 'number'
          ? asset.rotation_applied
          : null,
      filterDecision: asset.filter_decision ?? null,
      filterReason: asset.filter_reason ?? null,
      filterConfidence:
        typeof asset.filter_confidence === 'number'
          ? asset.filter_confidence
          : null,
      selectedForSlotFill: asset.used_for_slot_fill !== false,
    }));
}

function buildPagePreparationResponseItem(item: GenerationTaskItemRecord) {
  const pageImageAssets = normalizePdfPageImageAssets(
    item.llm_input?.ocr_image_assets,
  );

  return {
    ...item,
    pdf_page_filter_pages: buildPageFilterPages(pageImageAssets),
    llm_input: undefined,
  };
}

function toPageFilterGeminiFileReference(
  file: GeminiVisionFile,
  requestLabel: string,
): PageFilterGeminiFileReference {
  return {
    uri: file.uri,
    name: file.name ?? null,
    mime_type: file.mimeType,
    size_bytes: file.sizeBytes,
    display_name: file.displayName,
    uploaded_at: new Date().toISOString(),
    expires_at: getGeminiImageProxyUrlExpiresAt(file.uri),
    request_label: requestLabel,
  };
}

function getPageFilterBatchSize() {
  const rawValue = getOptionalEnv('PDF_FILL_PAGE_FILTER_PAGES_PER_REQUEST');
  const parsedValue = rawValue
    ? Number(rawValue)
    : PAGE_FILTER_BATCH_SIZE_DEFAULT;

  if (!Number.isInteger(parsedValue) || parsedValue < 1) {
    return PAGE_FILTER_BATCH_SIZE_DEFAULT;
  }

  return Math.min(PAGE_FILTER_BATCH_SIZE_MAX, parsedValue);
}

function estimateDataUrlBytes(dataUrl: string) {
  const commaIndex = dataUrl.indexOf(',');

  if (commaIndex < 0) {
    return 0;
  }

  const base64Payload = dataUrl.slice(commaIndex + 1);
  const paddingLength = base64Payload.endsWith('==')
    ? 2
    : base64Payload.endsWith('=')
      ? 1
      : 0;

  return Math.max(
    0,
    Math.floor((base64Payload.length * 3) / 4) - paddingLength,
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function inspectGeminiImageProxyUrls(params: {
  pages: PdfVisionPageInput[];
  batchLabel: string;
  signal: AbortSignal;
  onTrace?: (entry: { message: string }) => Promise<void> | void;
}) {
  const proxyFiles = params.pages.flatMap((page) =>
    page.gemini_file?.uri
      ? [
          {
            pageNumber: page.page_number,
            originalPageNumber: page.original_page_number ?? page.page_number,
            uri: page.gemini_file.uri,
            expectedMimeType: page.gemini_file.mimeType,
          },
        ]
      : [],
  );

  if (proxyFiles.length === 0) {
    return;
  }

  const startedAt = Date.now();
  const results = await Promise.all(
    proxyFiles.map(async (file) => {
      try {
        const response = await undiciFetch(file.uri, {
          method: 'HEAD',
          dispatcher: llmFetchDispatcher,
          signal: params.signal,
        });
        const contentType = response.headers.get('content-type');
        const contentLength = response.headers.get('content-length');
        const acceptRanges = response.headers.get('accept-ranges');

        return {
          page_number: file.pageNumber,
          original_page_number: file.originalPageNumber,
          ok: response.ok,
          status: response.status,
          status_text: response.statusText,
          content_type: contentType,
          content_length: contentLength,
          accept_ranges: acceptRanges,
          expected_mime_type: file.expectedMimeType,
          is_image_content_type: Boolean(contentType?.startsWith('image/')),
          url: file.uri,
        };
      } catch (error) {
        return {
          page_number: file.pageNumber,
          original_page_number: file.originalPageNumber,
          ok: false,
          status: null,
          status_text: null,
          content_type: null,
          content_length: null,
          accept_ranges: null,
          expected_mime_type: file.expectedMimeType,
          is_image_content_type: false,
          error_message: getErrorMessage(error),
          url: file.uri,
        };
      }
    }),
  );
  const failedResults = results.filter(
    (result) => !result.ok || !result.is_image_content_type,
  );

  await params.onTrace?.({
    message: `[PDF Fill][PageFilterGeminiProxyPreflight][${params.batchLabel}] ${JSON.stringify(
      {
        checked_url_count: results.length,
        failed_url_count: failedResults.length,
        duration_ms: Date.now() - startedAt,
        results,
      },
    )}`,
  });

  if (failedResults.length > 0) {
    throw new Error(
      `Gemini image proxy preflight failed before page filtering: ${JSON.stringify(
        failedResults,
      )}`,
    );
  }
}

function getVercelMemoryUsageSnapshot(stage: string) {
  const memory = process.memoryUsage();

  return {
    stage,
    rss_bytes: memory.rss,
    heap_total_bytes: memory.heapTotal,
    heap_used_bytes: memory.heapUsed,
    external_bytes: memory.external,
    array_buffers_bytes: memory.arrayBuffers,
  };
}

async function appendMemoryTrace(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  taskItemId: string,
  stage: string,
  details?: Record<string, unknown>,
) {
  await appendProcessingTrace(
    admin,
    taskItemId,
    `[Vercel Memory][PDF Fill][PagePreparation] ${JSON.stringify({
      ...getVercelMemoryUsageSnapshot(stage),
      ...(details ?? {}),
    })}`,
  );
}

function parsePageFilterJson(rawContent: string) {
  const parsed = parseModelJsonOutput<{
    pages?: Array<{
      page_number?: number | string;
      decision?: string;
      reason?: string;
      confidence?: number;
    }>;
  }>(rawContent, {
    context: 'Page filter JSON',
  }).data;

  return (parsed.pages ?? [])
    .map((page): PageFilterDecision | null => {
      const pageNumber =
        typeof page.page_number === 'number'
          ? page.page_number
          : typeof page.page_number === 'string'
            ? Number.parseInt(page.page_number, 10)
            : NaN;
      const decision = (page.decision ?? '').trim().toLowerCase();

      if (!Number.isInteger(pageNumber) || pageNumber <= 0) {
        return null;
      }

      return {
        page_number: pageNumber,
        decision:
          decision === 'drop' || decision === 'review' ? decision : 'keep',
        reason: typeof page.reason === 'string' ? page.reason : '',
        confidence:
          typeof page.confidence === 'number' &&
          Number.isFinite(page.confidence)
            ? Math.max(0, Math.min(1, page.confidence))
            : null,
      };
    })
    .filter((page): page is PageFilterDecision => Boolean(page));
}

function getPageFilterDropExamplesDir() {
  const rawValue =
    getOptionalEnv('PDF_FILL_PAGE_FILTER_DROP_EXAMPLES_DIR')?.trim() ||
    PAGE_FILTER_DROP_EXAMPLES_DIR_DEFAULT;

  return isAbsolute(rawValue)
    ? resolve(rawValue)
    : resolve(process.cwd(), rawValue);
}

// Kept for future/manual page-filter tuning, but intentionally not used by
// the current automated page-preparation flow.
async function loadPageFilterDropExamplesFromFolder(): Promise<
  PageFilterDropExample[]
> {
  const examplesDir = getPageFilterDropExamplesDir();
  let entries: Array<{ isFile: () => boolean; name: string }>;

  try {
    entries = await readdir(examplesDir, { withFileTypes: true });
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;

    if (nodeError.code === 'ENOENT') {
      return [];
    }

    throw error;
  }

  const imageFiles = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((fileName) =>
      PAGE_FILTER_DROP_EXAMPLE_MIME_TYPES.has(extname(fileName).toLowerCase()),
    )
    .sort((left, right) => left.localeCompare(right))
    .slice(0, PAGE_FILTER_DROP_EXAMPLES_MAX);

  return Promise.all(
    imageFiles.map(async (fileName) => {
      const extension = extname(fileName).toLowerCase();
      const mimeType =
        PAGE_FILTER_DROP_EXAMPLE_MIME_TYPES.get(extension) ?? 'image/jpeg';
      const buffer = await readFile(resolve(examplesDir, fileName));

      return {
        file_name: fileName,
        image_data_url: `data:${mimeType};base64,${buffer.toString('base64')}`,
      };
    }),
  );
}

/*
function buildPageFilterPromptPayload(input: {
  documentName: string;
  pageNumbers: number[];
}) {
  return {
    task: '在文档槽位回填前，对扫描 PDF 页面图片进行页面过滤分类。',
    document_name: input.documentName,
    render_note:
      '候选页面图片由生产槽位回填流程使用的 PDF 转图片流程生成。',
    decision_options: {
      keep: '保留该页面，用于后续视觉槽位回填。',
      drop: '丢弃该页面。适用情况包括：密集合同条款页、长篇说明页、空白表单、没有真实填写值的空白联系/尾页、手写抵押物/质押物/担保物清单页，或只有极少量附带手写痕迹的合同正文页。不要把真实签署页、确认页、回执页、盖章页、签署日期页、身份证号页、责任人姓名页、借款人或银行确认文字页判为 drop。',
    },
    keep_guidance:
      '保留可能包含身份证、姓名、地址、电话、签名、印章、银行系统截图、还款/账户/余额字段、金额、日期、购车协议数值、合同签署/确认/回执内容、机动车登记证书或机动车登记摘要信息的页面。',
    vehicle_field_rule:
      '车辆相关槽位只应保留官方机动车登记证书或登记摘要页面作为来源页。手写抵押物/质押物/担保物清单页即使包含车牌、金额或日期，也应判为 drop。',
    dense_terms_sparse_handwriting_rule:
      '如果页面主体是密集打印合同条款、说明或正文，手写内容只占很小区域，例如一个姓名、短下划线、勾选、简短备注或小日期，应判为 drop。除非该页面明显是签署页、确认页、回执页，或包含完整签名栏、正式印章、身份证号、金额、账户/余额、机动车登记证数据、银行系统数据等强可复用槽位值。',
    signature_page_guardrail:
      '如果候选页面具有合同签署页、确认页、回执页等标题或内容，并且包含真实手写签名、红色印章/盖章、签署日期、身份证号、借款人/担保人/银行代表字段或确认文字，必须判为 keep。即使视觉上像合同尾页，只要有这些已填写的签名或印章信息，也应判为 keep。不确定时使用 keep，不要使用 drop。',
    page_numbers: input.pageNumbers,
    output_schema: {
      pages: [
        {
          page_number: 'page_numbers 中的一个页码',
          decision: 'keep | drop | review，必须使用英文枚举值',
          page_type:
            'id_card | agreement | signature_page | table | system_screenshot | vehicle_info | terms_page | dense_terms_sparse_handwriting | blank | other',
          reason: '简短中文原因',
          confidence: 0.9,
        },
      ],
    },
    strict_requirements: [
      '只返回紧凑 JSON，不要输出 Markdown、解释文字或全文转录。',
      '必须为每一个 page_number 返回一个结果。',
      'decision 字段只能使用英文值：keep、drop 或 review。',
      '不要丢弃身份证页、协议签署页、合同确认页、合同回执页、真实签名页、盖章页、签署日期页、身份证号页、系统截图页、还款/账户/余额页、机动车登记证书或登记摘要页。',
      '当页面是密集合同条款/正文页，且手写内容只是很小的附带痕迹时，即使有手写姓名、下划线、勾选、简短备注或小日期，也应判为 drop。',
      '手写抵押物/质押物/担保物清单页应判为 drop，即使其中包含手写车牌、金额或日期。',
      '不要仅因为页面有表格线或手写痕迹就保留；只有当它是当前槽位回填流程可靠的来源页时才判为 keep。',
      '如果页面同时具有 drop 特征和可用于回填的签名、印章、日期、身份证号、确认文字等强槽位值，应选择 decision="keep"。',
      '不确定时使用 decision="keep"，不要使用 decision="drop"。',
    ],
  };
}

*/
function buildReadablePageFilterPromptPayloadZh(input: {
  documentName: string;
  pageNumbers: number[];
}) {
  return {
    task: '在文档槽位回填前，对扫描 PDF 页面图片进行页面过滤分类。',
    document_name: input.documentName,
    render_note: '候选页面图片由槽位回填流程中的 PDF 转图片流程生成。',
    decision_options: {
      keep: '保留该页面，用于后续视觉槽位回填。',
      drop: '丢弃该页面。适用情况包括：密集合同条款页、长篇说明页、空白表单、没有真实填写值的空白联系/尾页、手写抵押物/质押物/担保物清单页，或只有少量附带手写痕迹的合同正文页。不要把真实签署页、确认页、回执页、盖章页、签署日期页、身份证号页、责任人姓名页、借款人或银行确认文字页判为 drop。',
    },
    keep_guidance:
      '保留可能包含身份证号、姓名、地址、电话、签名、印章、银行系统截图、还款账户/余额字段、金额、日期、购车协议数值、合同签署/确认/回执内容、机动车登记证书或机动车登记摘要信息的页面。',
    vehicle_field_rule:
      '车辆相关槽位优先保留官方机动车登记证书或登记摘要页面作为来源页。手写抵押物/质押物/担保物清单页即使包含车牌、金额或日期，也应判为 drop。',
    dense_terms_sparse_handwriting_rule:
      '如果页面主体是密集打印合同条款、说明或正文，手写内容只占很小区域，例如一个姓名、短下划线、勾选、简短备注或小日期，应判为 drop。除非该页面明显是签署页、确认页、回执页，或包含完整签名栏、正式印章、身份证号、金额、账户/余额、机动车登记证数据、银行系统数据等强可复用槽位值。',
    signature_page_guardrail:
      '如果候选页面具有合同签署页、确认页、回执页等标题或内容，并且包含真实手写签名、红色印章/盖章、签署日期、身份证号、借款人/担保人/银行代表字段或确认文字，必须判为 keep。即使视觉上像合同尾页，只要有这些已填写的签名或印章信息，也应判为 keep。不确定时使用 keep，不要使用 drop。',
    page_numbers: input.pageNumbers,
    output_schema: {
      pages: [
        {
          page_number: 'page_numbers 中的一个页码',
          decision: 'keep | drop | review，必须使用英文枚举值',
          reason: '简短中文原因',
          confidence: 0.9,
        },
      ],
    },
    strict_requirements: [
      '只返回紧凑 JSON，不要输出 Markdown、解释文字或全文转录。',
      '必须为每一个 page_number 返回一个结果。',
      'decision 字段只能使用英文值：keep、drop 或 review。',
      '不要丢弃身份证页、协议签署页、合同确认页、合同回执页、真实签名页、盖章页、签署日期页、身份证号页、系统截图页、还款账户/余额页、机动车登记证书或登记摘要页。',
      '当页面是密集合同条款/正文页，并且手写内容只是很小的附带痕迹时，即使有手写姓名、下划线、勾选、简短备注或小日期，也应判为 drop。',
      '手写抵押物/质押物/担保物清单页应判为 drop，即使其中包含手写车牌、金额或日期。',
      '不要仅因为页面有表格线或手写痕迹就保留；只有当它是当前槽位回填流程可靠的来源页时才判为 keep。',
      '如果页面同时具有 drop 特征和可用于回填的签名、印章、日期、身份证号、确认文字等强槽位值，应选择 decision="keep"。',
      '不确定时使用 decision="keep"，不要使用 decision="drop"。',
    ],
  };
}

function buildPageFilterPromptPayloadEn(input: {
  documentName: string;
  pageNumbers: number[];
}) {
  return {
    task: 'Classify scanned PDF page images before document slot filling.',
    document_name: input.documentName,
    render_note:
      'Candidate page images are produced by the same PDF-to-image pipeline used for downstream slot filling.',
    decision_options: {
      keep: 'Keep this page for downstream visual slot filling.',
      drop: 'Drop this page. Typical drop pages include dense contract terms, long explanatory pages, blank forms, empty contact or tail pages without real filled values, handwritten collateral/pledge/guarantee item lists, or dense contract text pages that only contain tiny incidental handwriting. Do not drop real signing pages, confirmation pages, receipt pages, stamped pages, signed-date pages, ID-number pages, responsible-person-name pages, borrower confirmation pages, or bank confirmation pages.',
      review:
        'Use review when the page is ambiguous. Review pages are kept for slot filling.',
    },
    keep_guidance:
      'Keep pages that may contain ID numbers, names, addresses, phone numbers, signatures, stamps, bank system screenshots, repayment account or balance fields, amounts, dates, vehicle purchase agreement values, contract signing/confirmation/receipt content, motor vehicle registration certificates, or motor vehicle registration summary information.',
    vehicle_field_rule:
      'For vehicle-related slots, prefer official motor vehicle registration certificate or registration summary pages as source pages. Handwritten collateral/pledge/guarantee item list pages should be dropped even if they contain handwritten plate numbers, amounts, or dates.',
    dense_terms_sparse_handwriting_rule:
      'If the page is mainly dense printed contract terms, instructions, or body text, and handwriting occupies only a tiny area such as one name, a short underline, a check mark, a brief note, or a small date, classify it as drop. Exception: keep it if the page is clearly a signing page, confirmation page, receipt page, or contains a complete signature area, official stamp, ID number, amount, account/balance value, motor vehicle registration data, or bank system data.',
    signature_page_guardrail:
      'If the candidate page has signing-page, confirmation-page, or receipt-page content and contains a real handwritten signature, red stamp, signed date, ID number, borrower/guarantor/bank-representative field, or confirmation text, classify it as keep. Even if it visually looks like a contract tail page, keep it when these filled signing or stamp details are present. When uncertain, use keep instead of drop.',
    page_numbers: input.pageNumbers,
    output_schema: {
      pages: [
        {
          page_number: 'one page number from page_numbers',
          decision: 'keep | drop | review',
          reason: 'short English reason',
          confidence: 0.9,
        },
      ],
    },
    strict_requirements: [
      'Return compact JSON only. Do not return Markdown, explanations, or full-page transcription.',
      'Return exactly one result for every page_number.',
      'The decision field must be one of these English values only: keep, drop, or review.',
      'Do not drop ID pages, agreement signing pages, contract confirmation pages, contract receipt pages, real signature pages, stamped pages, signed-date pages, ID-number pages, system screenshot pages, repayment account/balance pages, motor vehicle registration certificate pages, or motor vehicle registration summary pages.',
      'When a page is dense contract terms/body text and the handwriting is only a tiny incidental mark, classify it as drop even if it contains a handwritten name, underline, check mark, brief note, or small date.',
      'Handwritten collateral/pledge/guarantee item list pages should be classified as drop even if they contain handwritten plate numbers, amounts, or dates.',
      'Do not keep a page only because it has table lines or handwriting. Keep it only when it is a reliable source page for the current slot-filling workflow.',
      'If a page has both drop-like features and strong reusable slot values such as signature, stamp, date, ID number, or confirmation text, choose decision="keep".',
      'When uncertain, use decision="keep" instead of decision="drop".',
    ],
  };
}

async function classifyVisionPagesForSlotFill(params: {
  documentName: string;
  visionPages: PdfVisionPageInput[];
  usageAccumulator?: LlmUsageAccumulator;
  onTrace?: (trace: { message: string }) => Promise<void> | void;
}) {
  if (params.visionPages.length === 0) {
    return {
      decisions: [] as PageFilterDecision[],
      geminiFilesByPageNumber: new Map<number, PageFilterGeminiFileReference>(),
    };
  }

  const batchSize = getPageFilterBatchSize();
  const batches = [];

  for (let index = 0; index < params.visionPages.length; index += batchSize) {
    batches.push(params.visionPages.slice(index, index + batchSize));
  }

  const results: PageFilterDecision[] = [];
  const geminiFilesByPageNumber = new Map<
    number,
    PageFilterGeminiFileReference
  >();
  const llmConfig = getLlmRuntimeConfig('vision', PDF_FILL_LLM_OPTIONS);
  const traceConfig = getLlmRuntimeTraceConfig('vision', PDF_FILL_LLM_OPTIONS);

  await params.onTrace?.({
    message: `[PDF Fill][PageFilterConfig] ${JSON.stringify({
      route: '/api/generation-task-items/[taskItemId]/page-preparation',
      config_scope: 'VISION_LLM',
      model: traceConfig.model,
      provider: traceConfig.provider,
      thinking_enabled: traceConfig.thinkingEnabled,
      reasoning_effort: traceConfig.reasoningEffort,
      extra_body: traceConfig.extraBody,
      batch_size: batchSize,
      total_pages: params.visionPages.length,
    })}`,
  });

  for (const [batchIndex, batch] of batches.entries()) {
    const controller = new AbortController();
    const requestLabel = `page filter batch ${batchIndex + 1}/${batches.length}`;
    const timeoutId = setTimeout(
      () => controller.abort(),
      PAGE_FILTER_REQUEST_TIMEOUT_MS,
    );

    try {
      const pageFilterPromptPayload = buildPageFilterPromptPayloadEn({
        documentName: params.documentName,
        pageNumbers: batch.map((page) => page.page_number),
      });
      const content: Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
        | {
            type: 'gemini_file';
            gemini_file: NonNullable<PdfVisionPageInput['gemini_file']>;
          }
      > = [
        {
          type: 'text',
          text: JSON.stringify(pageFilterPromptPayload),
        },
      ];

      batch.forEach((page) => {
        content.push({
          type: 'text',
          text: `Uploaded PDF page ${page.page_number}`,
        });
        if (page.gemini_file) {
          content.push({
            type: 'gemini_file',
            gemini_file: page.gemini_file,
          });
        } else {
          content.push({
            type: 'image_url',
            image_url: { url: page.image_url ?? page.image_data_url },
          });
        }
      });

      const candidateImageSummaries = batch.map((page) => {
        const imageBytes =
          page.gemini_file?.sizeBytes ??
          estimateDataUrlBytes(page.image_data_url);

        return {
          label: `Uploaded PDF page ${page.page_number}`,
          page_number: page.page_number,
          has_image_data_url: !page.gemini_file && Boolean(page.image_data_url),
          has_gemini_file: Boolean(page.gemini_file),
          image_bytes: imageBytes,
          image_size: formatBytes(imageBytes),
        };
      });
      const candidateImageTotalBytes = candidateImageSummaries.reduce(
        (sum, page) => sum + page.image_bytes,
        0,
      );
      const requestImageTotalBytes = candidateImageTotalBytes;
      await params.onTrace?.({
        message:
          `[PDF Fill][PageFilter] Starting visual page filter batch ${batchIndex + 1}/${batches.length} ` +
          `for ${params.documentName}, pages=${batch.map((page) => page.page_number).join(',')}, ` +
          `vision image total size=${formatBytes(requestImageTotalBytes)}, ` +
          `candidate page images=${formatBytes(candidateImageTotalBytes)}.`,
      });
      await params.onTrace?.({
        message: `[PDF Fill][PageFilterPrompt][batch ${batchIndex + 1}/${batches.length}] ${JSON.stringify(
          {
            route: '/api/generation-task-items/[taskItemId]/page-preparation',
            config_scope: 'VISION_LLM',
            model: traceConfig.model,
            provider: traceConfig.provider,
            thinking_enabled: traceConfig.thinkingEnabled,
            reasoning_effort: traceConfig.reasoningEffort,
            extra_body: traceConfig.extraBody,
            request_label: requestLabel,
            image_payload: {
              request_image_total_bytes: requestImageTotalBytes,
              request_image_total_size: formatBytes(requestImageTotalBytes),
              candidate_page_count: candidateImageSummaries.length,
              candidate_image_total_bytes: candidateImageTotalBytes,
              candidate_image_total_size: formatBytes(candidateImageTotalBytes),
            },
            messages: [
              {
                role: 'system',
                content: PAGE_FILTER_SYSTEM_PROMPT_EN,
              },
              {
                role: 'user',
                content: pageFilterPromptPayload,
              },
            ],
            image_placeholders: candidateImageSummaries,
          },
        )}`,
      });

      const requestBody = withProviderJsonResponseFormat(
        buildChatCompletionBody(llmConfig, {
          messages: [
            {
              role: 'system',
              content: PAGE_FILTER_SYSTEM_PROMPT_EN,
            },
            {
              role: 'user',
              content,
            },
          ],
        }),
        {
          provider: llmConfig.provider,
          model: llmConfig.model,
          name: 'pdf_fill_page_filter',
          schema: geminiPageFilterResponseSchema,
        },
      );
      let payload: {
        choices?: Array<{ message?: { content?: string } }>;
      };
      let usagePayload: unknown;

      if (llmConfig.provider === 'gemini') {
        // await inspectGeminiImageProxyUrls({
        //   pages: batch,
        //   batchLabel: `${batchIndex + 1}/${batches.length}`,
        //   signal: controller.signal,
        //   onTrace: params.onTrace,
        // });

        const geminiResult = await callGeminiNativeChatCompletion({
          config: llmConfig,
          body: requestBody,
          requestLabel,
          dispatcher: llmFetchDispatcher,
          signal: controller.signal,
          structuredOutput: {
            responseMimeType: 'application/json',
            responseSchema: geminiPageFilterResponseSchema,
          },
          onGenerateContentRequestBody: async ({
            requestBody: nativeRequestBody,
          }) => {
            await params.onTrace?.({
              message: `[PDF Fill][PageFilterGeminiNativeRequest][batch ${batchIndex + 1}/${batches.length}] ${JSON.stringify(
                {
                  route:
                    '/api/generation-task-items/[taskItemId]/page-preparation',
                  config_scope: 'VISION_LLM',
                  model: traceConfig.model,
                  provider: traceConfig.provider,
                  request_label: requestLabel,
                  request_mode: 'gemini_native_generate_content_file_api',
                  candidate_file_api_file_count: batch.filter(
                    (page) => page.gemini_file,
                  ).length,
                  file_api_uris: batch.flatMap((page) =>
                    page.gemini_file?.uri ? [page.gemini_file.uri] : [],
                  ),
                  request_body: nativeRequestBody,
                },
              )}`,
            });
          },
          onTrace: params.onTrace,
        });

        batch.forEach((page) => {
          const file = page.gemini_file;

          if (!file?.uri) {
            return;
          }

          geminiFilesByPageNumber.set(
            page.page_number,
            toPageFilterGeminiFileReference(file, requestLabel),
          );
        });

        payload = geminiResult.payload;
        usagePayload = geminiResult.responsePayload;
      } else {
        const upstream = await undiciFetch(llmConfig.chatCompletionsUrl, {
          method: 'POST',
          headers: buildChatCompletionHeaders(llmConfig),
          dispatcher: llmFetchDispatcher,
          signal: controller.signal,
          body: JSON.stringify(requestBody),
        });

        if (!upstream.ok) {
          const details = await upstream.text();
          throw new Error(
            `Vision page filter request failed (${upstream.status}): ${details}`,
          );
        }

        payload = (await upstream.json()) as typeof payload;
        usagePayload = payload;
      }
      recordLlmUsageFromPayload(params.usageAccumulator, {
        phase: 'pdf_fill_page_filter',
        provider: llmConfig.provider,
        model: llmConfig.model,
        requestLabel,
        payload: usagePayload,
      });
      const rawContent = payload.choices?.[0]?.message?.content ?? '';
      const batchResults = parsePageFilterJson(rawContent);

      results.push(...batchResults);
      await params.onTrace?.({
        message: `[PDF Fill][PageFilterRaw][batch ${batchIndex + 1}/${batches.length}] ${JSON.stringify(
          {
            route: '/api/generation-task-items/[taskItemId]/page-preparation',
            config_scope: 'VISION_LLM',
            model: llmConfig.model,
            provider: traceConfig.provider,
            request_label: `page filter batch ${batchIndex + 1}/${batches.length}`,
            page_numbers: batch.map((page) => page.page_number),
            raw_response: rawContent,
            parsed_results: batchResults,
          },
        )}`,
      });
      await params.onTrace?.({
        message: `[PDF Fill][PageFilter] Completed visual page filter batch ${batchIndex + 1}/${batches.length} for ${params.documentName}; decisions=${JSON.stringify(batchResults)}.`,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  const decisionByPage = new Map(
    results.map((page) => [page.page_number, page]),
  );

  const decisions = params.visionPages.map((page) => {
    const decision = decisionByPage.get(page.page_number);

    return (
      decision ?? {
        page_number: page.page_number,
        decision: 'review' as const,
        reason: 'No model decision returned for this page.',
        confidence: null,
      }
    );
  });

  return {
    decisions,
    geminiFilesByPageNumber,
  };
}

async function runGenerationTaskItemPagePreparation(params: {
  item: GenerationTaskItemRecord;
  actorEmail: string | null;
}) {
  const admin = createSupabaseAdminClient();
  const startedAt = new Date();
  const pageFilterUsageAccumulator = createLlmUsageAccumulator();
  const slotSchema: GenerationSlotSchemaItem[] = Array.isArray(
    params.item.llm_input?.slot_schema,
  )
    ? params.item.llm_input.slot_schema
    : [];
  const hasReferencePdfEvidence = slotSchema.some(
    hasUsableReferencePdfEvidence,
  );
  const precomputedVisionPages = normalizeVisionPages(
    params.item.llm_input?.vision_pages,
  );
  const pageImageAssets = normalizePdfPageImageAssets(
    params.item.llm_input?.ocr_image_assets,
  );
  // normalizeSelectedOriginalPageNumbers is kept in runtime.ts for compatibility,
  // but this flow now relies on prepared page image assets directly.

  try {
    if (slotSchema.length === 0) {
      throw new Error('当前模板缺少槽位定义，请重新保存模板后再试。');
    }

    if (precomputedVisionPages.length === 0 && pageImageAssets.length === 0) {
      throw new Error(
        '当前任务缺少可用于视觉回填的新 PDF 页面图片，请重新创建批量任务。',
      );
    }

    await admin
      .from('generation_task_items')
      .update({
        status: 'page_preparing',
        error_message: null,
        started_at: params.item.started_at ?? startedAt.toISOString(),
        finished_at: null,
        updated_at: startedAt.toISOString(),
        slot_total_count: slotSchema.length,
        slot_completed_count: 0,
        page_filter_llm_usage: null,
        processing_trace: '',
      })
      .eq('id', params.item.id);

    await admin
      .from('generation_tasks')
      .update({
        status: 'running',
        started_at: params.item.started_at ?? startedAt.toISOString(),
      })
      .eq('id', params.item.task_id);

    await appendProcessingTrace(
      admin,
      params.item.id,
      `开始准备新 PDF 页面图片：${params.item.source_pdf_name}，共 ${slotSchema.length} 个槽位。`,
    );
    await appendProcessingTrace(
      admin,
      params.item.id,
      `页面准备路由：/api/generation-task-items/${params.item.id}/page-preparation`,
    );
    await appendProcessingTrace(
      admin,
      params.item.id,
      '当前流程正在准备 PDF 页面图片并进行视觉页面过滤；过滤完成后会等待用户确认用于回填的页面。',
    );

    await appendMemoryTrace(admin, params.item.id, 'route_started', {
      source_pdf_name: params.item.source_pdf_name,
      page_image_asset_count: pageImageAssets.length,
      precomputed_vision_page_count: precomputedVisionPages.length,
    });

    await logEvent({
      ownerId: params.item.owner_id,
      actorEmail: params.actorEmail,
      level: 'info',
      eventType: 'generation_task_item_pdf_pages_ready_started',
      message: `Started PDF page preparation for ${params.item.source_pdf_name}.`,
      route: '/api/generation-task-items/[taskItemId]/page-preparation',
      templateId: params.item.template_id,
      taskId: params.item.task_id,
      taskItemId: params.item.id,
      payload: {
        slotCount: slotSchema.length,
        visionPageCount: precomputedVisionPages.length,
        pageImageAssetCount: pageImageAssets.length,
        hasReferencePdfEvidence,
      },
    });

    let nextPageImageAssets = pageImageAssets;
    let pageFilterErrorMessage: string | null = null;
    let geminiFileByPageNumberFromPipeline = new Map<
      number,
      PageFilterGeminiFileReference
    >();

    if (pageImageAssets.length > 0 && hasReferencePdfEvidence) {
      nextPageImageAssets = pageImageAssets.map((asset) => ({
        ...asset,
        filter_decision: 'keep',
        filter_reason:
          'Template has reviewed PDF reference bbox evidence; page filtering is skipped so reference-page alignment can choose matching pages during slot fill.',
        filter_confidence: null,
        used_for_slot_fill: true,
      }));

      await appendProcessingTrace(
        admin,
        params.item.id,
        `[PDF Fill][PageFilterSkipped] ${JSON.stringify({
          source_pdf_name: params.item.source_pdf_name,
          reason: 'reference_pdf_evidence_available',
          page_count: nextPageImageAssets.length,
          referenced_slot_count: slotSchema.filter(
            hasUsableReferencePdfEvidence,
          ).length,
        })}`,
      );
      await appendMemoryTrace(admin, params.item.id, 'page_filter_skipped', {
        source_pdf_name: params.item.source_pdf_name,
        reason: 'reference_pdf_evidence_available',
        page_count: nextPageImageAssets.length,
      });
    } else if (pageImageAssets.length > 0) {
      try {
        const llmConfig = getLlmRuntimeConfig('vision', PDF_FILL_LLM_OPTIONS);
        const precomputedVisionPagesForFilter: PdfVisionPageInput[] =
          precomputedVisionPages.map((page) => ({
            page_number: page.page_number,
            image_data_url: page.image_data_url,
            image_url: page.image_url,
            original_page_number: page.original_page_number ?? page.page_number,
          }));
        const shouldBuildGeminiFileApiVisionPages =
          precomputedVisionPages.length === 0 &&
          llmConfig.provider === 'gemini';
        const shouldBuildSupabaseSignedUrlVisionPages =
          precomputedVisionPages.length === 0 &&
          llmConfig.provider === 'doubao';
        let pipelineVisionPages: PdfVisionPageInput[] = [];

        if (shouldBuildGeminiFileApiVisionPages) {
          pipelineVisionPages = await buildStoredPageImageFileApiVisionPages({
            admin,
            pageImageAssets,
            config: llmConfig,
            requestLabel: `page filter ${params.item.id}`,
            onTrace: async ({ message }) => {
              await appendProcessingTrace(admin, params.item.id, message);
            },
          });
        } else if (shouldBuildSupabaseSignedUrlVisionPages) {
          /*
          // Previous Doubao path used the Vercel image proxy here. Keep the
          // proxy helper available for rollback/comparison; Doubao now uses
          // Supabase signed URLs directly.
          // pipelineVisionPages = await buildStoredPageImageProxyVisionPages({
          //   pageImageAssets,
          //   requestLabel: `page filter ${params.item.id}`,
          //   onTrace: async ({ message }) => {
          //     await appendProcessingTrace(admin, params.item.id, message);
          //   },
          // });
          */
          pipelineVisionPages =
            await buildStoredPageImageSupabaseSignedUrlVisionPages({
              admin,
              pageImageAssets,
              requestLabel: `page filter ${params.item.id}`,
              onTrace: async ({ message }) => {
                await appendProcessingTrace(admin, params.item.id, message);
              },
            });
        }
        geminiFileByPageNumberFromPipeline = new Map(
          pipelineVisionPages.flatMap((page) =>
            page.gemini_file
              ? [
                  [
                    page.page_number,
                    toPageFilterGeminiFileReference(
                      page.gemini_file,
                      `page filter ${params.item.id}`,
                    ),
                  ] as const,
                ]
              : [],
          ),
        );
        let visionPagesForFilter: PdfVisionPageInput[];

        if (precomputedVisionPagesForFilter.length > 0) {
          visionPagesForFilter = precomputedVisionPagesForFilter;
        } else if (pipelineVisionPages.length > 0) {
          visionPagesForFilter = pipelineVisionPages;
        } else {
          visionPagesForFilter = await loadVisionPagesFromStoredAssets({
            admin,
            pageImageAssets,
          });
        }
        await appendMemoryTrace(admin, params.item.id, 'page_filter_start', {
          source_pdf_name: params.item.source_pdf_name,
          page_count: visionPagesForFilter.length,
        });
        const pageFilterResult = await classifyVisionPagesForSlotFill({
          documentName: params.item.source_pdf_name,
          visionPages: visionPagesForFilter,
          usageAccumulator: pageFilterUsageAccumulator,
          onTrace: async ({ message }) => {
            await appendProcessingTrace(admin, params.item.id, message);
          },
        });
        await appendMemoryTrace(admin, params.item.id, 'page_filter_done', {
          source_pdf_name: params.item.source_pdf_name,
          decision_count: pageFilterResult.decisions.length,
        });
        const pageFilterDecisions = pageFilterResult.decisions;
        const decisionByPageNumber = new Map(
          pageFilterDecisions.map((decision) => [
            decision.page_number,
            decision,
          ]),
        );

        nextPageImageAssets = pageImageAssets.map((asset) => {
          const decision = decisionByPageNumber.get(asset.uploaded_page_number);
          const normalizedDecision = decision?.decision ?? 'review';

          return {
            ...asset,
            gemini_file:
              pageFilterResult.geminiFilesByPageNumber.get(
                asset.uploaded_page_number,
              ) ??
              geminiFileByPageNumberFromPipeline.get(
                asset.uploaded_page_number,
              ) ??
              asset.gemini_file ??
              null,
            filter_decision: normalizedDecision,
            filter_reason:
              decision?.reason ??
              'No visual page filter decision was returned for this page.',
            filter_confidence: decision?.confidence ?? null,
            used_for_slot_fill: normalizedDecision !== 'drop',
          };
        });
      } catch (filterError) {
        pageFilterErrorMessage = getErrorMessage(filterError);
        nextPageImageAssets = pageImageAssets.map((asset) => ({
          ...asset,
          gemini_file:
            geminiFileByPageNumberFromPipeline.get(
              asset.uploaded_page_number,
            ) ??
            asset.gemini_file ??
            null,
          filter_decision: 'review',
          filter_reason:
            'Visual page filtering failed; keeping this page for manual confirmation.',
          filter_confidence: null,
          used_for_slot_fill: true,
        }));

        await appendProcessingTrace(
          admin,
          params.item.id,
          `[PDF Fill][RawError][PageFilter] ${pageFilterErrorMessage}`,
        );
        await appendProcessingTrace(
          admin,
          params.item.id,
          `[RouteErrorDetails][PageFilter] ${JSON.stringify(
            buildErrorLogPayload(filterError, {
              sourcePdfName: params.item.source_pdf_name,
              slotCount: slotSchema.length,
              visionPageCount: precomputedVisionPages.length,
              pageImageAssetCount: pageImageAssets.length,
            }),
          )}`,
        );
        await appendProcessingTrace(
          admin,
          params.item.id,
          `[PDF Fill][PageFilter] Visual page filter failed, keeping all pages for user confirmation: ${pageFilterErrorMessage}`,
        );
      }
    }

    const keptPageCount = nextPageImageAssets.filter(
      (asset) => asset.used_for_slot_fill !== false,
    ).length;
    const droppedPageCount = nextPageImageAssets.filter(
      (asset) => asset.used_for_slot_fill === false,
    ).length;
    const reviewPageCount = nextPageImageAssets.filter(
      (asset) => asset.filter_decision === 'review',
    ).length;

    const elapsedSeconds = Math.max(
      1,
      Math.round(
        (Date.now() -
          new Date(
            params.item.started_at ?? startedAt.toISOString(),
          ).getTime()) /
          1000,
      ),
    );
    const visionTraceConfig = getLlmRuntimeTraceConfig(
      'vision',
      PDF_FILL_LLM_OPTIONS,
    );
    const pageFilterLlmUsage =
      pageFilterUsageAccumulator.calls.length > 0
        ? summarizeLlmUsage(pageFilterUsageAccumulator, {
            provider: visionTraceConfig.provider,
            model: visionTraceConfig.model,
            modelEnvName: visionTraceConfig.modelEnvName,
          })
        : null;

    const { data: updatedItem, error: updatedItemError } = await admin
      .from('generation_task_items')
      .update({
        status: 'pdf_pages_ready',
        elapsed_seconds: elapsedSeconds,
        page_filter_llm_usage: pageFilterLlmUsage,
        llm_input: {
          ...(params.item.llm_input ?? {}),
          pages: [],
          total_text_length: 0,
          ocr_image_assets: nextPageImageAssets,
          page_filter: {
            completed_at: new Date().toISOString(),
            total_page_count: nextPageImageAssets.length,
            kept_page_count: keptPageCount,
            dropped_page_count: droppedPageCount,
            review_page_count: reviewPageCount,
            model: visionTraceConfig.model,
            provider: visionTraceConfig.provider,
            ...(hasReferencePdfEvidence
              ? {
                  skipped: true,
                  skipped_reason: 'reference_pdf_evidence_available',
                }
              : {}),
            ...(pageFilterErrorMessage
              ? { error_message: pageFilterErrorMessage }
              : {}),
          },
        },
        slot_total_count: slotSchema.length,
        slot_completed_count: 0,
        updated_at: new Date().toISOString(),
      })
      .eq('id', params.item.id)
      .select('id, status')
      .single();
    await appendMemoryTrace(admin, params.item.id, 'page_filter_persisted', {
      total_page_count: nextPageImageAssets.length,
      kept_page_count: keptPageCount,
      dropped_page_count: droppedPageCount,
      review_page_count: reviewPageCount,
    });

    if (updatedItemError) {
      throw updatedItemError;
    }

    if (!updatedItem || updatedItem.status !== 'pdf_pages_ready') {
      throw new Error(
        'PDF page ready status was not persisted correctly before slot-fill handoff.',
      );
    }

    await recalculateTaskSummary(admin, params.item.task_id);
    await appendProcessingTrace(
      admin,
      params.item.id,
      `[PDF Fill][PageFilterAutoSelection] ${JSON.stringify({
        source_pdf_name: params.item.source_pdf_name,
        kept_pages: nextPageImageAssets
          .filter((asset) => asset.used_for_slot_fill !== false)
          .map((asset) => ({
            uploaded_page_number: asset.uploaded_page_number,
            original_page_number: asset.original_page_number,
            decision: asset.filter_decision ?? null,
            reason: asset.filter_reason ?? null,
          })),
        filtered_pages: nextPageImageAssets
          .filter((asset) => asset.used_for_slot_fill === false)
          .map((asset) => ({
            uploaded_page_number: asset.uploaded_page_number,
            original_page_number: asset.original_page_number,
            decision: asset.filter_decision ?? null,
            reason: asset.filter_reason ?? null,
          })),
      })}`,
    );
    await appendProcessingTrace(
      admin,
      params.item.id,
      hasReferencePdfEvidence
        ? `[PDF Fill][PageFilter] PDF page images prepared; visual filtering was skipped because reviewed PDF reference bbox evidence is available. total=${nextPageImageAssets.length}, kept=${keptPageCount}, dropped=${droppedPageCount}, review=${reviewPageCount}. Slot fill will align reference pages to uploaded PDF pages.`
        : `[PDF Fill][PageFilter] PDF page images prepared and visually filtered: total=${nextPageImageAssets.length}, kept=${keptPageCount}, dropped=${droppedPageCount}, review=${reviewPageCount}. Browser will automatically start slot fill with kept/review pages.`,
    );
    await appendProcessingTrace(
      admin,
      params.item.id,
      `Next route after user confirmation: /api/generation-task-items/${params.item.id}/slot-fill`,
    );
    /*
    await appendProcessingTrace(
      admin,
      params.item.id,
      `新 PDF 页面图片准备完成：共 ${precomputedVisionPages.length || pageImageAssets.length} 页，已完成视觉页面过滤，等待用户确认用于回填的页面。`,
    );
    await appendProcessingTrace(
      admin,
      params.item.id,
      'PDF 页面图片已准备完成，前端轮询检测到后将显示页面确认区域。',
    );
    await appendProcessingTrace(
      admin,
      params.item.id,
      `下一步路由：/api/generation-task-items/${params.item.id}/slot-fill`,
    );

    */

    await logEvent({
      ownerId: params.item.owner_id,
      actorEmail: params.actorEmail,
      level: 'info',
      eventType: 'generation_task_item_pdf_pages_ready_completed',
      message: `PDF pages prepared for ${params.item.source_pdf_name}.`,
      route: '/api/generation-task-items/[taskItemId]/page-preparation',
      templateId: params.item.template_id,
      taskId: params.item.task_id,
      taskItemId: params.item.id,
      payload: {
        visionPageCount: precomputedVisionPages.length,
        pageImageAssetCount: pageImageAssets.length,
        elapsedSeconds,
        keptPageCount,
        droppedPageCount,
        reviewPageCount,
        hasReferencePdfEvidence,
      },
    });
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    const failedAt = new Date().toISOString();
    const cleanupConfig = getLlmRuntimeConfig('vision', PDF_FILL_LLM_OPTIONS);

    if (cleanupConfig.provider === 'gemini') {
      await cleanupGeminiFileApiFilesForTrace({
        config: cleanupConfig,
        files: collectGeminiFileApiFilesFromAssets(pageImageAssets),
        requestLabel: `page preparation failed ${params.item.id}`,
        onTrace: async ({ message }) => {
          await appendProcessingTrace(admin, params.item.id, message);
        },
      });
    }

    await admin
      .from('generation_task_items')
      .update({
        status: 'failed',
        error_message: errorMessage,
        slot_total_count: slotSchema.length,
        slot_completed_count: 0,
        finished_at: failedAt,
        updated_at: failedAt,
      })
      .eq('id', params.item.id);

    await appendProcessingTrace(
      admin,
      params.item.id,
      `[PDF Fill][PagePreparation] Page preparation failed; slot fill cannot continue: ${errorMessage}`,
    );
    await appendProcessingTrace(
      admin,
      params.item.id,
      `[PDF Fill][RawError][PagePreparation] ${errorMessage}`,
    );
    await appendMemoryTrace(admin, params.item.id, 'route_failed', {
      error_message: errorMessage,
      source_pdf_name: params.item.source_pdf_name,
      slot_count: slotSchema.length,
      vision_page_count: precomputedVisionPages.length,
      page_image_asset_count: pageImageAssets.length,
    });
    await appendProcessingTrace(
      admin,
      params.item.id,
      `[RouteErrorDetails][PagePreparation] ${JSON.stringify(
        buildErrorLogPayload(error, {
          sourcePdfName: params.item.source_pdf_name,
          slotCount: slotSchema.length,
          visionPageCount: precomputedVisionPages.length,
          pageImageAssetCount: pageImageAssets.length,
        }),
      )}`,
    );

    await recalculateTaskSummary(admin, params.item.task_id);

    await logEvent({
      ownerId: params.item.owner_id,
      actorEmail: params.actorEmail,
      level: 'error',
      eventType: 'generation_task_item_pdf_pages_ready_failed',
      message: errorMessage,
      route: '/api/generation-task-items/[taskItemId]/page-preparation',
      templateId: params.item.template_id,
      taskId: params.item.task_id,
      taskItemId: params.item.id,
      payload: buildErrorLogPayload(error, {
        sourcePdfName: params.item.source_pdf_name,
        slotCount: slotSchema.length,
        visionPageCount: precomputedVisionPages.length,
        pageImageAssetCount: pageImageAssets.length,
      }),
    });
  }
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ taskItemId: string }> },
) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return createUnauthorizedResponse();
  }

  const admin = createSupabaseAdminClient();

  try {
    const { taskItemId } = await context.params;
    const { data: item, error: itemError } = await admin
      .from('generation_task_items')
      .select(generationTaskItemSelect)
      .eq('id', taskItemId)
      .is('deleted_at', null)
      .single<GenerationTaskItemRecord>();

    if (itemError || !item) {
      return NextResponse.json(
        {
          code: 'GENERATION_TASK_ITEM_NOT_FOUND',
          message: '未找到该任务项。',
        },
        { status: 404 },
      );
    }

    if (item.owner_id !== user.id) {
      return createUnauthorizedResponse();
    }

    if (
      [
        'review_pending',
        'reviewed',
        'succeeded',
        'pdf_pages_ready',
        'slot_filling',
      ].includes(item.status)
    ) {
      return NextResponse.json({
        data: {
          item: buildPagePreparationResponseItem(item),
        },
      });
    }

    if (['running', 'page_preparing', 'ocr_running'].includes(item.status)) {
      return NextResponse.json({
        data: {
          item: buildPagePreparationResponseItem(item),
        },
      });
    }

    after(async () => {
      await runGenerationTaskItemPagePreparation({
        item,
        actorEmail: user.email ?? null,
      });
    });

    const phaseStartedAt = new Date().toISOString();

    return NextResponse.json(
      {
        data: {
          item: buildPagePreparationResponseItem({
            ...item,
            status: 'page_preparing',
            slot_total_count: Array.isArray(item.llm_input?.slot_schema)
              ? item.llm_input.slot_schema.length
              : 0,
            slot_completed_count: 0,
            processing_trace: '',
            error_message: null,
            updated_at: phaseStartedAt,
          }),
        },
      },
      { status: 202 },
    );
  } catch (error) {
    const { taskItemId } = await context.params;
    const message = getErrorMessage(error);

    await logEvent({
      ownerId: user.id,
      actorEmail: user.email ?? null,
      level: 'error',
      eventType: 'generation_task_item_pdf_pages_ready_request_failed',
      message,
      route: '/api/generation-task-items/[taskItemId]/page-preparation',
      taskItemId,
      payload: buildErrorLogPayload(error),
    });

    return NextResponse.json(
      {
        code: 'GENERATION_TASK_ITEM_PDF_PAGES_READY_FAILED',
        message,
      },
      { status: 500 },
    );
  }
}
