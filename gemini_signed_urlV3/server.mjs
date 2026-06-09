import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText } from 'ai';
import { createClient } from '@supabase/supabase-js';

const DEFAULT_BUCKET = 'generation-pdfs';
const DEFAULT_PORT = 8790;
const DEFAULT_SIGNED_URL_EXPIRES_IN_SECONDS = 10 * 60;

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

function json(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  response.end(JSON.stringify(payload, null, 2));
}

function text(response, statusCode, body, contentType) {
  response.writeHead(statusCode, {
    'Content-Type': contentType,
  });
  response.end(body);
}

function getRequiredEnv(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function getOptionalEnv(name) {
  return process.env[name]?.trim() || null;
}

function getSignedUrlExpiresInSeconds() {
  const parsed = Number(
    process.env.VERCEL_GEMINI_IMAGE_PROXY_TOKEN_EXPIRES_IN_SECONDS,
  );

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SIGNED_URL_EXPIRES_IN_SECONDS;
  }

  return Math.max(1, Math.floor(parsed));
}

function getSupabaseUrl() {
  return (
    getOptionalEnv('NEXT_PUBLIC_SUPABASE_URL') ??
    getOptionalEnv('SUPABASE_URL') ??
    getRequiredEnv('SUPABASE_PROJECT_URL')
  ).replace(/\/+$/u, '');
}

function getVisionLlmConfig() {
  const model =
    getOptionalEnv('GEMINI_SIGNED_URL_V3_MODEL') ??
    getOptionalEnv('VISION_LLM_MODEL') ??
    'gemini-3-flash-preview';
  const baseUrl =
    getOptionalEnv('GEMINI_SIGNED_URL_V3_BASE_URL') ??
    getOptionalEnv('VISION_LLM_BASE_URL') ??
    'https://generativelanguage.googleapis.com/v1beta';

  return {
    model,
    baseUrl: normalizeGoogleProviderBaseUrl(baseUrl),
    rawBaseUrl: baseUrl,
    apiKey:
      getOptionalEnv('GEMINI_SIGNED_URL_V3_API_KEY') ??
      getOptionalEnv('GEMINI_API_KEY') ??
      getRequiredEnv('VISION_LLM_API_KEY'),
    apiKeySource: getOptionalEnv('GEMINI_SIGNED_URL_V3_API_KEY')
      ? 'GEMINI_SIGNED_URL_V3_API_KEY'
      : getOptionalEnv('GEMINI_API_KEY')
        ? 'GEMINI_API_KEY'
        : 'VISION_LLM_API_KEY',
  };
}

function normalizeGoogleProviderBaseUrl(baseUrl) {
  const trimmed = baseUrl.replace(/\/+$/u, '');

  if (trimmed.endsWith('/openai')) {
    return trimmed.slice(0, -'/openai'.length);
  }

  return trimmed;
}

function inferMimeTypeFromPath(value) {
  const normalized = value.toLowerCase();

  if (normalized.endsWith('.png')) {
    return 'image/png';
  }

  if (normalized.endsWith('.webp')) {
    return 'image/webp';
  }

  return 'image/jpeg';
}

