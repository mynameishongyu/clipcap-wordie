import 'server-only';

import { createHash } from 'crypto';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import type {
  SavedTemplateDetail,
  SavedTemplateSummary,
} from '@/src/app/api/types/template-library';
import { getSupabaseSignedUrlExpiresInSeconds } from '@/src/lib/supabase/signed-url';
import type { SlotReviewSessionPayload } from '@/src/lib/templates/slot-review-session';
import {
  ensureExtractionResultSlotKeys,
  filterPdfEvidenceMatchesBySlotKeys,
  getExtractionResultSlotKeySet,
  getPdfEvidenceMatchSlotKey,
} from '@/src/lib/templates/slot-key';

export interface SaveTemplateInput {
  templateId?: string;
  templateName: string;
  slotReviewPayload: SlotReviewSessionPayload;
  slotPreview: unknown;
}

interface LegacyTemplateSummaryRecord {
  id: string;
  created_at: string;
}

type SlotReviewPdfEvidencePage = NonNullable<
  SlotReviewSessionPayload['pdfEvidence']
>['pages'][number];

const TEMPLATE_SUMMARY_COLUMNS =
  'id, template_name, upload_docx_name, created_at, updated_at';
const TEMPLATE_DETAIL_COLUMNS =
  'id, template_name, upload_docx_name, created_at, updated_at, prompt, slot_review_payload, slot_preview';
const TEMPLATE_LEGACY_SUMMARY_COLUMNS = 'id, created_at';

function isMissingTemplateLibraryColumnError(error: unknown) {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as { code?: string; message?: string };

  if (candidate.code === '42703') {
    return true;
  }

  return (
    typeof candidate.message === 'string' &&
    (candidate.message.includes('template_name') ||
      candidate.message.includes('upload_docx_name') ||
      candidate.message.includes('updated_at') ||
      candidate.message.includes('slot_review_payload') ||
      candidate.message.includes('slot_preview') ||
      candidate.message.includes('upload_docx_base64') ||
      candidate.message.includes('upload_html'))
  );
}

function normalizeLegacyTemplateSummary(
  record: LegacyTemplateSummaryRecord,
): SavedTemplateSummary {
  return {
    id: record.id,
    template_name: record.id,
    upload_docx_name: null,
    created_at: record.created_at,
    updated_at: record.created_at,
  };
}

function decodeDataUrlImage(dataUrl: string) {
  const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/i);

  if (!match?.[1] || !match?.[2]) {
    return null;
  }

  return {
    contentType: match[1],
    buffer: Buffer.from(match[2], 'base64'),
  };
}

async function createReferencePdfPageSignedUrl(input: {
  supabase: SupabaseClient;
  storagePath: string;
}) {
  const storagePath = input.storagePath.trim();

  if (!storagePath) {
    return null;
  }

  const { data, error } = await input.supabase.storage
    .from('generation-pdfs')
    .createSignedUrl(storagePath, getSupabaseSignedUrlExpiresInSeconds());

  if (error || !data?.signedUrl) {
    throw error ?? new Error(`Missing signed URL for ${storagePath}`);
  }

  return data.signedUrl;
}

async function refreshReferencePdfPageSignedUrl(input: {
  supabase: SupabaseClient;
  page: SlotReviewPdfEvidencePage;
}) {
  const storagePath = input.page.storagePath?.trim();

  if (!storagePath) {
    return input.page;
  }

  try {
    const signedUrl = await createReferencePdfPageSignedUrl({
      supabase: input.supabase,
      storagePath,
    });

    if (!signedUrl) {
      return input.page;
    }

    return {
      ...input.page,
      imageUrl: signedUrl,
      fallbackImageUrl: signedUrl,
    };
  } catch (error) {
    console.warn('[Templates] Failed to refresh reference PDF page signed URL.', {
      pageNumber: input.page.pageNumber,
      storagePath,
      error,
    });

    return input.page;
  }
}

async function refreshTemplateReferencePdfPageSignedUrls(input: {
  supabase: SupabaseClient;
  payload: unknown;
}) {
  const payload = input.payload as SlotReviewSessionPayload | null | undefined;

  if (!payload?.pdfEvidence?.pages?.length) {
    return input.payload;
  }

  const pages = await Promise.all(
    payload.pdfEvidence.pages.map((page) =>
      refreshReferencePdfPageSignedUrl({
        supabase: input.supabase,
        page,
      }),
    ),
  );

  return {
    ...payload,
    pdfEvidence: {
      ...payload.pdfEvidence,
      pages,
    },
  };
}

