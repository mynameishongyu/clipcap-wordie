import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const PORT = Number(process.env.PORT || 8042);
const PROJECT_ROOT = process.cwd();
const ROOT_DIR = path.resolve(PROJECT_ROOT, 'png_pdf');
const OUTPUT_ROOT = path.join(ROOT_DIR, 'output');
const SCRIPT_PATH = path.join(ROOT_DIR, 'convert-supabase-pdf.mjs');
const MAX_BODY_BYTES = 1024 * 1024;

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function sanitizeName(value) {
  return String(value || 'png-prefix')
    .replace(/[\\/:"*?<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 90);
}

function getLastPathSegment(value) {
  return String(value || '')
    .split('/')
    .filter(Boolean)
    .at(-1);
}

function normalizePrefix(input) {
  const value = String(input || '').trim().replace(/^\/+|\/+$/g, '');

  if (!value) {
    return '';
  }

  return value.replace(/^generation-pdfs\/+/, '');
}

function parsePositiveNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive number: ${value}`);
  }

  return parsed;
}

async function readRequestJson(request) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    totalBytes += chunk.length;

    if (totalBytes > MAX_BODY_BYTES) {
      throw new Error('Request body is too large.');
    }

    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function runConvertScript(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT_PATH, ...args], {
      cwd: PROJECT_ROOT,
      env: process.env,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      resolve({
        code,
        stdout,
        stderr,
      });
    });
  });
}

async function handleConvert(request, response) {
  const body = await readRequestJson(request);
  const bucket = String(body.bucket || 'generation-pdfs').trim();
  const prefix = normalizePrefix(body.prefix);
  const pageWidth = parsePositiveNumber(body.pageWidth);
  const pageHeight = parsePositiveNumber(body.pageHeight);
  const uploadPath = String(body.uploadPath || '').trim();

  if (!prefix) {
    sendJson(response, 400, {
      error: '请输入 Supabase PNG 文件夹 prefix。',
    });
    return;
  }

  if (!bucket) {
    sendJson(response, 400, {
      error: 'bucket 不能为空。',
    });
    return;
  }

  const runName = `${sanitizeName(getLastPathSegment(prefix)) || 'png-prefix'}-${new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14)}`;
  const outputDir = path.join(OUTPUT_ROOT, runName);
  const scriptArgs = [
    '--png-prefix',
    prefix,
    '--bucket',
    bucket,
    '--out',
    outputDir,
  ];

  if (pageWidth) {
    scriptArgs.push('--page-width', String(pageWidth));
  }

  if (pageHeight) {
    scriptArgs.push('--page-height', String(pageHeight));
  }

  if (uploadPath) {
    scriptArgs.push('--upload-path', uploadPath);
  }

  await mkdir(outputDir, { recursive: true });

  const result = await runConvertScript(scriptArgs);
  const log = [result.stdout, result.stderr].filter(Boolean).join('\n');

  if (result.code !== 0) {
    sendJson(response, 500, {
      error: 'PNG 转 PDF 失败。',
      log,
    });
    return;
  }

  const manifestPath = path.join(outputDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  sendJson(response, 200, {
    data: {
      runName,
      prefix,
      bucket,
      pdfUrl: `/output/${encodeURIComponent(runName)}/rebuilt-from-png.pdf`,
      manifestUrl: `/output/${encodeURIComponent(runName)}/manifest.json`,
      pagesUrl: `/output/${encodeURIComponent(runName)}/pages/`,
      outputDir,
      pageCount: manifest.pages?.length ?? 0,
      uploadedPath: manifest.uploadedPath ?? null,
      log,
    },
  });
}

async function serveFile(response, filePath) {
  const content = await readFile(filePath);
  const extension = path.extname(filePath).toLowerCase();

  response.writeHead(200, {
    'content-type':
      MIME_TYPES.get(extension) || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  response.end(content);
}

async function serveStatic(request, response) {
  const url = new URL(request.url || '/', `http://127.0.0.1:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith('/output/')) {
    const outputPath = path.resolve(
      path.join(OUTPUT_ROOT, pathname.replace(/^\/output\/+/, '')),
    );

    if (!outputPath.startsWith(OUTPUT_ROOT) || !existsSync(outputPath)) {
      response.writeHead(404);
      response.end('Not Found');
      return;
    }

    const filePath = outputPath.endsWith(path.sep)
      ? path.join(outputPath, 'manifest.json')
      : outputPath;

    await serveFile(response, filePath);
    return;
  }

  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(path.join(ROOT_DIR, requestedPath));

  if (!filePath.startsWith(ROOT_DIR) || !existsSync(filePath)) {
    response.writeHead(404);
    response.end('Not Found');
    return;
  }

  await serveFile(response, filePath);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://127.0.0.1:${PORT}`);

    if (request.method === 'POST' && url.pathname === '/api/convert') {
      await handleConvert(request, response);
      return;
    }

    if (request.method !== 'GET') {
      response.writeHead(405);
      response.end('Method Not Allowed');
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
  console.log(`png_pdf server running at http://127.0.0.1:${PORT}`);
});
