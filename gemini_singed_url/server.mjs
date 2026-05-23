import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const DEFAULT_BUCKET = 'generation-pdfs';
const DEFAULT_PORT = 8787;
const DEFAULT_SIGNED_URL_EXPIRES_IN_SECONDS = 60 * 60;
const DEFAULT_PROXY_TOKEN_EXPIRES_IN_SECONDS = 10 * 60;

function loadEnvFile(filePath, options = {}) {
  const { override = false } = options;

  try {
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
  } catch {
    // Optional env file.
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

function getSignedUrlExpiresInSeconds() {
  return DEFAULT_SIGNED_URL_EXPIRES_IN_SECONDS;
}

function getProxyTokenExpiresInSeconds() {
  const parsed = Number(process.env.VERCEL_GEMINI_IMAGE_PROXY_TOKEN_EXPIRES_IN_SECONDS);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_PROXY_TOKEN_EXPIRES_IN_SECONDS;
  }

  return Math.max(1, Math.floor(parsed));
}

function normalizeGeminiModelForPath(model) {
  return model.trim().replace(/^models\//u, '');
}

function resolveGeminiGenerateBaseUrl(baseUrl) {
  const url = new URL(baseUrl || 'https://generativelanguage.googleapis.com');

  return `${url.origin}/v1beta`;
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

function base64UrlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function getProxySecret() {
  return (
    process.env.GEMINI_SIGNED_URL_PROXY_SECRET ??
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    'local-gemini-signed-url-test-secret'
  );
}

function signProxyPayload(payload) {
  return createHmac('sha256', getProxySecret()).update(payload).digest('base64url');
}

function createProxyToken(input) {
  const expiresAt = Math.floor(Date.now() / 1000) + getProxyTokenExpiresInSeconds();
  const payload = base64UrlEncode(
    JSON.stringify({
      bucket: input.bucket,
      storagePath: input.storagePath,
      mimeType: input.mimeType,
      exp: expiresAt,
    }),
  );
  const signature = signProxyPayload(payload);

  return `${payload}.${signature}`;
}

function verifyProxyToken(token) {
  const [payload, signature] = token.split('.');

  if (!payload || !signature) {
    throw new Error('Invalid proxy token.');
  }

  const expectedSignature = signProxyPayload(payload);
  const signatureBuffer = Buffer.from(signature);
  const expectedSignatureBuffer = Buffer.from(expectedSignature);

  if (
    signatureBuffer.length !== expectedSignatureBuffer.length ||
    !timingSafeEqual(signatureBuffer, expectedSignatureBuffer)
  ) {
    throw new Error('Invalid proxy token signature.');
  }

  const parsed = JSON.parse(base64UrlDecode(payload));

  if (!parsed.exp || parsed.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Proxy token expired.');
  }

  if (!parsed.bucket || !parsed.storagePath || !parsed.mimeType) {
    throw new Error('Proxy token missing required fields.');
  }

  return parsed;
}

function buildProxyUrl({ publicBaseUrl, bucket, storagePath, mimeType }) {
  const baseUrl = publicBaseUrl.replace(/\/+$/u, '');
  const token = createProxyToken({ bucket, storagePath, mimeType });

  return `${baseUrl}/proxy-image?token=${encodeURIComponent(token)}`;
}

function getVisionLlmConfig() {
  return {
    model:
      process.env.GEMINI_SIGNED_URL_TEST_MODEL ??
      process.env.VISION_LLM_MODEL ??
      'gemini-3-flash-preview',
    baseUrl:
      process.env.GEMINI_SIGNED_URL_TEST_BASE_URL ??
      process.env.VISION_LLM_BASE_URL ??
      'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeySource: process.env.GEMINI_SIGNED_URL_TEST_API_KEY
      ? 'GEMINI_SIGNED_URL_TEST_API_KEY'
      : process.env.GEMINI_API_KEY
        ? 'GEMINI_API_KEY'
        : process.env.VISION_LLM_API_KEY
          ? 'VISION_LLM_API_KEY'
          : null,
    proxyTokenExpiresInSeconds: getProxyTokenExpiresInSeconds(),
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

async function createSignedUrl({ storagePath, bucket }) {
  const supabase = createClient(
    getRequiredEnv('SUPABASE_URL'),
    getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  );
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(storagePath, getSignedUrlExpiresInSeconds());

  if (error || !data?.signedUrl) {
    throw new Error(`Failed to create Supabase signed URL: ${error?.message ?? storagePath}`);
  }

  return data.signedUrl;
}

async function handleProxyImage(requestUrl, response) {
  const token = requestUrl.searchParams.get('token') ?? '';
  const payload = verifyProxyToken(token);
  const signedUrl = await createSignedUrl({
    bucket: payload.bucket,
    storagePath: payload.storagePath,
  });
  const upstream = await fetch(signedUrl);

  if (!upstream.ok || !upstream.body) {
    json(response, upstream.status || 502, {
      error: `Failed to fetch Supabase object: ${upstream.status} ${upstream.statusText}`,
    });
    return;
  }

  const headers = {
    'Content-Type': upstream.headers.get('content-type') ?? payload.mimeType,
    'Cache-Control': 'no-store',
  };
  const contentLength = upstream.headers.get('content-length');

  if (contentLength) {
    headers['Content-Length'] = contentLength;
  }

  response.writeHead(200, headers);

  for await (const chunk of upstream.body) {
    response.write(Buffer.from(chunk));
  }

  response.end();
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

async function testGeminiFetch({ url, mimeType }) {
  const model = process.env.GEMINI_SIGNED_URL_TEST_MODEL ?? process.env.VISION_LLM_MODEL ?? 'gemini-3-flash-preview';
  const baseUrl =
    process.env.GEMINI_SIGNED_URL_TEST_BASE_URL ??
    process.env.VISION_LLM_BASE_URL ??
    'https://generativelanguage.googleapis.com/v1beta/openai';
  const apiKey =
    process.env.GEMINI_SIGNED_URL_TEST_API_KEY ??
    process.env.GEMINI_API_KEY ??
    process.env.VISION_LLM_API_KEY;

  if (!apiKey) {
    throw new Error('Missing Gemini API key.');
  }

  const endpoint = `${resolveGeminiGenerateBaseUrl(baseUrl)}/models/${encodeURIComponent(
    normalizeGeminiModelForPath(model),
  )}:generateContent`;
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
    model,
    baseUrl,
    response: parsed ?? rawText,
  };
}

async function handleTest(request, response) {
  const body = await readJsonBody(request);
  const storagePath = typeof body.storagePath === 'string' ? body.storagePath.trim() : '';
  const providedUrl = typeof body.url === 'string' ? body.url.trim() : '';
  const publicBaseUrl =
    typeof body.publicBaseUrl === 'string' ? body.publicBaseUrl.trim() : '';
  const bucket = typeof body.bucket === 'string' && body.bucket.trim()
    ? body.bucket.trim()
    : DEFAULT_BUCKET;
  const requestedMode = typeof body.mode === 'string' ? body.mode : 'supabase';
  const mimeType =
    typeof body.mimeType === 'string' && body.mimeType.trim()
      ? body.mimeType.trim()
      : providedUrl
        ? inferMimeTypeFromUrl(providedUrl)
        : 'image/jpeg';
  const url = providedUrl
    ? providedUrl
    : requestedMode === 'proxy'
      ? storagePath && publicBaseUrl
        ? buildProxyUrl({ publicBaseUrl, bucket, storagePath, mimeType })
        : ''
      : storagePath
        ? await createSignedUrl({ storagePath, bucket })
        : '';

  if (!url) {
    json(response, 400, {
      error:
        requestedMode === 'proxy'
          ? 'Provide a storage path and an ngrok public base URL for proxy mode.'
          : 'Provide a signed URL or a storage path.',
    });
    return;
  }

  const localFetch = await testLocalFetch(url);
  const geminiFetch = await testGeminiFetch({ url, mimeType });

  json(response, 200, {
    input: {
      source: providedUrl
        ? 'provided_url'
        : requestedMode === 'proxy'
          ? 'ngrok_proxy_signed_url'
          : 'fresh_supabase_signed_url',
      bucket: storagePath ? bucket : null,
      storagePath: storagePath || null,
      publicBaseUrl: publicBaseUrl || null,
      url,
      mimeType,
    },
    localFetch,
    geminiFetch,
    result:
      localFetch.ok && geminiFetch.ok
        ? 'Local fetch OK, Gemini fetch OK.'
        : localFetch.ok
          ? 'Local fetch OK, Gemini fetch FAILED.'
          : 'Local fetch FAILED.',
  });
}

const repoRoot = resolve(import.meta.dirname, '..');
loadEnvFile(resolve(repoRoot, '.env'));
loadEnvFile(resolve(repoRoot, '.env.local'), { override: true });

const port = Number(process.env.GEMINI_SIGNED_URL_TEST_PORT ?? DEFAULT_PORT);
const html = readFileSync(resolve(import.meta.dirname, 'test.html'), 'utf8');

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      response.end();
      return;
    }

    const url = new URL(request.url ?? '/', `http://localhost:${port}`);

    if (request.method === 'GET' && url.pathname === '/') {
      text(response, 200, html, 'text/html; charset=utf-8');
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/config') {
      json(response, 200, {
        visionLlm: getVisionLlmConfig(),
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/proxy-image') {
      await handleProxyImage(url, response);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/test') {
      await handleTest(request, response);
      return;
    }

    json(response, 404, {
      error: 'Not found.',
    });
  } catch (error) {
    json(response, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(port, () => {
  console.log(`Gemini signed URL browser test is running: http://localhost:${port}`);
});