async function persistReferencePdfPageForTemplate(input: {
  supabase: SupabaseClient;
  user: User;
  templateId: string;
  page: SlotReviewPdfEvidencePage;
}) {
  const currentPath = input.page.storagePath?.trim() ?? '';
  const stablePrefix = `${input.user.id}/template-reference-pages/original/${input.templateId}/`;

  if (currentPath.startsWith(stablePrefix)) {
    return refreshReferencePdfPageSignedUrl({
      supabase: input.supabase,
      page: input.page,
    });
  }

  if (!currentPath && !input.page.imageDataUrl?.startsWith('data:image/')) {
    return input.page;
  }

  const targetPath = `${stablePrefix}page-${input.page.pageNumber}.png`;
  const storage = input.supabase.storage.from('generation-pdfs');

  try {
    if (currentPath) {
      await storage.remove([targetPath]);

      const { error: copyError } = await storage.copy(currentPath, targetPath);

      if (copyError) {
        throw copyError;
      }
    } else if (input.page.imageDataUrl) {
      const decodedImage = decodeDataUrlImage(input.page.imageDataUrl);

      if (!decodedImage) {
        return input.page;
      }

      const { error: uploadError } = await storage.upload(
        targetPath,
        decodedImage.buffer,
        {
          contentType: decodedImage.contentType,
          upsert: true,
        },
      );

      if (uploadError) {
        throw uploadError;
      }
    }

    const signedUrl = await createReferencePdfPageSignedUrl({
      supabase: input.supabase,
      storagePath: targetPath,
    });

    return {
      ...input.page,
      storagePath: targetPath,
      imageUrl: signedUrl ?? input.page.imageUrl,
      fallbackImageUrl: signedUrl ?? input.page.fallbackImageUrl,
    };
  } catch (error) {
    console.warn('[Templates] Failed to persist reference PDF page image.', {
      templateId: input.templateId,
      pageNumber: input.page.pageNumber,
      sourcePath: currentPath || null,
      targetPath,
      error,
    });

    return input.page;
  }
}

function buildTemplateAnnotationSignatureByPage(
  payload: SlotReviewSessionPayload | null | undefined,
) {
  const matchesByPage = new Map<
    number,
    Array<{
      slotKey: string;
      bbox: {
        x: number;
        y: number;
        width: number;
        height: number;
      };
    }>
  >();

  for (const match of payload?.pdfEvidence?.matches ?? []) {
    const slotKey = getPdfEvidenceMatchSlotKey(match);

    if (!slotKey || !match.bbox || !Number.isInteger(match.page_number)) {
      continue;
    }

    const pageMatches = matchesByPage.get(match.page_number) ?? [];

    pageMatches.push({
      slotKey,
      bbox: {
        x: Number(match.bbox.x.toFixed(6)),
        y: Number(match.bbox.y.toFixed(6)),
        width: Number(match.bbox.width.toFixed(6)),
        height: Number(match.bbox.height.toFixed(6)),
      },
    });
    matchesByPage.set(match.page_number, pageMatches);
  }

  return new Map(
    [...matchesByPage.entries()].map(([pageNumber, pageMatches]) => [
      pageNumber,
      createHash('sha256')
        .update(
          JSON.stringify(
            pageMatches.sort((left, right) =>
              left.slotKey.localeCompare(right.slotKey),
            ),
          ),
        )
        .digest('hex'),
    ]),
  );
}

function getChangedAnnotatedReferencePageNumbers(params: {
  previousPayload: SlotReviewSessionPayload | null | undefined;
  nextPayload: SlotReviewSessionPayload;
}) {
  const previousSignatures = buildTemplateAnnotationSignatureByPage(
    params.previousPayload,
  );
  const nextSignatures = buildTemplateAnnotationSignatureByPage(
    params.nextPayload,
  );
  const pageNumbers = new Set([
    ...previousSignatures.keys(),
    ...nextSignatures.keys(),
  ]);

  return [...pageNumbers].filter(
    (pageNumber) =>
      previousSignatures.get(pageNumber) !== nextSignatures.get(pageNumber),
  );
}

function removeOrphanPdfEvidenceMatches(
  payload: SlotReviewSessionPayload,
): SlotReviewSessionPayload {
  if (!payload.pdfEvidence) {
    return payload;
  }

  const payloadSlotKeys = getExtractionResultSlotKeySet(
    payload.extractionResult,
  );
  const filteredMatches = filterPdfEvidenceMatchesBySlotKeys(
    payload.pdfEvidence.matches,
    payloadSlotKeys,
  );
  const pagesWithMatches = new Set(
    filteredMatches.map((match) => match.page_number),
  );

  return {
    ...payload,
    pdfEvidence: {
      ...payload.pdfEvidence,
      matches: filteredMatches,
      pages: payload.pdfEvidence.pages.map((page) =>
        pagesWithMatches.has(page.pageNumber)
          ? page
          : { ...page, annotatedStoragePath: undefined },
      ),
    },
  };
}

