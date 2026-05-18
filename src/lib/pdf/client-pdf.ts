'use client';

export interface ParsedPdfPage {
  pageNumber: number;
  text: string;
}

export interface ParsedPdfDocument {
  fileName: string;
  pages: ParsedPdfPage[];
  fullText: string;
  totalTextLength: number;
  likelyScanned: boolean;
}

export interface PdfVisionPageInput {
  pageNumber: number;
  imageBlob?: Blob;
  imageDataUrl?: string;
  crop?: PdfVisionPageCrop;
  rotationApplied?: PdfVisionPageRotation;
}

export interface PdfVisionPageCrop {
  left: number;
  top: number;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  contentRatio: number;
}

export type PdfVisionPageRotation = -90 | 0 | 90 | 180;

const DEFAULT_PDF_RENDER_SCALE = 6.0;
const DEFAULT_PDF_RENDER_IMAGE_FORMAT = 'image/png';
const DEFAULT_PDF_RENDER_JPEG_QUALITY = 0.92;
const DEFAULT_PDF_VISION_RENDER_CONCURRENCY = 3;
const MAX_PDF_VISION_RENDER_CONCURRENCY = 8;
const DEFAULT_PDF_STORAGE_UPLOAD_CONCURRENCY = 3;
const MAX_PDF_STORAGE_UPLOAD_CONCURRENCY = 8;
const DEFAULT_PDF_AUTO_ROTATE_PAGES = true;
const PDF_AUTO_CROP_WHITE_MARGIN = true;
const PDF_CROP_WHITE_THRESHOLD = 245;
const PDF_CROP_CONTENT_DIFFERENCE_THRESHOLD = 18;
const PDF_CROP_PADDING_RATIO = 0.025;
const PDF_CROP_MIN_CONTENT_RATIO = 0.02;
const PDF_ROTATION_ANALYSIS_MAX_DIMENSION = 420;
const PDF_ROTATION_SIDEWAYS_ASPECT_RATIO = 1.12;
const PDF_ROTATION_PROJECTION_RATIO = 1.18;
const PDF_ROTATION_SIDE_STRIP_RATIO = 0.16;
const SUPPORTED_PDF_RENDER_IMAGE_FORMATS = [
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;

type PdfRenderImageFormat = (typeof SUPPORTED_PDF_RENDER_IMAGE_FORMATS)[number];

const PDFJS_VERSION = '5.6.205';
const PDFJS_CMAP_URL = `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/cmaps/`;
const PDFJS_STANDARD_FONT_DATA_URL = `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/standard_fonts/`;
const PDFJS_WORKER_URL = `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;
let pdfJsPromise: Promise<typeof import('pdfjs-dist')> | null = null;

function normalizePdfText(rawText: string) {
  return rawText.replace(/\s+/g, ' ').trim();
}

function getPdfRenderScale() {
  const parsedValue = Number(process.env.NEXT_PUBLIC_PDF_RENDER_SCALE);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return DEFAULT_PDF_RENDER_SCALE;
  }

  return parsedValue;
}

function getPdfRenderImageFormat(): PdfRenderImageFormat {
  const rawValue =
    process.env.NEXT_PUBLIC_PDF_RENDER_IMAGE_FORMAT?.trim().toLowerCase();

  if (
    SUPPORTED_PDF_RENDER_IMAGE_FORMATS.includes(
      rawValue as PdfRenderImageFormat,
    )
  ) {
    return rawValue as PdfRenderImageFormat;
  }

  return DEFAULT_PDF_RENDER_IMAGE_FORMAT;
}

function getPdfRenderJpegQuality() {
  const parsedValue = Number(process.env.NEXT_PUBLIC_PDF_RENDER_JPEG_QUALITY);

  if (!Number.isFinite(parsedValue)) {
    return DEFAULT_PDF_RENDER_JPEG_QUALITY;
  }

  return Math.min(1, Math.max(0.1, parsedValue));
}

function getPdfAutoRotatePages() {
  const rawValue = process.env.NEXT_PUBLIC_PDF_AUTO_ROTATE_PAGES;

  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    return DEFAULT_PDF_AUTO_ROTATE_PAGES;
  }

  const normalizedValue = rawValue.trim().toLowerCase();

  if (['0', 'false', 'off', 'no'].includes(normalizedValue)) {
    return false;
  }

  if (['1', 'true', 'on', 'yes'].includes(normalizedValue)) {
    return true;
  }

  return DEFAULT_PDF_AUTO_ROTATE_PAGES;
}

export function getPdfRenderConfig() {
  return {
    scale: getPdfRenderScale(),
    imageFormat: getPdfRenderImageFormat(),
    imageQuality: getPdfRenderJpegQuality(),
    autoRotatePages: getPdfAutoRotatePages(),
  };
}

export function getPdfVisionRenderConcurrency() {
  const parsedValue = Number(
    process.env.NEXT_PUBLIC_PDF_VISION_RENDER_CONCURRENCY,
  );

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return DEFAULT_PDF_VISION_RENDER_CONCURRENCY;
  }

  return Math.min(
    MAX_PDF_VISION_RENDER_CONCURRENCY,
    Math.max(1, Math.floor(parsedValue)),
  );
}

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

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
) {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        const currentItem = items[currentIndex];

        if (!currentItem) {
          continue;
        }

        await worker(currentItem, currentIndex);
      }
    }),
  );
}

async function loadPdfJs() {
  if (typeof window === 'undefined') {
    throw new Error('PDF parsing is only available in the browser.');
  }

  if (!pdfJsPromise) {
    pdfJsPromise = import('pdfjs-dist').then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      return pdfjs;
    });
  }

  return pdfJsPromise;
}

async function loadPdfDocument(file: File) {
  const pdfjs = await loadPdfJs();
  const data = new Uint8Array(await file.arrayBuffer());

  return pdfjs.getDocument({
    data,
    cMapUrl: PDFJS_CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: PDFJS_STANDARD_FONT_DATA_URL,
  }).promise;
}

export async function parsePdf(file: File): Promise<ParsedPdfDocument> {
  const pdf = await loadPdfDocument(file);
  const pages: ParsedPdfPage[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const text = normalizePdfText(
      textContent.items
        .map((item) => ('str' in item ? item.str : ''))
        .filter(Boolean)
        .join(' '),
    );

    pages.push({
      pageNumber,
      text,
    });
  }

  const totalTextLength = pages.reduce(
    (sum, page) => sum + page.text.length,
    0,
  );
  const lowTextPageCount = pages.filter(
    (page) => page.text.length <= 10,
  ).length;
  const likelyScanned =
    totalTextLength <= Math.max(20, pdf.numPages * 10) ||
    lowTextPageCount >= Math.ceil(pdf.numPages * 0.8);

  return {
    fileName: file.name,
    pages,
    fullText: pages.map((page) => page.text).join('\n'),
    totalTextLength,
    likelyScanned,
  };
}

export function pickVisionPageNumbers(pdf: ParsedPdfDocument) {
  return pdf.pages.map((page) => page.pageNumber);
}

function isLikelyWhitePixel(data: Uint8ClampedArray, index: number) {
  const red = data[index] ?? 0;
  const green = data[index + 1] ?? 0;
  const blue = data[index + 2] ?? 0;
  const alpha = data[index + 3] ?? 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);

  return (
    alpha < 12 ||
    (red >= PDF_CROP_WHITE_THRESHOLD &&
      green >= PDF_CROP_WHITE_THRESHOLD &&
      blue >= PDF_CROP_WHITE_THRESHOLD &&
      max - min <= PDF_CROP_CONTENT_DIFFERENCE_THRESHOLD)
  );
}

function findCanvasContentBounds(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d');

  if (!context || !PDF_AUTO_CROP_WHITE_MARGIN) {
    return null;
  }

  const { width, height } = canvas;
  const imageData = context.getImageData(0, 0, width, height);
  const { data } = imageData;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let contentPixels = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;

      if (isLikelyWhitePixel(data, index)) {
        continue;
      }

      contentPixels += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  const contentRatio = contentPixels / (width * height);

  if (maxX < minX || maxY < minY || contentRatio < PDF_CROP_MIN_CONTENT_RATIO) {
    return null;
  }

  const padding = Math.round(
    Math.min(width, height) * Math.max(0, PDF_CROP_PADDING_RATIO),
  );
  const left = Math.max(0, minX - padding);
  const top = Math.max(0, minY - padding);
  const right = Math.min(width - 1, maxX + padding);
  const bottom = Math.min(height - 1, maxY + padding);

  return {
    left,
    top,
    width: right - left + 1,
    height: bottom - top + 1,
    originalWidth: width,
    originalHeight: height,
    contentRatio,
  };
}

function cropCanvas(canvas: HTMLCanvasElement, crop: PdfVisionPageCrop) {
  const croppedCanvas = document.createElement('canvas');
  const context = croppedCanvas.getContext('2d');

  if (!context) {
    throw new Error('无法创建裁剪后的 PDF 页图画布。');
  }

  croppedCanvas.width = crop.width;
  croppedCanvas.height = crop.height;
  context.drawImage(
    canvas,
    crop.left,
    crop.top,
    crop.width,
    crop.height,
    0,
    0,
    crop.width,
    crop.height,
  );

  return croppedCanvas;
}

function calculateStandardDeviation(values: number[]) {
  if (values.length === 0) {
    return 0;
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    values.length;

  return Math.sqrt(variance);
}

function getEdgeInkDensity(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  edge: 'left' | 'right',
) {
  const stripWidth = Math.max(
    1,
    Math.round(width * PDF_ROTATION_SIDE_STRIP_RATIO),
  );
  const startX = edge === 'left' ? 0 : Math.max(0, width - stripWidth);
  let inkPixels = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = startX; x < startX + stripWidth; x += 1) {
      const index = (y * width + x) * 4;

      if (!isLikelyWhitePixel(data, index)) {
        inkPixels += 1;
      }
    }
  }

  return inkPixels / Math.max(1, stripWidth * height);
}

function analyzeCanvasSidewaysRotation(
  canvas: HTMLCanvasElement,
  contentBounds: PdfVisionPageCrop | null,
): PdfVisionPageRotation {
  if (!getPdfAutoRotatePages() || !contentBounds) {
    return 0;
  }

  if (
    contentBounds.height / Math.max(1, contentBounds.width) <
    PDF_ROTATION_SIDEWAYS_ASPECT_RATIO
  ) {
    return 0;
  }

  const analysisScale = Math.min(
    1,
    PDF_ROTATION_ANALYSIS_MAX_DIMENSION /
      Math.max(contentBounds.width, contentBounds.height),
  );
  const analysisWidth = Math.max(1, Math.round(contentBounds.width * analysisScale));
  const analysisHeight = Math.max(
    1,
    Math.round(contentBounds.height * analysisScale),
  );
  const analysisCanvas = document.createElement('canvas');
  const analysisContext = analysisCanvas.getContext('2d', {
    willReadFrequently: true,
  });

  if (!analysisContext) {
    return 0;
  }

  analysisCanvas.width = analysisWidth;
  analysisCanvas.height = analysisHeight;
  analysisContext.drawImage(
    canvas,
    contentBounds.left,
    contentBounds.top,
    contentBounds.width,
    contentBounds.height,
    0,
    0,
    analysisWidth,
    analysisHeight,
  );

  const imageData = analysisContext.getImageData(
    0,
    0,
    analysisWidth,
    analysisHeight,
  );
  const rowInkCounts = Array.from({ length: analysisHeight }, () => 0);
  const columnInkCounts = Array.from({ length: analysisWidth }, () => 0);
  const { data } = imageData;

  for (let y = 0; y < analysisHeight; y += 1) {
    for (let x = 0; x < analysisWidth; x += 1) {
      const index = (y * analysisWidth + x) * 4;

      if (isLikelyWhitePixel(data, index)) {
        continue;
      }

      rowInkCounts[y] += 1;
      columnInkCounts[x] += 1;
    }
  }

  const rowProjectionScore = calculateStandardDeviation(
    rowInkCounts.map((count) => count / analysisWidth),
  );
  const columnProjectionScore = calculateStandardDeviation(
    columnInkCounts.map((count) => count / analysisHeight),
  );

  if (
    columnProjectionScore <
    rowProjectionScore * PDF_ROTATION_PROJECTION_RATIO
  ) {
    return 0;
  }

  const leftDensity = getEdgeInkDensity(
    data,
    analysisWidth,
    analysisHeight,
    'left',
  );
  const rightDensity = getEdgeInkDensity(
    data,
    analysisWidth,
    analysisHeight,
    'right',
  );

  return leftDensity >= rightDensity ? 90 : -90;
}

function rotateCanvas(
  canvas: HTMLCanvasElement,
  rotation: PdfVisionPageRotation,
) {
  if (rotation === 0) {
    return canvas;
  }

  const rotatedCanvas = document.createElement('canvas');
  const context = rotatedCanvas.getContext('2d');

  if (!context) {
    throw new Error('Failed to create rotated PDF page canvas.');
  }

  if (rotation === 90 || rotation === -90) {
    rotatedCanvas.width = canvas.height;
    rotatedCanvas.height = canvas.width;
  } else {
    rotatedCanvas.width = canvas.width;
    rotatedCanvas.height = canvas.height;
  }

  if (rotation === 90) {
    context.translate(rotatedCanvas.width, 0);
    context.rotate(Math.PI / 2);
  } else if (rotation === -90) {
    context.translate(0, rotatedCanvas.height);
    context.rotate(-Math.PI / 2);
  } else {
    context.translate(rotatedCanvas.width, rotatedCanvas.height);
    context.rotate(Math.PI);
  }

  context.drawImage(canvas, 0, 0);

  return rotatedCanvas;
}

function createPdfVisionCanvas(canvas: HTMLCanvasElement) {
  const initialCrop = findCanvasContentBounds(canvas);
  const rotationApplied = analyzeCanvasSidewaysRotation(canvas, initialCrop);
  const orientedCanvas = rotateCanvas(canvas, rotationApplied);
  const crop =
    rotationApplied === 0
      ? initialCrop
      : findCanvasContentBounds(orientedCanvas);

  if (!crop) {
    return {
      canvas: orientedCanvas,
      crop: undefined,
      rotationApplied,
    };
  }

  return {
    canvas: cropCanvas(orientedCanvas, crop),
    crop,
    rotationApplied,
  };
}

function canvasToImageBlob(
  canvas: HTMLCanvasElement,
  imageFormat: PdfRenderImageFormat,
  imageQuality: number,
) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('Failed to export PDF page canvas as an image blob.'));
          return;
        }

        resolve(blob);
      },
      imageFormat,
      imageFormat === 'image/png' ? undefined : imageQuality,
    );
  });
}

export async function renderPdfPagesForVision(
  file: File,
  pageNumbers: number[],
  options?: {
    concurrency?: number;
    onPageRendered?: (input: {
      pageNumber: number;
      index: number;
      total: number;
    }) => void;
  },
): Promise<PdfVisionPageInput[]> {
  const pdf = await loadPdfDocument(file);
  const results: Array<PdfVisionPageInput | undefined> = Array.from({
    length: pageNumbers.length,
  });
  const { scale, imageFormat, imageQuality } = getPdfRenderConfig();
  const configuredRenderConcurrency = getPdfVisionRenderConcurrency();
  const renderConcurrency = Math.min(
    configuredRenderConcurrency,
    Math.max(1, Math.floor(options?.concurrency ?? configuredRenderConcurrency)),
  );
  let completedPageCount = 0;

  await runWithConcurrency(pageNumbers, renderConcurrency, async (pageNumber, index) => {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');

    if (!context) {
      throw new Error('无法创建 PDF 视觉识别画布。');
    }

    canvas.width = viewport.width;
    canvas.height = viewport.height;

    await page.render({
      canvas,
      canvasContext: context,
      viewport,
    }).promise;

    const visionCanvas = createPdfVisionCanvas(canvas);
    const imageBlob = await canvasToImageBlob(
      visionCanvas.canvas,
      imageFormat,
      imageQuality,
    );

    results[index] = {
      pageNumber,
      imageBlob,
      ...(visionCanvas.crop ? { crop: visionCanvas.crop } : {}),
      ...(visionCanvas.rotationApplied
        ? { rotationApplied: visionCanvas.rotationApplied }
        : {}),
    };
    if (visionCanvas.rotationApplied) {
      console.info('[PDF Render][AutoRotate] Rotated PDF page image.', {
        fileName: file.name,
        pageNumber,
        rotationApplied: visionCanvas.rotationApplied,
        crop: visionCanvas.crop ?? null,
      });
    }
    completedPageCount += 1;
    options?.onPageRendered?.({
      pageNumber,
      index: completedPageCount,
      total: pageNumbers.length,
    });
  });

  return results.filter((result): result is PdfVisionPageInput => Boolean(result));
}
