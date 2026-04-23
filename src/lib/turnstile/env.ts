export function getTurnstileSiteKey() {
  return process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? '';
}

export function isTurnstileEnabled() {
  return Boolean(
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY,
  );
}

export function getTurnstileSecretKey() {
  const value = process.env.TURNSTILE_SECRET_KEY;

  if (!value) {
    throw new Error('Turnstile secret key is not configured');
  }

  return value;
}