async function cleanupChangedTemplateAnnotatedReferencePages(input: {
  supabase: SupabaseClient;
  user: User;
  templateId: string;
  pageNumbers: number[];
}) {
  if (input.pageNumbers.length === 0) {
    return;
  }

  const pathsToRemove = input.pageNumbers.flatMap((pageNumber) =>
    ['jpg', 'png'].map(
      (extension) =>
        `${input.user.id}/template-reference-pages/annotated/${input.templateId}/page-${pageNumber}.${extension}`,
    ),
  );

  const { error } = await input.supabase.storage
    .from('generation-pdfs')
    .remove(Array.from(new Set(pathsToRemove)));

  if (error) {
    console.warn(
      '[Templates] Failed to clean up changed annotated reference pages.',
      {
        templateId: input.templateId,
        pageNumbers: input.pageNumbers,
        error,
      },
    );
  }
}

async function persistTemplateReferencePdfPages(input: {
  supabase: SupabaseClient;
  user: User;
  templateId: string;
  slotReviewPayload: SlotReviewSessionPayload;
}) {
  const pdfEvidence = input.slotReviewPayload.pdfEvidence;

  if (!pdfEvidence?.pages?.length) {
    return input.slotReviewPayload;
  }

  const pages = await Promise.all(
    pdfEvidence.pages.map((page) =>
      persistReferencePdfPageForTemplate({
        supabase: input.supabase,
        user: input.user,
        templateId: input.templateId,
        page,
      }),
    ),
  );

  await cleanupTemplateExtractionPages({
    supabase: input.supabase,
    user: input.user,
    extractionTaskId: pdfEvidence.extractionTaskId,
    originalPages: pdfEvidence.pages,
    persistedPages: pages,
  });

  return {
    ...input.slotReviewPayload,
    pdfEvidence: {
      ...pdfEvidence,
      pages,
    },
  };
}

async function cleanupTemplateExtractionPages(input: {
  supabase: SupabaseClient;
  user: User;
  extractionTaskId?: string;
  originalPages: SlotReviewPdfEvidencePage[];
  persistedPages: SlotReviewPdfEvidencePage[];
}) {
  const extractionTaskId = input.extractionTaskId?.trim();

  if (!extractionTaskId) {
    return;
  }

  const temporaryPrefixes = [
    `${input.user.id}/template-extraction-pages-temp/task/${extractionTaskId}/`,
    `${input.user.id}/template-extraction-pages-temp/${extractionTaskId}/`,
    `${input.user.id}/template-extraction-pages/task/${extractionTaskId}/`,
    `${input.user.id}/template-extraction-pages/${extractionTaskId}/`,
  ];
  const storagePathsToRemove = input.originalPages
    .map((page, index) => ({
      originalPath: page.storagePath?.trim() ?? '',
      persistedPath: input.persistedPages[index]?.storagePath?.trim() ?? '',
    }))
    .filter(
      (entry) =>
        temporaryPrefixes.some((temporaryPrefix) =>
          entry.originalPath.startsWith(temporaryPrefix),
        ) &&
        entry.persistedPath &&
        entry.persistedPath !== entry.originalPath,
    )
    .map((entry) => entry.originalPath);

  if (storagePathsToRemove.length === 0) {
    return;
  }

  const { error } = await input.supabase.storage
    .from('generation-pdfs')
    .remove(Array.from(new Set(storagePathsToRemove)));

  if (error) {
    console.warn('[Templates] Failed to clean up temporary extraction pages.', {
      extractionTaskId,
      storagePathCount: storagePathsToRemove.length,
      error,
    });
  }
}

/**
 * Lists saved templates for the current authenticated user.
 *
 * @returns User-owned template summaries sorted by last update time descending.
 */
export async function listUserTemplates(supabase: SupabaseClient, user: User) {
  const { data, error } = await supabase
    .from('templates')
    .select(TEMPLATE_SUMMARY_COLUMNS)
    .eq('owner_id', user.id)
    .order('updated_at', { ascending: false })
    .returns<SavedTemplateSummary[]>();

  if (!error) {
    return data ?? [];
  }

  if (!isMissingTemplateLibraryColumnError(error)) {
    throw error;
  }

  const { data: legacyData, error: legacyError } = await supabase
    .from('templates')
    .select(TEMPLATE_LEGACY_SUMMARY_COLUMNS)
    .eq('owner_id', user.id)
    .order('created_at', { ascending: false })
    .returns<LegacyTemplateSummaryRecord[]>();

  if (legacyError) {
    throw legacyError;
  }

  return (legacyData ?? []).map(normalizeLegacyTemplateSummary);
}

