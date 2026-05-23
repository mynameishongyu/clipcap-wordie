import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const DEFAULT_BUCKET = 'generation-pdfs';
const DEFAULT_SIGNED_URL_EXPIRES_IN_SECONDS = 60 * 60;

function loadEnvFile(filePath, options = {}) {
  const { override = false } = options;

  if (!existsSync(filePath)) {
    return;
  }

  const content = readFileSync(filePath, 'utf8');

  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const equalsIndex = trimmed.indexOf('=');

    if (equalsIndex < 0) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && (override || process.env[key] === undefined)) {
      process.env[key] = value;
    }
  }
}

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg?.startsWith('--')) {
      continue;
    }

    const key = arg.slice(2);
    const nextValue = argv[index + 1];

    if (!nextValue || nextValue.startsWith('--')) {
      args[key] = 'true';
      continue;
    }

    args[key] = nextValue;
    index += 1;
  }

  return args;
}

function hasHelpFlag(args) {
  return args.help === 'true' || args.h === 'true';
}

function normalizeGeminiModelForPath(model) {
  return model.trim().replace(/^models\//u, '');
}

function resolveGeminiGenerateBaseUrl(baseUrl) {
  const url = new URL(baseUrl || 'https://generativelanguage.googleapis.com');

  return `${url.origin}/v1beta`;
}

function getSignedUrlExpiresInSeconds() {
  return DEFAULT_SIGNED_URL_EXPIRES_IN_SECONDS;
}

function getRequiredEnv(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function inferMimeTypeFromUrl(url) {
  const pathname = new URL(url).pathname.toLowerCase();

  if (pathname.endsWith('.png')) {
    return 'image/png';
  }

  if (pathname.endsWith('.webp')) {
    return 'image/webp';
  }

  return 'image/jpeg';
}

async function createSupabaseSignedUrl({ storagePath, bucket }) {
  const supabaseUrl = getRequiredEnv('SUPABASE_URL');
  const serviceRoleKey = getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY');
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(storagePath, getSignedUrlExpiresInSeconds());

  if (error || !data?.signedUrl) {
    throw new Error(`Failed to create Supabase signed URL: ${error?.message ?? storagePath}`);
  }

  return data.signedUrl;
}

async function testLocalFetch(url) {
  const startedAt = Date.now();
  const response = await fetch(url, {
    headers: {
      Range: 'bytes=0-1048575',
    },
  });
  const buffer = Buffer.from(await response.arrayBuffer());

  return {
    ok: response.ok || response.status === 206,
    status: response.status,
    statusText: response.statusText,
    contentType: response.headers.get('content-type'),
    contentLength: response.headers.get('content-length'),
    sampledBytes: buffer.byteLength,
    durationMs: Date.now() - startedAt,
  };
}

async function testGeminiFetch({ url, mimeType, model, baseUrl, apiKey }) {
  const generateBaseUrl = resolveGeminiGenerateBaseUrl(baseUrl);
  const normalizedModel = normalizeGeminiModelForPath(model);
  const endpoint = `${generateBaseUrl}/models/${encodeURIComponent(normalizedModel)}:generateContent`;
  const requestBody = {
    system_instruction: {
      parts: [
        {
          text: 'You are testing whether a remote image URL can be fetched. Return compact JSON only.',
        },
      ],
    },
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: 'Read this image and return {"can_read_image":true,"brief_description":"..."} if it is visible.',
          },
          {
            file_data: {
              mime_type: mimeType,
              file_uri: url,
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 256,
    },
  };
  const startedAt = Date.now();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });
  const rawText = await response.text();
  let parsed = null;

  try {
    parsed = rawText ? JSON.parse(rawText) : null;
  } catch {
    parsed = null;
  }

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    durationMs: Date.now() - startedAt,
    endpoint,
    rawText,
    parsed,
  };
}

