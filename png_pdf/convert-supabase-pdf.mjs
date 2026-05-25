import { deflateSync } from 'node:zlib';
import { existsSync } from 'node:fs';
import {
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { DOMMatrix, ImageData, Path2D, createCanvas, loadImage } from '@napi-rs/canvas';

const DEFAULT_BUCKET = 'generation-pdfs';
const DEFAULT_SCALE = 2;
const DEFAULT_OUTPUT_ROOT = path.resolve(process.cwd(), 'png_pdf', 'output');
const ENV_PATH = path.resolve(process.cwd(), '.env.local');
const PDFJS_CMAP_URL = `${pathToFileURL(
  path.join(process.cwd(), 'node_modules', 'pdfjs-dist', 'cmaps'),
).href}/`;
const PDFJS_STANDARD_FONT_DATA_URL = `${pathToFileURL(
  path.join(process.cwd(), 'node_modules', 'pdfjs-dist', 'standard_fonts'),
).href}/`;

function parseEnvFile(content) {
  const env = {};

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const equalsIndex = trimmed.indexOf('=');

    if (equalsIndex <= 0) {
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

    env[key] = value;
  }

  return env;
}

async function loadLocalEnv() {
  if (!existsSync(ENV_PATH)) {
    return;
  }

  const env = parseEnvFile(await readFile(ENV_PATH, 'utf8'));

  for (const [key, value] of Object.entries(env)) {
    process.env[key] ??= value;
  }
}

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const key = token.slice(2);

    if (key === 'help') {
      args.help = true;
      continue;
    }

    const value = argv[index + 1];

    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }

    args[key] = value;
    index += 1;
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node png_pdf/convert-supabase-pdf.mjs --path <storage-path> [options]
  node png_pdf/convert-supabase-pdf.mjs --png-prefix <storage-folder-prefix> [options]
  node png_pdf/convert-supabase-pdf.mjs --task-item-id <uuid> [options]

Options:
  --bucket <bucket>         Supabase Storage bucket. Default: generation-pdfs
  --scale <number>          PDF render scale for PNG output. Default: 2
  --page-width <points>     Page width for PNG-prefix mode. Default: image width at 72 DPI
  --page-height <points>    Page height for PNG-prefix mode. Default: image height at 72 DPI
  --out <directory>         Output run directory. Default: png_pdf/output/<name>
  --upload-path <path>      Optional Supabase Storage path for rebuilt PDF upload

Examples:
  node png_pdf/convert-supabase-pdf.mjs --path "user-id/generation-tasks/task/file.pdf"
  node png_pdf/convert-supabase-pdf.mjs --png-prefix "user-id/template-extraction-pages/task/865e18aa-1094-4d20-8bb6"
  node png_pdf/convert-supabase-pdf.mjs --task-item-id "00000000-0000-0000-0000-000000000000" --scale 3
`);
}

function getEnv(name, aliases = []) {
  for (const key of [name, ...aliases]) {
    const value = process.env[key];

    if (value?.trim()) {
      return value.trim();
    }
  }

  return null;
}

function createSupabaseAdmin() {
  const url = getEnv('SUPABASE_URL', ['NEXT_PUBLIC_SUPABASE_URL']);
  const key = getEnv('SUPABASE_SERVICE_ROLE_KEY', [
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  ]);

  if (!url) {
    throw new Error('Missing SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL.');
  }

  if (!key) {
    throw new Error(
      'Missing SUPABASE_SERVICE_ROLE_KEY. An anon key only works for public/readable objects.',
    );
  }

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function sanitizeName(value) {
  return value
    .replace(/[\\/:"*?<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}

function parsePositiveNumber(value, fallback) {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive number, received: ${value}`);
  }

  return parsed;
}

function formatBytes(byteCount) {
  if (byteCount < 1024) {
    return `${byteCount} B`;
  }

  if (byteCount < 1024 * 1024) {
    return `${(byteCount / 1024).toFixed(2)} KB`;
  }

  return `${(byteCount / 1024 / 1024).toFixed(2)} MB`;
}