/**
 * Loads one saved template owned by the current authenticated user.
 *
 * @param templateId Template id selected on the home page.
 * @returns Full saved template record including slot review payload and preview JSON.
 */
export async function getUserTemplateById(
  supabase: SupabaseClient,
  user: User,
  templateId: string,
) {
  const { data, error } = await supabase
    .from('templates')
    .select(TEMPLATE_DETAIL_COLUMNS)
    .eq('id', templateId)
    .eq('owner_id', user.id)
    .maybeSingle<SavedTemplateDetail>();

  if (!error) {
    if (!data) {
      return data;
    }

    return {
      ...data,
      slot_review_payload: await refreshTemplateReferencePdfPageSignedUrls({
        supabase,
        payload: data.slot_review_payload,
      }),
    };
  }

  if (isMissingTemplateLibraryColumnError(error)) {
    throw new Error(
      '数据库缺少模板库字段，请先执行 0004_saved_templates_library.sql 迁移。',
    );
  }

  throw error;
}

/**
 * Persists the current slot-review editing result as a reusable template for the current user.
 *
 * @param input Includes template naming plus the exact slot-review payload needed for later editing.
 * @returns The saved template summary record after insert/update.
 */
export async function saveUserTemplate(
  supabase: SupabaseClient,
  user: User,
  input: SaveTemplateInput,
) {
  const normalizedTemplateName = input.templateName.trim();

  if (!normalizedTemplateName) {
    throw new Error('请输入模板名称后再保存。');
  }

  if (!input.slotReviewPayload.uploadDocxBase64?.trim()) {
    throw new Error(
      '当前会话缺少原始 DOCX 文件，请返回首页重新上传并识别后再保存模板。',
    );
  }

  let templateId = input.templateId?.trim() || crypto.randomUUID();
  const nextTimestamp = new Date().toISOString();
  let existingTemplate: SavedTemplateDetail | null = null;

  if (input.templateId) {
    existingTemplate = await getUserTemplateById(
      supabase,
      user,
      input.templateId,
    );

    if (!existingTemplate) {
      templateId = crypto.randomUUID();
    }
  }

  const slotReviewPayloadWithKeys: SlotReviewSessionPayload = {
    ...input.slotReviewPayload,
    extractionResult: ensureExtractionResultSlotKeys(
      input.slotReviewPayload.extractionResult,
    ),
  };
  const slotReviewPayloadForSave = removeOrphanPdfEvidenceMatches(
    slotReviewPayloadWithKeys,
  );

  const nextPayload = await persistTemplateReferencePdfPages({
    supabase,
    user,
    templateId,
    slotReviewPayload: {
      ...slotReviewPayloadForSave,
      templateId,
      templateName: normalizedTemplateName,
    },
  });

  const payloadToSave: SlotReviewSessionPayload = {
    ...nextPayload,
    templateId,
    templateName: normalizedTemplateName,
  };
  const changedAnnotatedReferencePageNumbers =
    getChangedAnnotatedReferencePageNumbers({
      previousPayload:
        (existingTemplate?.slot_review_payload as
          | SlotReviewSessionPayload
          | null
          | undefined) ?? null,
      nextPayload: payloadToSave,
    });

  const { data, error } = await supabase
    .from('templates')
    .upsert(
      {
        id: templateId,
        owner_id: user.id,
        template_name: normalizedTemplateName,
        upload_docx_name:
          payloadToSave.uploadDocxName?.trim() || payloadToSave.fileName.trim(),
        upload_docx_base64: payloadToSave.uploadDocxBase64!.trim(),
        upload_text: payloadToSave.uploadText,
        upload_html: payloadToSave.uploadHtml,
        prompt: payloadToSave.prompt,
        result: input.slotPreview,
        slot_preview: input.slotPreview,
        slot_review_payload: payloadToSave,
        updated_at: nextTimestamp,
      },
      { onConflict: 'id' },
    )
    .select(TEMPLATE_SUMMARY_COLUMNS)
    .single<SavedTemplateSummary>();

  if (error) {
    if (isMissingTemplateLibraryColumnError(error)) {
      throw new Error(
        '数据库缺少模板库字段，请先执行 0004_saved_templates_library.sql 迁移。',
      );
    }

    throw error;
  }

  await cleanupChangedTemplateAnnotatedReferencePages({
    supabase,
    user,
    templateId,
    pageNumbers: changedAnnotatedReferencePageNumbers,
  });

  return {
    ...data,
    annotated_reference_page_numbers_to_refresh:
      changedAnnotatedReferencePageNumbers,
  };
}
