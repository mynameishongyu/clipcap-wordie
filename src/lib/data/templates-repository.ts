import 'server-only';

import type { SupabaseClient, User } from '@supabase/supabase-js';
import type {
  SavedTemplateDetail,
  SavedTemplateSummary,
} from '@/src/app/api/types/template-library';
import type { SlotReviewSessionPayload } from '@/src/lib/templates/slot-review-session';

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

function sanitizeStorageFileName(fileName: string) {
  return fileName
    .trim()
    .replace(/[\\/:*?"<>|#%{}[\]^~`]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function getReferencePageImageExtension(page: SlotReviewPdfEvidencePage) {
  const storagePath = page.storagePath?.toLowerCase() ?? '';

  if (storagePath.endsWith('.jpg') || storagePath.endsWith('.jpeg')) {
    return 'jpg';
  }

  if (storagePath.endsWith('.webp')) {
    return 'webp';
  }

  const dataUrlMatch = page.imageDataUrl?.match(
    /^data:image\/([^;]+);base64,/i,
  );

  if (dataUrlMatch?.[1]) {
    return dataUrlMatch[1].replace('jpeg', 'jpg');
  }

  return 'png';
}

function getContentTypeForReferencePageExtension(extension: string) {
  if (extension === 'jpg' || extension === 'jpeg') {
    return 'image/jpeg';
  }

  if (extension === 'webp') {
    return 'image/webp';
  }

  return 'image/png';
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

async function persistReferencePdfPageForTemplate(input: {
  supabase: SupabaseClient;
  user: User;
  templateId: string;
  templateName: string;
  page: SlotReviewPdfEvidencePage;
}) {
  const currentPath = input.page.storagePath?.trim() ?? '';
  const stablePrefix = `${input.user.id}/template-reference-pages/${input.templateId}/`;

  if (currentPath.startsWith(stablePrefix)) {
    return input.page;
  }

  if (!currentPath && !input.page.imageDataUrl?.startsWith('data:image/')) {
    return input.page;
  }

  const extension = getReferencePageImageExtension(input.page);
  const safeTemplateName =
    sanitizeStorageFileName(input.templateName) || 'template';
  const targetPath =
    `${stablePrefix}${String(input.page.pageNumber).padStart(4, '0')}-` +
    `${crypto.randomUUID()}-${safeTemplateName}.${extension}`;
  const storage = input.supabase.storage.from('generation-pdfs');

  try {
    if (currentPath) {
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

    const { data: signedUrlData, error: signedUrlError } =
      await storage.createSignedUrl(targetPath, 60 * 60 * 24);

    if (signedUrlError || !signedUrlData?.signedUrl) {
      throw signedUrlError ?? new Error(`Missing signed URL for ${targetPath}`);
    }

    return {
      ...input.page,
      storagePath: targetPath,
      imageUrl: signedUrlData.signedUrl,
      fallbackImageUrl: signedUrlData.signedUrl,
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

async function persistTemplateReferencePdfPages(input: {
  supabase: SupabaseClient;
  user: User;
  templateId: string;
  templateName: string;
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
        templateName: input.templateName,
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

  const temporaryPrefix = `${input.user.id}/template-extraction-pages/${extractionTaskId}/`;
  const storagePathsToRemove = input.originalPages
    .map((page, index) => ({
      originalPath: page.storagePath?.trim() ?? '',
      persistedPath: input.persistedPages[index]?.storagePath?.trim() ?? '',
    }))
    .filter(
      (entry) =>
        entry.originalPath.startsWith(temporaryPrefix) &&
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
    return data;
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

  if (input.templateId) {
    const existingTemplate = await getUserTemplateById(
      supabase,
      user,
      input.templateId,
    );

    if (!existingTemplate) {
      templateId = crypto.randomUUID();
    }
  }

  const nextPayload = await persistTemplateReferencePdfPages({
    supabase,
    user,
    templateId,
    templateName: normalizedTemplateName,
    slotReviewPayload: {
      ...input.slotReviewPayload,
      templateId,
      templateName: normalizedTemplateName,
    },
  });

  const payloadToSave: SlotReviewSessionPayload = {
    ...nextPayload,
    templateId,
    templateName: normalizedTemplateName,
  };

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

  return data;
}
