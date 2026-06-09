import { getSupabaseSignedUrlExpiresInSeconds } from '@/src/lib/supabase/signed-url';

type SupabaseStorageClient = {
  storage: {
    from: (bucket: string) => {
      createSignedUrl: (
        path: string,
        expiresIn: number,
      ) => Promise<{
        data: { signedUrl?: string | null } | null;
        error: { message?: string | null } | null;
      }>;
    };
  };
};

export type SupabaseSignedImageSource = {
  bucket?: string;
  storagePath: string;
  mimeType?: string | null;
  pageNumber?: number | null;
  originalPageNumber?: number | null;
};

export type SupabaseSignedImageUrl = SupabaseSignedImageSource & {
  bucket: string;
  signedUrl: string;
  expiresInSeconds: number;
};

const DEFAULT_STORAGE_BUCKET = 'generation-pdfs';
const DEFAULT_IMAGE_MIME_TYPE = 'image/jpeg';

export function getImageMimeType(mimeType?: string | null) {
  const normalized = mimeType?.trim();

  return normalized || DEFAULT_IMAGE_MIME_TYPE;
}

export async function createSupabaseSignedImageUrl(params: {
  admin: SupabaseStorageClient;
  source: SupabaseSignedImageSource;
}) {
  const bucket = params.source.bucket ?? DEFAULT_STORAGE_BUCKET;
  const expiresInSeconds = getSupabaseSignedUrlExpiresInSeconds();
  const { data, error } = await params.admin.storage
    .from(bucket)
    .createSignedUrl(params.source.storagePath, expiresInSeconds);

  if (error || !data?.signedUrl) {
    throw new Error(
      `[SupabaseSignedImageUrlFailed] bucket=${bucket}, storage_path=${
        params.source.storagePath
      }, error=${error?.message ?? 'missing signed URL'}`,
    );
  }

  return {
    ...params.source,
    bucket,
    signedUrl: data.signedUrl,
    expiresInSeconds,
  } satisfies SupabaseSignedImageUrl;
}

export function buildSupabaseSignedImageTraceSource(
  source: SupabaseSignedImageSource,
) {
  return {
    bucket: source.bucket ?? DEFAULT_STORAGE_BUCKET,
    storage_path: source.storagePath,
    page_number: source.pageNumber ?? null,
    original_page_number: source.originalPageNumber ?? null,
    mime_type: getImageMimeType(source.mimeType),
  };
}

