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

/**
 * Lists saved templates for the current authenticated user.
 *
 * @returns User-owned template summaries sorted by last update time descending.
 */
export async function listUserTemplates(
  supabase: SupabaseClient,
  user: User,
) {
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
    throw new Error('数据库缺少模板库字段，请先执行 0004_saved_templates_library.sql 迁移。');
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
    throw new Error('当前会话缺少原始 DOCX 文件，请返回首页重新上传并识别后再保存模板。');
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

  const nextPayload: SlotReviewSessionPayload = {
    ...input.slotReviewPayload,
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
          nextPayload.uploadDocxName?.trim() || nextPayload.fileName.trim(),
        upload_docx_base64: nextPayload.uploadDocxBase64!.trim(),
        upload_text: nextPayload.uploadText,
        upload_html: nextPayload.uploadHtml,
        prompt: nextPayload.prompt,
        result: input.slotPreview,
        slot_preview: input.slotPreview,
        slot_review_payload: nextPayload,
        updated_at: nextTimestamp,
      },
      { onConflict: 'id' },
    )
    .select(TEMPLATE_SUMMARY_COLUMNS)
    .single<SavedTemplateSummary>();

  if (error) {
    if (isMissingTemplateLibraryColumnError(error)) {
      throw new Error('数据库缺少模板库字段，请先执行 0004_saved_templates_library.sql 迁移。');
    }

    throw error;
  }

  return data;
}
