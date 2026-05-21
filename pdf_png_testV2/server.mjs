import { createServer } from 'http';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { extname, join, resolve } from 'path';

const PORT = Number(process.env.PORT || 8031);
const ROOT_DIR = resolve(process.cwd(), 'pdf_png_testV2');
const ENV_PATH = resolve(process.cwd(), '.env.local');
const DEFAULT_PDF_RENDER_SCALE = 6;
const DEFAULT_PDF_RENDER_JPEG_QUALITY = 0.92;
const DEFAULT_PDF_AUTO_ROTATE_PAGES = true;
const DEFAULT_PDF_JPEG_MAX_LONG_EDGE = 3200;
const DEFAULT_PDF_JPEG_GRAYSCALE = false;
const DEFAULT_PDF_JPEG_BACKGROUND_CLEANUP = false;
const DEFAULT_PDF_JPEG_BACKGROUND_WHITE_THRESHOLD = 246;
const DEFAULT_PDF_JPEG_BACKGROUND_INK_THRESHOLD = 190;
const DEFAULT_PDF_JPEG_CONTRAST = 1.04;

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
]);

function parseEnvFile(content) {
  const env = {};

  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }

    const equalsIndex = trimmed.indexOf('=');

    if (equalsIndex <= 0) {
      return;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    env[key] = value;
  });

  return env;
}

async function readLocalEnv() {
  if (!existsSync(ENV_PATH)) {
    return {};
  }

  return parseEnvFile(await readFile(ENV_PATH, 'utf8'));
}

function clampNumber(value, fallback, min, max) {
  const parsedValue = Number(value);

  if (!Number.isFinite(parsedValue)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsedValue));
}

function getBooleanEnv(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) {
    return fallback;
  }

  const normalizedValue = value.trim().toLowerCase();

  if (['0', 'false', 'off', 'no'].includes(normalizedValue)) {
    return false;
  }

  if (['1', 'true', 'on', 'yes'].includes(normalizedValue)) {
    return true;
  }

  return fallback;
}

function getPdfRenderConfig(env) {
  return {
    rawEnv: {
      NEXT_PUBLIC_PDF_RENDER_SCALE: env.NEXT_PUBLIC_PDF_RENDER_SCALE || '',
      NEXT_PUBLIC_PDF_RENDER_IMAGE_FORMAT:
        env.NEXT_PUBLIC_PDF_RENDER_IMAGE_FORMAT || '',
      NEXT_PUBLIC_PDF_RENDER_JPEG_QUALITY:
        env.NEXT_PUBLIC_PDF_RENDER_JPEG_QUALITY || '',
      NEXT_PUBLIC_PDF_AUTO_ROTATE_PAGES:
        env.NEXT_PUBLIC_PDF_AUTO_ROTATE_PAGES || '',
      NEXT_PUBLIC_PDF_RENDER_JPEG_MAX_LONG_EDGE:
        env.NEXT_PUBLIC_PDF_RENDER_JPEG_MAX_LONG_EDGE || '',
      NEXT_PUBLIC_PDF_RENDER_JPEG_GRAYSCALE:
        env.NEXT_PUBLIC_PDF_RENDER_JPEG_GRAYSCALE || '',
      NEXT_PUBLIC_PDF_RENDER_JPEG_BACKGROUND_CLEANUP:
        env.NEXT_PUBLIC_PDF_RENDER_JPEG_BACKGROUND_CLEANUP || '',
    },
    scale: clampNumber(
      env.NEXT_PUBLIC_PDF_RENDER_SCALE,
      DEFAULT_PDF_RENDER_SCALE,
      0.1,
      10,
    ),
    imageFormat: 'image/jpeg',
    imageQuality: clampNumber(
      env.NEXT_PUBLIC_PDF_RENDER_JPEG_QUALITY,
      DEFAULT_PDF_RENDER_JPEG_QUALITY,
      0.1,
      1,
    ),
    autoRotatePages: getBooleanEnv(
      env.NEXT_PUBLIC_PDF_AUTO_ROTATE_PAGES,
      DEFAULT_PDF_AUTO_ROTATE_PAGES,
    ),
    maxLongEdge: clampNumber(
      env.NEXT_PUBLIC_PDF_RENDER_JPEG_MAX_LONG_EDGE,
      DEFAULT_PDF_JPEG_MAX_LONG_EDGE,
      0,
      8000,
    ),
    grayscale: getBooleanEnv(
      env.NEXT_PUBLIC_PDF_RENDER_JPEG_GRAYSCALE,
      DEFAULT_PDF_JPEG_GRAYSCALE,
    ),
    backgroundCleanup: getBooleanEnv(
      env.NEXT_PUBLIC_PDF_RENDER_JPEG_BACKGROUND_CLEANUP,
      DEFAULT_PDF_JPEG_BACKGROUND_CLEANUP,
    ),
    backgroundWhiteThreshold: clampNumber(
      env.NEXT_PUBLIC_PDF_RENDER_JPEG_BACKGROUND_WHITE_THRESHOLD,
      DEFAULT_PDF_JPEG_BACKGROUND_WHITE_THRESHOLD,
      0,
      255,
    ),
    backgroundInkThreshold: clampNumber(
      env.NEXT_PUBLIC_PDF_RENDER_JPEG_BACKGROUND_INK_THRESHOLD,
      DEFAULT_PDF_JPEG_BACKGROUND_INK_THRESHOLD,
      0,
      255,
    ),
    contrast: clampNumber(
      env.NEXT_PUBLIC_PDF_RENDER_JPEG_CONTRAST,
      DEFAULT_PDF_JPEG_CONTRAST,
      0.1,
      3,
    ),
  };
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

async function handleConfig(response) {
  const env = await readLocalEnv();
  sendJson(response, 200, getPdfRenderConfig(env));
}

async function serveStatic(request, response) {
  const url = new URL(request.url || '/', `http://127.0.0.1:${PORT}`);
  const requestedPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = resolve(join(ROOT_DIR, requestedPath));

  if (!filePath.startsWith(ROOT_DIR)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      'content-type':
        MIME_TYPES.get(extname(filePath).toLowerCase()) ||
        'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(content);
  } catch {
    response.writeHead(404);
    response.end('Not Found');
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://127.0.0.1:${PORT}`);

    if (url.pathname === '/api/config') {
      await handleConfig(response);
      return;
    }

    await serveStatic(request, response);
  } catch (error) {
    console.error(error);
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`PDF JPEG V2 test server: http://127.0.0.1:${PORT}`);
  console.log(`Reading PDF render config from: ${ENV_PATH}`);
});