function printSection(title, value) {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  const repoRoot = resolve(import.meta.dirname, '..');
  loadEnvFile(resolve(repoRoot, '.env'));
  loadEnvFile(resolve(repoRoot, '.env.local'), { override: true });

  const args = parseArgs(process.argv.slice(2));

  if (hasHelpFlag(args)) {
    console.log(`Usage:
  node ./gemini_singed_url/test-gemini-signed-url.mjs --url "<signed-url>"
  node ./gemini_singed_url/test-gemini-signed-url.mjs --storage-path "<path>"

For browser-based testing, run:
  node ./gemini_singed_url/server.mjs

Then open:
  http://localhost:8787`);
    return;
  }
  const storagePath =
    args['storage-path'] ?? process.env.GEMINI_SIGNED_URL_TEST_STORAGE_PATH;
  const bucket = args.bucket ?? process.env.GEMINI_SIGNED_URL_TEST_BUCKET ?? DEFAULT_BUCKET;
  const url =
    args.url ??
    process.env.GEMINI_SIGNED_URL_TEST_URL ??
    (storagePath
      ? await createSupabaseSignedUrl({
          storagePath,
          bucket,
        })
      : '');

  if (!url) {
    throw new Error(
      'Provide --url, GEMINI_SIGNED_URL_TEST_URL, --storage-path, or GEMINI_SIGNED_URL_TEST_STORAGE_PATH.',
    );
  }

  const model =
    args.model ??
    process.env.GEMINI_SIGNED_URL_TEST_MODEL ??
    process.env.VISION_LLM_MODEL ??
    'gemini-3-flash-preview';
  const baseUrl =
    args['base-url'] ??
    process.env.GEMINI_SIGNED_URL_TEST_BASE_URL ??
    process.env.VISION_LLM_BASE_URL ??
    'https://generativelanguage.googleapis.com/v1beta/openai';
  const apiKey =
    args['api-key'] ??
    process.env.GEMINI_SIGNED_URL_TEST_API_KEY ??
    process.env.GEMINI_API_KEY ??
    process.env.VISION_LLM_API_KEY;
  const mimeType =
    args['mime-type'] ??
    process.env.GEMINI_SIGNED_URL_TEST_MIME_TYPE ??
    inferMimeTypeFromUrl(url);

  if (!apiKey) {
    throw new Error(
      'Missing Gemini API key. Set GEMINI_SIGNED_URL_TEST_API_KEY, GEMINI_API_KEY, or VISION_LLM_API_KEY.',
    );
  }

  printSection('Input', {
    source: storagePath ? 'fresh_supabase_signed_url' : 'provided_url',
    bucket: storagePath ? bucket : null,
    storagePath: storagePath ?? null,
    url,
    mimeType,
    model,
    baseUrl,
    signedUrlExpiresInSeconds: storagePath ? getSignedUrlExpiresInSeconds() : null,
  });

  const localFetch = await testLocalFetch(url);
  printSection('Local fetch', localFetch);

  const geminiFetch = await testGeminiFetch({
    url,
    mimeType,
    model,
    baseUrl,
    apiKey,
  });
  printSection('Gemini fetch', {
    ok: geminiFetch.ok,
    status: geminiFetch.status,
    statusText: geminiFetch.statusText,
    durationMs: geminiFetch.durationMs,
    endpoint: geminiFetch.endpoint,
    response: geminiFetch.parsed ?? geminiFetch.rawText,
  });

  if (localFetch.ok && geminiFetch.ok) {
    console.log('\nResult: Local fetch OK, Gemini fetch OK.');
    return;
  }

  if (localFetch.ok && !geminiFetch.ok) {
    console.log('\nResult: Local fetch OK, Gemini fetch FAILED.');
    process.exitCode = 2;
    return;
  }

  console.log('\nResult: Local fetch FAILED. Fix the signed URL/storage path first.');
  process.exitCode = 1;
}

main().catch((error) => {
  console.error('\nTest failed before completion.');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
