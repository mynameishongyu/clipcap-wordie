const DEFAULT_SUPABASE_SIGNED_URL_EXPIRES_IN_SECONDS = 60 * 60;

export function getSupabaseSignedUrlExpiresInSeconds() {
  const parsedValue = Number(
    process.env.NEXT_PUBLIC_SUPABASE_SIGNED_URL_EXPIRES_IN_SECONDS,
  );

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return DEFAULT_SUPABASE_SIGNED_URL_EXPIRES_IN_SECONDS;
  }

  return Math.max(1, Math.floor(parsedValue));
}