async function resolveStoragePath(input) {
  if (input.storagePath) {
    return {
      storagePath: input.storagePath,
      sourceName: path.basename(input.storagePath),
    };
  }

  if (!input.taskItemId) {
    throw new Error('Pass either --path or --task-item-id.');
  }

  const { data, error } = await input.supabase
    .from('generation_task_items')
    .select('source_pdf_path, source_pdf_name')
    .eq('id', input.taskItemId)
    .single();

  if (error) {
    throw error;
  }

  if (!data?.source_pdf_path) {
    throw new Error(`No source_pdf_path found for task item ${input.taskItemId}.`);
  }

  return {
    storagePath: data.source_pdf_path,
    sourceName: data.source_pdf_name || path.basename(data.source_pdf_path),
  };
}

async function downloadStorageObject(input) {
  const { data, error } = await input.supabase.storage
    .from(input.bucket)
    .download(input.storagePath);

  if (error) {
    throw error;
  }

  if (!data) {
    throw new Error(`Storage object is empty: ${input.storagePath}`);
  }

  return Buffer.from(await data.arrayBuffer());
}

function getStorageBasename(storagePath) {
  return storagePath.split('/').filter(Boolean).at(-1) || storagePath;
}

function getPageSortNumber(storagePath) {
  const basename = getStorageBasename(storagePath);
  const match =
    basename.match(/page[-_ ]?(\d+)/i) ??
    basename.match(/(\d+)(?=\.png$)/i);

  return match?.[1] ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

async function listStorageObjectPathsByPrefix(input) {
  const bucket = input.supabase.storage.from(input.bucket);
  const normalizedPrefix = input.prefix.replace(/\/+$/, '');
  const paths = [];

  async function visit(folderPath) {
    const limit = 100;
    let offset = 0;

    while (true) {
      const { data, error } = await bucket.list(folderPath, {
        limit,
        offset,
        sortBy: {
          column: 'name',
          order: 'asc',
        },
      });

      if (error) {
        throw error;
      }

      const entries = data || [];

      for (const entry of entries) {
        const entryPath = `${folderPath}/${entry.name}`;

        if (!entry.id && entry.metadata === null) {
          await visit(entryPath);
        } else {
          paths.push(entryPath);
        }
      }

      if (entries.length < limit) {
        break;
      }

      offset += limit;
    }
  }

  await visit(normalizedPrefix);

  return paths;
}

async function loadPdfJs() {
  if (typeof globalThis.DOMMatrix === 'undefined') {
    globalThis.DOMMatrix = DOMMatrix;
  }

  if (typeof globalThis.ImageData === 'undefined') {
    globalThis.ImageData = ImageData;
  }

  if (typeof globalThis.Path2D === 'undefined') {
    globalThis.Path2D = Path2D;
  }

  const pdfjsGlobal = globalThis;

  if (typeof pdfjsGlobal.pdfjsWorker === 'undefined') {
    pdfjsGlobal.pdfjsWorker = await import(
      'pdfjs-dist/legacy/build/pdf.worker.mjs'
    );
  }

  return import('pdfjs-dist/legacy/build/pdf.mjs');
}

function canvasToRgbBuffer(canvas) {
  const context = canvas.getContext('2d');
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const rgba = imageData.data;
  const rgb = Buffer.allocUnsafe(canvas.width * canvas.height * 3);
  let targetIndex = 0;

  for (let sourceIndex = 0; sourceIndex < rgba.length; sourceIndex += 4) {
    const alpha = rgba[sourceIndex + 3];

    if (alpha === 255) {
      rgb[targetIndex++] = rgba[sourceIndex];
      rgb[targetIndex++] = rgba[sourceIndex + 1];
      rgb[targetIndex++] = rgba[sourceIndex + 2];
      continue;
    }

    const opacity = alpha / 255;

    rgb[targetIndex++] = Math.round(rgba[sourceIndex] * opacity + 255 * (1 - opacity));
    rgb[targetIndex++] = Math.round(
      rgba[sourceIndex + 1] * opacity + 255 * (1 - opacity),
    );
    rgb[targetIndex++] = Math.round(
      rgba[sourceIndex + 2] * opacity + 255 * (1 - opacity),
    );
  }

  return rgb;
}

async function renderPdfToPngPages(input) {
  const pdfjs = await loadPdfJs();
  const pdfDocument = await pdfjs.getDocument({
    data: new Uint8Array(input.pdfBytes),
    cMapUrl: PDFJS_CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: PDFJS_STANDARD_FONT_DATA_URL,
    useSystemFonts: true,
  }).promise;
  const pagesDir = path.join(input.outputDir, 'pages');

  await mkdir(pagesDir, { recursive: true });

  const pages = [];

  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber);
    const pdfViewport = page.getViewport({ scale: 1 });
    const renderViewport = page.getViewport({ scale: input.scale });
    const canvas = createCanvas(
      Math.ceil(renderViewport.width),
      Math.ceil(renderViewport.height),
    );
    const context = canvas.getContext('2d');

    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({
      canvasContext: context,
      viewport: renderViewport,
      canvas,
    }).promise;

    const pngBuffer = canvas.toBuffer('image/png');
    const pngPath = path.join(
      pagesDir,
      `page-${String(pageNumber).padStart(3, '0')}.png`,
    );

    await writeFile(pngPath, pngBuffer);

    const rgbBuffer = canvasToRgbBuffer(canvas);

    pages.push({
      pageNumber,
      pngPath,
      pngBytes: pngBuffer.length,
      widthPx: canvas.width,
      heightPx: canvas.height,
      widthPt: pdfViewport.width,
      heightPt: pdfViewport.height,
      rgbBuffer,
    });

    console.log(
      `Rendered page ${pageNumber}/${pdfDocument.numPages}: ${canvas.width}x${canvas.height}px, ${formatBytes(pngBuffer.length)}`,
    );
  }

  return pages;
}

