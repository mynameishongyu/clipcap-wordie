import 'server-only';

import type { SupabaseClient, User } from '@supabase/supabase-js';

export interface ProfileRecord {
  id: string;
  email: string | null;
  display_name: string | null;
  organization_name: string | null;
  use_case: string | null;
  registration_status: 'pending' | 'completed';
  onboarded_at: string | null;
}

export interface UpdateProfileRegistrationInput {
  email: string;
  displayName: string;
  organizationName: string;
  useCase: string;
}

type PartialProfileRecord = Pick<ProfileRecord, 'id' | 'email' | 'display_name'> &
  Partial<
    Pick<
      ProfileRecord,
      'organization_name' | 'use_case' | 'registration_status' | 'onboarded_at'
    >
  >;

const PROFILE_BASE_SELECT_COLUMNS = 'id, email, display_name';
const PROFILE_REGISTRATION_SELECT_COLUMNS =
  'organization_name, use_case, registration_status, onboarded_at';
const PROFILE_SELECT_COLUMNS =
  'id, email, display_name, organization_name, use_case, registration_status, onboarded_at';

function isMissingProfileRegistrationColumnError(error: unknown) {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as { code?: string; message?: string };

  if (candidate.code === '42703') {
    return true;
  }

  return (
    typeof candidate.message === 'string' &&
    (candidate.message.includes('organization_name') ||
      candidate.message.includes('use_case') ||
      candidate.message.includes('registration_status') ||
      candidate.message.includes('onboarded_at'))
  );
}

function normalizeProfileRecord(record: PartialProfileRecord): ProfileRecord {
  return {
    id: record.id,
    email: record.email ?? null,
    display_name: record.display_name ?? null,
    organization_name: record.organization_name ?? null,
    use_case: record.use_case ?? null,
    registration_status: record.registration_status ?? 'pending',
    onboarded_at: record.onboarded_at ?? null,
  };
}

async function fetchProfileById(
  supabase: SupabaseClient,
  userId: string,
) {
  const { data, error } = await supabase
    .from('profiles')
    .select(PROFILE_SELECT_COLUMNS)
    .eq('id', userId)
    .maybeSingle<ProfileRecord>();

  if (!error) {
    return data;
  }

  if (!isMissingProfileRegistrationColumnError(error)) {
    throw error;
  }

  const { data: fallbackData, error: fallbackError } = await supabase
    .from('profiles')
    .select(PROFILE_BASE_SELECT_COLUMNS)
    .eq('id', userId)
    .maybeSingle<Pick<ProfileRecord, 'id' | 'email' | 'display_name'>>();

  if (fallbackError) {
    throw fallbackError;
  }

  return fallbackData ? normalizeProfileRecord(fallbackData) : null;
}

async function ensureProfileRecord(
  supabase: SupabaseClient,
  user: User,
) {
  const existingProfile = await fetchProfileById(supabase, user.id);

  if (existingProfile) {
    return existingProfile;
  }

  const fallbackDisplayName =
    user.user_metadata?.full_name ||
    user.user_metadata?.name ||
    user.email?.split('@')[0] ||
    null;

  const { error: createProfileError } = await supabase
    .from('profiles')
    .upsert(
      {
        id: user.id,
        email: user.email ?? null,
        display_name: fallbackDisplayName,
      },
      { onConflict: 'id' },
    );

  if (createProfileError) {
    throw createProfileError;
  }

  const createdProfile = await fetchProfileById(supabase, user.id);

  if (!createdProfile) {
    throw new Error('未能创建用户资料，请稍后重试。');
  }

  return createdProfile;
}

/**
 * Reads the current user's profile record from Supabase so the UI can decide whether auth or onboarding is still required.
 */
export async function getCurrentProfile(
  supabase: SupabaseClient,
  user: User,
) {
  return ensureProfileRecord(supabase, user);
}

/**
 * Marks the current user as fully registered and persists their onboarding fields on the profile row.
 */
export async function updateProfileRegistration(
  supabase: SupabaseClient,
  user: User,
  input: UpdateProfileRegistrationInput,
) {
  await ensureProfileRecord(supabase, user);

  const normalizedEmail = input.email.trim().toLowerCase();

  const { data: existingProfile, error: existingProfileError } = await supabase
    .from('profiles')
    .select('id')
    .eq('email', normalizedEmail)
    .neq('id', user.id)
    .maybeSingle<{ id: string }>();

  if (existingProfileError) {
    throw existingProfileError;
  }

  if (existingProfile) {
    throw new Error('该邮箱已经注册过了，请直接使用原来的账号继续。');
  }

  const { data, error } = await supabase
    .from('profiles')
    .update({
      email: normalizedEmail,
      display_name: input.displayName,
      organization_name: input.organizationName,
      use_case: input.useCase,
      registration_status: 'completed',
      onboarded_at: new Date().toISOString(),
    })
    .eq('id', user.id)
    .select(PROFILE_SELECT_COLUMNS)
    .single<ProfileRecord>();

  if (error) {
    if (isMissingProfileRegistrationColumnError(error)) {
      throw new Error(
        '数据库缺少资料登记字段，请先执行 0003_profile_registration.sql 迁移后再保存资料。',
      );
    }

    throw error;
  }

  return normalizeProfileRecord(data as PartialProfileRecord);
}
