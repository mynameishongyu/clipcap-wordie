import { after, NextResponse } from 'next/server';
import { readdir, readFile } from 'fs/promises';
import { extname, isAbsolute, resolve } from 'path';
import { Agent, fetch as undiciFetch } from 'undici';
import {
  appendProcessingTrace,
  buildFallbackReviewPayload,
  createUnauthorizedResponse,
  generationTaskItemSelect,
  type GenerationTaskItemRecord,
  getErrorMessage,
  loadVisionPagesFromStoredAssets,
  normalizePdfPageImageAssets,
  normalizeSelectedOriginalPageNumbers,
  normalizeVisionPages,
  recalculateTaskSummary,
} from '@/src/lib/generation-task-items/runtime';
import { getOptionalEnv } from '@/src/lib/llm/env';
import {
  buildChatCompletionBody,
  getLlmRuntimeConfig,
  getLlmRuntimeTraceConfig,
} from '@/src/lib/llm/provider';
import { buildErrorLogPayload, logEvent } from '@/src/lib/logging/log-event';
import { createSupabaseAdminClient } from '@/src/lib/supabase/admin';
import { createSupabaseServerClient } from '@/src/lib/supabase/server';

export const runtime = 'nodejs';
export const maxDuration = 300;

const PAGE_FILTER_BATCH_SIZE_DEFAULT = 4;
const PAGE_FILTER_BATCH_SIZE_MAX = 12;
const PAGE_FILTER_REQUEST_TIMEOUT_MS = 180000;
const PAGE_FILTER_DROP_EXAMPLES_DIR_DEFAULT = 'pdf_page_filter_drop_examples';
const PAGE_FILTER_DROP_EXAMPLES_MAX = 4;
const PAGE_FILTER_DROP_EXAMPLE_MIME_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
]);
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

function getPageFilterBatchSize() {
  const rawValue = getOptionalEnv('PDF_FILL_PAGE_FILTER_PAGES_PER_REQUEST');
  const parsedValue = rawValue ? Number(rawValue) : PAGE_FILTER_BATCH_SIZE_DEFAULT;

  if (!Number.isInteger(parsedValue) || parsedValue < 1) {
    return PAGE_FILTER_BATCH_SIZE_DEFAULT;
  }

  return Math.min(PAGE_FILTER_BATCH_SIZE_MAX, parsedValue);
}

function normalizeJsonText(rawContent: string) {
  const trimmed = rawContent.trim();
  const withoutCodeFence = trimmed
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const firstBrace = withoutCodeFence.indexOf('{');
  const lastBrace = withoutCodeFence.lastIndexOf('}');

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return withoutCodeFence.slice(firstBrace, lastBrace + 1);
  }

  return withoutCodeFence;
}