async function downloadPngPrefixPages(input) {
  const storagePaths = (
    await listStorageObjectPathsByPrefix({
      supabase: input.supabase,
      bucket: input.bucket,
      prefix: input.prefix,
    })
  )
    .sort((left, right) => {
      const leftPageNumber = getPageSortNumber(left);
      const rightPageNumber = getPageSortNumber(right);

      if (leftPageNumber !== rightPageNumber) {
        return leftPageNumber - rightPageNumber;
      }

      return left.localeCompare(right);
    });

  if (storagePaths.length === 0) {
    throw new Error(`No files found under ${input.bucket}/${input.prefix}`);
  }

  const pagesDir = path.join(input.outputDir, 'pages');

  await mkdir(pagesDir, { recursive: true });

  const pages = [];

  for (const storagePath of storagePaths) {
    const pngBuffer = await downloadStorageObject({
      supabase: input.supabase,
      bucket: input.bucket,
      storagePath,
    });
    let image;

    try {
      image = await loadImage(pngBuffer);
    } catch {
      console.warn(`Skipped non-image object: ${storagePath}`);
      continue;
    }

    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    const pageNumber = pages.length + 1;
    const pngPath = path.join(
      pagesDir,
      `page-${String(pageNumber).padStart(3, '0')}.png`,
    );

    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0);
    await writeFile(pngPath, pngBuffer);

    pages.push({
      pageNumber,
      pngPath,
      pngStoragePath: storagePath,
      pngBytes: pngBuffer.length,
      widthPx: canvas.width,
      heightPx: canvas.height,
      widthPt: input.pageWidthPt || canvas.width,
      heightPt: input.pageHeightPt || canvas.height,
      rgbBuffer: canvasToRgbBuffer(canvas),
    });

    console.log(
      `Downloaded image ${pageNumber}: ${storagePath}, ${canvas.width}x${canvas.height}px, ${formatBytes(pngBuffer.length)}`,
    );
  }

  if (pages.length === 0) {
    throw new Error(
      `No decodable image files found under ${input.bucket}/${input.prefix}`,
    );
  }

  return pages;
}

