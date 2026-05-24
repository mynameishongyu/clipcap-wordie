'use client';

const DEFAULT_PDF_STORAGE_UPLOAD_CONCURRENCY = 3;
const MAX_PDF_STORAGE_UPLOAD_CONCURRENCY = 10;

export function getPdfStorageUploadConcurrency() {
  const parsedValue = Number(
    process.env.NEXT_PUBLIC_PDF_STORAGE_UPLOAD_CONCURRENCY,
  );

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return DEFAULT_PDF_STORAGE_UPLOAD_CONCURRENCY;
  }

  return Math.min(
    MAX_PDF_STORAGE_UPLOAD_CONCURRENCY,
    Math.max(1, Math.floor(parsedValue)),
  );
}
