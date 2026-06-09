const DEFAULT_SUPABASE_SIGNED_URL_EXPIRES_IN_SECONDS = 60 * 60;
const SUPABASE_IMAGE_SIGNED_URL_EXPIRES_IN_SECONDS_ENV =
  'SUPABASE_IMAGE_SIGNED_URL_EXPIRES_IN_SECONDS';

export function getSupabaseSignedUrlExpiresInSeconds() {
  const rawValue =
    process.env[SUPABASE_IMAGE_SIGNED_URL_EXPIRES_IN_SECONDS_ENV]?.trim();

  if (rawValue) {
    const parsedValue = Number.parseInt(rawValue, 10);

    if (Number.isInteger(parsedValue) && parsedValue > 0) {
      return parsedValue;
    }

    throw new Error(
      `${SUPABASE_IMAGE_SIGNED_URL_EXPIRES_IN_SECONDS_ENV} must be a positive integer when configured.`,
    );
  }

  return DEFAULT_SUPABASE_SIGNED_URL_EXPIRES_IN_SECONDS;
}