function parsePageFilterJson(rawContent: string) {
  const parsed = JSON.parse(normalizeJsonText(rawContent)) as {
    pages?: Array<{
      page_number?: number | string;
      decision?: string;
      reason?: string;
      confidence?: number;
    }>;
  };

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

async function loadPageFilterDropExamplesFromFolder(): Promise<PageFilterDropExample[]> {
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

function buildPageFilterPromptPayload(input: {
  documentName: string;
  pageNumbers: number[];
  dropExampleCount: number;
}) {
  return {
    task:
      'Classify scanned PDF page images before a document slot-fill workflow.',
    document_name: input.documentName,
    render_note:
      'Candidate pages were rendered with the same PDF-to-image process used by the production slot-fill workflow.',
    decision_options: {
      keep: 'Keep this page for later visual slot filling.',
      drop:
        'Drop this page because it is similar to the provided irrelevant examples, because it is a dense contract terms/body page with only tiny incidental handwriting, or because it is a handwritten collateral/pledge/mortgage list page that should not be used as a slot-fill source. Do not use drop for real contract signing/confirmation pages with actual signatures, stamps, dates, IDs, responsible-person names, or borrower/bank acknowledgement text.',
      review:
        'Uncertain. Keep for human review instead of dropping automatically.',
    },
    drop_examples_meaning:
      input.dropExampleCount > 0
        ? 'Drop examples are pages that should be filtered out. They are usually dense contract terms, long explanation pages, contract body pages with mostly printed text and only very small incidental handwriting, blank forms, empty contact/tail pages with no real filled values, or handwritten collateral/mortgage/pledge list pages. Even if a handwritten collateral list contains car plates, amounts, or dates, classify it as drop. However, do not generalize drop examples to contract signing or acknowledgement pages that contain real signatures, stamps, signing dates, ID numbers, borrower names, bank/agent stamps, or confirmation statements.'
        : 'No user-provided drop examples are attached. Use the built-in rules to identify dense contract terms, long explanation pages, blank forms, empty contact/tail pages with no real filled values, and handwritten collateral/mortgage/pledge list pages.',
    keep_guidance:
      'Keep pages that may contain identity cards, names, addresses, phone numbers, signatures, stamps, bank system screenshots, repayment/account/balance fields, amounts, dates, purchase agreement values, contract signing/confirmation/acknowledgement content, or official motor vehicle registration certificate / registration summary information.',
    vehicle_field_rule:
      'For vehicle-related slots, keep only official vehicle registration certificate / registration summary pages as source pages. Drop handwritten collateral/mortgage/pledge list pages even when they contain vehicle information.',
    dense_terms_sparse_handwriting_rule:
      'If the page is dominated by dense printed contract clauses, terms, explanations, or body text, and handwriting occupies only a tiny area such as one name, a short underline, a check mark, a brief note, or a small date, classify it as drop unless the page is clearly a signing/confirmation/acknowledgement page or contains strong reusable slot values such as full signature block, official stamp, ID number, amount, account/balance, vehicle registration certificate data, or bank system data.',
    signature_page_guardrail:
      'A candidate page that has a title or content like contract signing page / acknowledgement page / confirmation page, plus real handwriting signatures, red seals/stamps, signing date, ID number, borrower/guarantor/bank representative fields, or confirmation text, must be classified as keep. If it visually resembles a contract tail page but contains these filled signature or stamp values, use keep. If uncertain, use review, never drop.',
    page_numbers: input.pageNumbers,
    output_schema: {
      pages: input.pageNumbers.map((pageNumber) => ({
        page_number: pageNumber,
        decision: 'keep | drop | review',
        page_type:
          'id_card | agreement | signature_page | table | system_screenshot | vehicle_info | terms_page | dense_terms_sparse_handwriting | blank | other',
        reason: 'short reason in Chinese',
        confidence: 0.9,
      })),
    },
    strict_requirements: [
      'Return compact JSON only.',
      'Return one result for every page_number.',
      'Do not transcribe full page text.',
      'Do not drop identity cards, agreement signature pages, contract acknowledgement/confirmation pages, pages with real signatures/stamps/signing dates/ID numbers, system screenshots, repayment/account/balance pages, or official vehicle registration certificate/summary pages.',
      'Drop dense contract terms/body pages when handwriting is visually minor and incidental, even if there is a handwritten name, underline, check mark, brief note, or small date.',
      'Drop handwritten collateral/mortgage/pledge list pages even if they contain handwritten car plates, amounts, or dates.',
      'Do not keep a page merely because it has table lines or handwriting; keep it only when it is a reliable source page for the current slot-fill workflow.',
      'If a page has both drop-like layout and keep-worthy signature/stamp/date/ID/acknowledgement values, choose decision="keep".',
      'If uncertain, use decision="review" instead of decision="drop".',
    ],
  };
}

async function classifyVisionPagesForSlotFill(params: {
  documentName: string;
  visionPages: Awaited<ReturnType<typeof loadVisionPagesFromStoredAssets>>;
  dropExamples: PageFilterDropExample[];
  onTrace?: (trace: { message: string }) => Promise<void> | void;
}) {
  if (params.visionPages.length === 0) {
    return [];
  }

  const batchSize = getPageFilterBatchSize();
  const batches = [];

  for (let index = 0; index < params.visionPages.length; index += batchSize) {
    batches.push(params.visionPages.slice(index, index + batchSize));
  }

  const results: PageFilterDecision[] = [];
  const llmConfig = getLlmRuntimeConfig('vision');
  const traceConfig = getLlmRuntimeTraceConfig('vision');

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
      drop_example_count: params.dropExamples.length,
    })}`,
  });

  for (const [batchIndex, batch] of batches.entries()) {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      PAGE_FILTER_REQUEST_TIMEOUT_MS,
    );

    try {
      const pageFilterPromptPayload = buildPageFilterPromptPayload({
        documentName: params.documentName,
        pageNumbers: batch.map((page) => page.page_number),
        dropExampleCount: params.dropExamples.length,
      });
      const content: Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      > = [
        {
          type: 'text',
          text: JSON.stringify(pageFilterPromptPayload),
        },
      ];

      params.dropExamples.forEach((example, index) => {
        content.push({
          type: 'text',
          text: `Drop example ${index + 1} (${example.file_name}): pages visually similar to this example should usually be filtered out unless they contain concrete slot-fill values. Do not treat signed/stamped contract acknowledgement or confirmation pages as drop examples.`,
        });
        content.push({
          type: 'image_url',
          image_url: { url: example.image_data_url },
        });
      });

      batch.forEach((page) => {
        content.push({
          type: 'text',
          text: `Uploaded PDF page ${page.page_number}`,
        });
        content.push({
          type: 'image_url',
          image_url: { url: page.image_data_url },
        });
      });

      await params.onTrace?.({
        message: `[PDF Fill][PageFilter] Starting visual page filter batch ${batchIndex + 1}/${batches.length} for ${params.documentName}, pages=${batch.map((page) => page.page_number).join(',')}.`,
      });
      await params.onTrace?.({
        message: `[PDF Fill][PageFilterPrompt][batch ${batchIndex + 1}/${batches.length}] ${JSON.stringify({
          route: '/api/generation-task-items/[taskItemId]/page-preparation',
          config_scope: 'VISION_LLM',
          model: traceConfig.model,
          provider: traceConfig.provider,
          thinking_enabled: traceConfig.thinkingEnabled,
          reasoning_effort: traceConfig.reasoningEffort,
          extra_body: traceConfig.extraBody,
          request_label: `page filter batch ${batchIndex + 1}/${batches.length}`,
          drop_examples: params.dropExamples.map((example, index) => ({
            index: index + 1,
            file_name: example.file_name,
            has_image_data_url: Boolean(example.image_data_url),
          })),
          messages: [
            {
              role: 'system',
              content:
                'You are a visual PDF page filtering assistant. Compare candidate page images with drop examples when provided, then classify pages for a later slot-fill workflow. Return compact JSON only.',
            },
            {
              role: 'user',
              content: pageFilterPromptPayload,
            },
          ],
          image_placeholders: batch.map((page) => ({
            label: `Uploaded PDF page ${page.page_number}`,
            page_number: page.page_number,
            has_image_data_url: Boolean(page.image_data_url),
          })),
        })}`,
      });

      const upstream = await undiciFetch(llmConfig.chatCompletionsUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${llmConfig.apiKey}`,
        },
        dispatcher: llmFetchDispatcher,
        signal: controller.signal,
        body: JSON.stringify(
          buildChatCompletionBody(llmConfig, {
            messages: [
              {
                role: 'system',
                content:
                  'You are a visual PDF page filtering assistant. Compare candidate page images with drop examples when provided, then classify pages for a later slot-fill workflow. Return compact JSON only.',
              },
              {
                role: 'user',
                content,
              },
            ],
          }),
        ),
      });

      if (!upstream.ok) {
        const details = await upstream.text();
        throw new Error(
          `Vision page filter request failed (${upstream.status}): ${details}`,
        );
      }

      const payload = (await upstream.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const rawContent = payload.choices?.[0]?.message?.content ?? '';
      const batchResults = parsePageFilterJson(rawContent);

      results.push(...batchResults);
      await params.onTrace?.({
        message: `[PDF Fill][PageFilterRaw][batch ${batchIndex + 1}/${batches.length}] ${JSON.stringify({
          route: '/api/generation-task-items/[taskItemId]/page-preparation',
          config_scope: 'VISION_LLM',
          model: llmConfig.model,
          provider: traceConfig.provider,
          request_label: `page filter batch ${batchIndex + 1}/${batches.length}`,
          page_numbers: batch.map((page) => page.page_number),
          raw_response: rawContent,
          parsed_results: batchResults,
        })}`,
      });
      await params.onTrace?.({
        message: `[PDF Fill][PageFilter] Completed visual page filter batch ${batchIndex + 1}/${batches.length} for ${params.documentName}; decisions=${JSON.stringify(batchResults)}.`,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  const decisionByPage = new Map(results.map((page) => [page.page_number, page]));

  return params.visionPages.map((page) => {
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
}

async function runGenerationTaskItemPagePreparation(params: {
  item: GenerationTaskItemRecord;
  actorEmail: string | null;
}) {
  const admin = createSupabaseAdminClient();
  const startedAt = new Date();
  const slotSchema = Array.isArray(params.item.llm_input?.slot_schema)
    ? params.item.llm_input.slot_schema
    : [];
  const precomputedVisionPages = normalizeVisionPages(params.item.llm_input?.vision_pages);
  const pageImageAssets = normalizePdfPageImageAssets(
    params.item.llm_input?.ocr_image_assets,
  );
  const pageFilterDropExamples = await loadPageFilterDropExamplesFromFolder();
  const selectedOriginalPageNumbers = normalizeSelectedOriginalPageNumbers(
    params.item.llm_input?.selected_original_page_numbers,
  );

  try {
    if (slotSchema.length === 0) {
      throw new Error('当前模板缺少槽位定义，请重新保存模板后再试。');
    }

    if (
      precomputedVisionPages.length === 0 &&
      pageImageAssets.length === 0 &&
      selectedOriginalPageNumbers.length === 0
    ) {
      throw new Error('当前任务缺少可用于视觉回填的新 PDF 页面图片，请重新创建批量任务。');
    }

    await admin
      .from('generation_task_items')
      .update({
        status: 'page_preparing',
        error_message: null,
        started_at: params.item.started_at ?? startedAt.toISOString(),
        finished_at: null,
        slot_total_count: slotSchema.length,
        slot_completed_count: 0,
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
        pageFilterDropExampleCount: pageFilterDropExamples.length,
        selectedPageCount: selectedOriginalPageNumbers.length,
      },
    });

    let nextPageImageAssets = pageImageAssets;
    let pageFilterErrorMessage: string | null = null;

    if (pageImageAssets.length > 0) {
      try {
        const precomputedVisionPagesForFilter = precomputedVisionPages.map(
          (page) => ({
            page_number: page.page_number,
            image_data_url: page.image_data_url,
            original_page_number: page.original_page_number ?? page.page_number,
          }),
        );
        const visionPagesForFilter =
          precomputedVisionPages.length > 0
            ? precomputedVisionPagesForFilter
            : await loadVisionPagesFromStoredAssets({
                admin,
                pageImageAssets,
              });
        const pageFilterDecisions = await classifyVisionPagesForSlotFill({
          documentName: params.item.source_pdf_name,
          visionPages: visionPagesForFilter,
          dropExamples: pageFilterDropExamples,
          onTrace: async ({ message }) => {
            await appendProcessingTrace(admin, params.item.id, message);
          },
        });
        const decisionByPageNumber = new Map(
          pageFilterDecisions.map((decision) => [
            decision.page_number,
            decision,
          ]),
        );

        nextPageImageAssets = pageImageAssets.map((asset) => {
          const decision = decisionByPageNumber.get(
            asset.uploaded_page_number,
          );
          const normalizedDecision = decision?.decision ?? 'review';

          return {
            ...asset,
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
          new Date(params.item.started_at ?? startedAt.toISOString()).getTime()) /
          1000,
      ),
    );

    const { data: updatedItem, error: updatedItemError } = await admin
      .from('generation_task_items')
      .update({
        status: 'pdf_pages_ready',
        elapsed_seconds: elapsedSeconds,
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
            drop_example_count: pageFilterDropExamples.length,
            model: getLlmRuntimeTraceConfig('vision').model,
            provider: getLlmRuntimeTraceConfig('vision').provider,
            ...(pageFilterErrorMessage
              ? { error_message: pageFilterErrorMessage }
              : {}),
          },
        },
        slot_total_count: slotSchema.length,
        slot_completed_count: 0,
      })
      .eq('id', params.item.id)
      .select('id, status')
      .single();

    if (updatedItemError) {
      throw updatedItemError;
    }

    if (!updatedItem || updatedItem.status !== 'pdf_pages_ready') {
      throw new Error('PDF page ready status was not persisted correctly before slot-fill handoff.');
    }

    await recalculateTaskSummary(admin, params.item.task_id);
    await appendProcessingTrace(
      admin,
      params.item.id,
      `[PDF Fill][PageFilter] PDF page images prepared and visually filtered: total=${nextPageImageAssets.length}, kept=${keptPageCount}, dropped=${droppedPageCount}, review=${reviewPageCount}. Waiting for user confirmation before slot fill.`,
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
      },
    });
  } catch (error) {
    const fallbackReviewPayload = buildFallbackReviewPayload(slotSchema);

    await admin
      .from('generation_task_items')
      .update({
        status: 'review_pending',
        error_message: null,
        llm_output: fallbackReviewPayload,
        slot_total_count: slotSchema.length,
        slot_completed_count: 0,
        finished_at: new Date().toISOString(),
      })
      .eq('id', params.item.id);

    await appendProcessingTrace(
      admin,
      params.item.id,
      `新 PDF 页面图片准备失败，已转为人工核查：${getErrorMessage(error)}`,
    );
    await appendProcessingTrace(
      admin,
      params.item.id,
      `[PDF Fill][RawError][PagePreparation] ${getErrorMessage(error)}`,
    );
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
      message: getErrorMessage(error),
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
          item,
        },
      });
    }

    if (['running', 'page_preparing', 'ocr_running'].includes(item.status)) {
      return NextResponse.json({
        data: {
          item,
        },
      });
    }

    after(async () => {
      await runGenerationTaskItemPagePreparation({
        item,
        actorEmail: user.email ?? null,
      });
    });

    return NextResponse.json(
      {
        data: {
          item: {
            ...item,
            status: 'page_preparing',
            slot_total_count:
              Array.isArray(item.llm_input?.slot_schema) ? item.llm_input.slot_schema.length : 0,
            slot_completed_count: 0,
            processing_trace: '',
            error_message: null,
          },
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