function pdfNumber(value) {
  return Number(value.toFixed(4)).toString();
}

function createPdfObject(objectNumber, body) {
  const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(body, 'binary');

  return Buffer.concat([
    Buffer.from(`${objectNumber} 0 obj\n`, 'binary'),
    bodyBuffer,
    Buffer.from('\nendobj\n', 'binary'),
  ]);
}

function createPdfStreamObject(objectNumber, dictionary, stream) {
  return createPdfObject(
    objectNumber,
    Buffer.concat([
      Buffer.from(`${dictionary}\nstream\n`, 'binary'),
      stream,
      Buffer.from('\nendstream', 'binary'),
    ]),
  );
}

function buildPdfFromRenderedPages(pages) {
  const objects = [];
  const pageObjectNumbers = [];

  objects.push(createPdfObject(1, '<< /Type /Catalog /Pages 2 0 R >>'));

  for (const [index, page] of pages.entries()) {
    const pageObjectNumber = 3 + index * 3;
    const contentObjectNumber = pageObjectNumber + 1;
    const imageObjectNumber = pageObjectNumber + 2;
    const imageName = `Im${index + 1}`;
    const content = Buffer.from(
      `q\n${pdfNumber(page.widthPt)} 0 0 ${pdfNumber(page.heightPt)} 0 0 cm\n/${imageName} Do\nQ\n`,
      'binary',
    );
    const compressedImage = deflateSync(page.rgbBuffer, { level: 9 });

    pageObjectNumbers.push(pageObjectNumber);
    objects.push(
      createPdfObject(
        pageObjectNumber,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pdfNumber(
          page.widthPt,
        )} ${pdfNumber(
          page.heightPt,
        )}] /Resources << /XObject << /${imageName} ${imageObjectNumber} 0 R >> >> /Contents ${contentObjectNumber} 0 R >>`,
      ),
    );
    objects.push(
      createPdfStreamObject(
        contentObjectNumber,
        `<< /Length ${content.length} >>`,
        content,
      ),
    );
    objects.push(
      createPdfStreamObject(
        imageObjectNumber,
        `<< /Type /XObject /Subtype /Image /Width ${page.widthPx} /Height ${page.heightPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressedImage.length} >>`,
        compressedImage,
      ),
    );
  }

  objects.splice(
    1,
    0,
    createPdfObject(
      2,
      `<< /Type /Pages /Kids [${pageObjectNumbers
        .map((objectNumber) => `${objectNumber} 0 R`)
        .join(' ')}] /Count ${pages.length} >>`,
    ),
  );

  const header = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'binary');
  const chunks = [header];
  const offsets = [0];
  let byteOffset = header.length;

  for (const object of objects) {
    const match = object.toString('binary', 0, 20).match(/^(\d+) 0 obj/);

    if (!match?.[1]) {
      throw new Error('Unable to determine PDF object number.');
    }

    offsets[Number(match[1])] = byteOffset;
    chunks.push(object);
    byteOffset += object.length;
  }

  const xrefOffset = byteOffset;
  const objectCount = offsets.length;
  let xref = `xref\n0 ${objectCount}\n0000000000 65535 f \n`;

  for (let objectNumber = 1; objectNumber < objectCount; objectNumber += 1) {
    xref += `${String(offsets[objectNumber]).padStart(10, '0')} 00000 n \n`;
  }

  xref += `trailer\n<< /Size ${objectCount} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'binary'));

  return Buffer.concat(chunks);
}

async function maybeUploadResult(input) {
  if (!input.uploadPath) {
    return null;
  }

  const { error } = await input.supabase.storage
    .from(input.bucket)
    .upload(input.uploadPath, input.pdfBytes, {
      contentType: 'application/pdf',
      upsert: true,
    });

  if (error) {
    throw error;
  }

  return input.uploadPath;
}