function parseLines(value) {
  if (typeof value !== 'string') {
    return [];
  }

  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseSupabaseStorageUrl(input) {
  let url;

  try {
    url = new URL(input);
  } catch {
    return null;
  }

  const marker = '/storage/v1/object/';
  const markerIndex = url.pathname.indexOf(marker);

  if (markerIndex < 0) {
    return null;
  }

  const rawObjectPath = url.pathname.slice(markerIndex + marker.length);
  const segments = rawObjectPath.split('/').filter(Boolean);

  if (segments.length < 2) {
    return null;
  }

  const accessKind = segments[0];
  const bucket = segments[1];
  const storagePathSegments = segments.slice(2);

  if (
    !['sign', 'public', 'authenticated'].includes(accessKind) ||
    !bucket ||
    storagePathSegments.length === 0
  ) {
    return null;
  }

  return {
    bucket,
    storagePath: storagePathSegments.map(decodeURIComponent).join('/'),
  };
}

function createSupabaseClient() {
  return createClient(getSupabaseUrl(), getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

async function createSupabaseSignedUrl({ bucket, storagePath }) {
  const supabase = createSupabaseClient();
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(storagePath, getSignedUrlExpiresInSeconds());

  if (error || !data?.signedUrl) {
    throw new Error(
      `Supabase signed URL failed: ${
        error?.message ?? 'Missing signedUrl in Supabase response.'
      }`,
    );
  }

  return data.signedUrl;
}

async function resolveImageInputs({ rawInputs, defaultBucket, defaultMimeType }) {
  return Promise.all(
    rawInputs.map(async (rawInput, index) => {
      const supabaseUrlParts = parseSupabaseStorageUrl(rawInput);
      const bucket = supabaseUrlParts?.bucket ?? defaultBucket;
      const storagePath = supabaseUrlParts?.storagePath ?? rawInput;
      const mimeType =
        defaultMimeType === 'auto'
          ? inferMimeTypeFromPath(storagePath)
          : defaultMimeType;
      const signedUrl = await createSupabaseSignedUrl({
        bucket,
        storagePath,
      });

      return {
        index: index + 1,
        pageNumber: index + 1,
        input: rawInput,
        inputType: supabaseUrlParts ? 'supabase_storage_url' : 'storage_path',
        bucket,
        storagePath,
        mimeType,
        signedUrl,
        signedUrlExpiresInSeconds: getSignedUrlExpiresInSeconds(),
      };
    }),
  );
}

function buildPromptPayload(imageInputs) {
  return {
    task: 'AI SDK Google provider image URL fetch test.',
    instruction:
      'Read the provided PDF page image(s) and return compact JSON only.',
    page_numbers: imageInputs.map((input) => input.pageNumber),
    output_schema: {
      can_read_images: true,
      page_count: imageInputs.length,
      readable_page_numbers: imageInputs.map((input) => input.pageNumber),
      notes: 'short description',
    },
  };
}

function buildAiSdkMessages(imageInputs) {
  return [
    {
      role: 'system',
      content:
        'Directly inspect these PDF page images. Return compact valid JSON only.',
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: JSON.stringify(buildPromptPayload(imageInputs)),
        },
        ...imageInputs.flatMap((input) => [
          {
            type: 'text',
            text: `Page ${input.pageNumber}: uploaded storage path ${input.storagePath}`,
          },
          {
            type: 'image',
            image: new URL(input.signedUrl),
            mediaType: input.mimeType,
          },
        ]),
      ],
    },
  ];
}

async function testWithAiSdkGoogle(imageInputs) {
  const config = getVisionLlmConfig();

  if (!config.model.toLowerCase().includes('gemini')) {
    throw new Error(
      `VISION_LLM_MODEL must be a Gemini model for @ai-sdk/google, current value: ${config.model}`,
    );
  }

  const google = createGoogleGenerativeAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
  });
  const startedAt = Date.now();
  const messages = buildAiSdkMessages(imageInputs);
  const result = await generateText({
    model: google(config.model),
    messages,
    providerOptions: {
      google: {
        structuredOutputs: false,
        thinkingConfig: {
          thinkingLevel: 'low',
        },
      },
    },
  });

  return {
    ok: true,
    durationMs: Date.now() - startedAt,
    providerPackage: '@ai-sdk/google',
    model: config.model,
    baseUrl: config.baseUrl,
    rawBaseUrl: config.rawBaseUrl,
    apiKeySource: config.apiKeySource,
    text: result.text,
    usage: result.usage ?? null,
    finishReason: result.finishReason ?? null,
    response: {
      id: result.response?.id ?? null,
      modelId: result.response?.modelId ?? null,
      timestamp: result.response?.timestamp ?? null,
    },
    requestPreview: {
      messageCount: messages.length,
      imageCount: imageInputs.length,
      imageUrls: imageInputs.map((input) => input.signedUrl),
    },
  };
}

async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString('utf8');

  return raw ? JSON.parse(raw) : {};
}

async function handleConfig(_request, response) {
  const config = getVisionLlmConfig();

  json(response, 200, {
    visionLlm: {
      model: config.model,
      baseUrl: config.baseUrl,
      rawBaseUrl: config.rawBaseUrl,
      apiKeySource: config.apiKeySource,
      signedUrlExpiresInSeconds: getSignedUrlExpiresInSeconds(),
    },
  });
}

async function handleTest(request, response) {
  const body = await readJsonBody(request);
  const rawInputs = parseLines(body.imageInputs);
  const bucket =
    typeof body.bucket === 'string' && body.bucket.trim()
      ? body.bucket.trim()
      : DEFAULT_BUCKET;
  const mimeType =
    typeof body.mimeType === 'string' && body.mimeType.trim()
      ? body.mimeType.trim()
      : 'auto';

  if (rawInputs.length === 0) {
    json(response, 400, {
      error: 'Provide one or more Supabase storage paths or Supabase storage URLs.',
    });
    return;
  }

  const imageInputs = await resolveImageInputs({
    rawInputs,
    defaultBucket: bucket,
    defaultMimeType: mimeType,
  });

  try {
    const aiSdkGoogleFetch = await testWithAiSdkGoogle(imageInputs);

    json(response, 200, {
      input: {
        imageCount: imageInputs.length,
        bucket,
        mimeType,
      },
      imageInputs,
      aiSdkGoogleFetch,
      result: 'AI SDK Google fetch OK.',
    });
  } catch (error) {
    json(response, 200, {
      input: {
        imageCount: imageInputs.length,
        bucket,
        mimeType,
      },
      imageInputs,
      aiSdkGoogleFetch: {
        ok: false,
        providerPackage: '@ai-sdk/google',
        errorName: error instanceof Error ? error.name : null,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : null,
        cause: error instanceof Error ? String(error.cause ?? '') : null,
      },
      result: 'AI SDK Google fetch FAILED.',
    });
  }
}

const repoRoot = resolve(import.meta.dirname, '..');
loadEnvFile(resolve(repoRoot, '.env'));
loadEnvFile(resolve(repoRoot, '.env.local'), { override: true });

const port = Number(process.env.GEMINI_SIGNED_URL_V3_PORT ?? DEFAULT_PORT);
const html = readFileSync(resolve(import.meta.dirname, 'test.html'), 'utf8');

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? '/', `http://localhost:${port}`);

    if (request.method === 'OPTIONS') {
      json(response, 204, {});
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/') {
      text(response, 200, html, 'text/html; charset=utf-8');
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/config') {
      await handleConfig(request, response);
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/test') {
      await handleTest(request, response);
      return;
    }

    json(response, 404, {
      error: 'Not found.',
    });
  } catch (error) {
    json(response, 500, {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
    });
  }
});

server.listen(port, () => {
  console.log(`Gemini signed URL V3 AI SDK Google test is running: http://localhost:${port}`);
});