async function main() {
  await loadLocalEnv();

  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const bucket = args.bucket || DEFAULT_BUCKET;
  const scale = parsePositiveNumber(args.scale, DEFAULT_SCALE);
  const pageWidthPt = parsePositiveNumber(args['page-width'], null);
  const pageHeightPt = parsePositiveNumber(args['page-height'], null);
  const supabase = createSupabaseAdmin();
  const mode = args['png-prefix'] ? 'png-prefix' : 'pdf';
  const resolvedSource =
    mode === 'pdf'
      ? await resolveStoragePath({
          supabase,
          storagePath: args.path,
          taskItemId: args['task-item-id'],
        })
      : {
          storagePath: args['png-prefix'].replace(/\/+$/, ''),
          sourceName: getStorageBasename(args['png-prefix'].replace(/\/+$/, '')),
        };
  const safeName = sanitizeName(
    resolvedSource.sourceName.replace(/\.pdf$/i, '') || 'supabase-pdf',
  );
  const outputDir = path.resolve(args.out || path.join(DEFAULT_OUTPUT_ROOT, safeName));
  const sourcePdfPath = path.join(outputDir, 'source.pdf');
  const rebuiltPdfPath = path.join(outputDir, 'rebuilt-from-png.pdf');
  const manifestPath = path.join(outputDir, 'manifest.json');

  await mkdir(outputDir, { recursive: true });

  let sourcePdfBytes = null;
  let pages;

  if (mode === 'png-prefix') {
    console.log(`Listing PNG files under ${bucket}/${resolvedSource.storagePath}`);
    pages = await downloadPngPrefixPages({
      supabase,
      bucket,
      prefix: resolvedSource.storagePath,
      outputDir,
      pageWidthPt,
      pageHeightPt,
    });
  } else {
    console.log(`Downloading ${bucket}/${resolvedSource.storagePath}`);
    sourcePdfBytes = await downloadStorageObject({
      supabase,
      bucket,
      storagePath: resolvedSource.storagePath,
    });

    await writeFile(sourcePdfPath, sourcePdfBytes);
    console.log(
      `Saved source PDF: ${sourcePdfPath} (${formatBytes(sourcePdfBytes.length)})`,
    );

    pages = await renderPdfToPngPages({
      pdfBytes: sourcePdfBytes,
      scale,
      outputDir,
    });
  }

  if (pages.length === 0) {
    throw new Error('No pages rendered from PDF.');
  }

  const rebuiltPdfBytes = buildPdfFromRenderedPages(pages);

  await writeFile(rebuiltPdfPath, rebuiltPdfBytes);
  console.log(
    `Saved rebuilt PDF: ${rebuiltPdfPath} (${formatBytes(rebuiltPdfBytes.length)})`,
  );

  const uploadedPath = await maybeUploadResult({
    supabase,
    bucket,
    uploadPath: args['upload-path'],
    pdfBytes: rebuiltPdfBytes,
  });

  if (uploadedPath) {
    console.log(`Uploaded rebuilt PDF: ${bucket}/${uploadedPath}`);
  }

  const manifest = {
    mode,
    bucket,
    sourceStoragePath: resolvedSource.storagePath,
    sourceName: resolvedSource.sourceName,
    scale: mode === 'pdf' ? scale : null,
    pageWidthPt: mode === 'png-prefix' ? pageWidthPt : null,
    pageHeightPt: mode === 'png-prefix' ? pageHeightPt : null,
    sourcePdfPath: sourcePdfBytes ? sourcePdfPath : null,
    rebuiltPdfPath,
    uploadedPath,
    pages: pages.map((page) => ({
      pageNumber: page.pageNumber,
      pngPath: page.pngPath,
      pngStoragePath: page.pngStoragePath || null,
      pngBytes: page.pngBytes,
      widthPx: page.widthPx,
      heightPx: page.heightPx,
      widthPt: page.widthPt,
      heightPt: page.heightPt,
    })),
  };

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Saved manifest: ${manifestPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
