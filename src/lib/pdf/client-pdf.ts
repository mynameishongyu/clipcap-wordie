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
const DEFAULT_PDF_RENDER_IMAGE_FORMAT = 'image/jpeg';
const DEFAULT_PDF_RENDER_JPEG_QUALITY = 0.92;
const DEFAULT_PDF_RENDER_JPEG_MAX_LONG_EDGE = 3200;
const DEFAULT_PDF_RENDER_JPEG_BACKGROUND_CLEANUP = true;
const DEFAULT_PDF_RENDER_JPEG_GRAYSCALE = false;
const DEFAULT_PDF_RENDER_JPEG_BACKGROUND_WHITE_THRESHOLD = 246;
const DEFAULT_PDF_RENDER_JPEG_BACKGROUND_INK_THRESHOLD = 190;
const DEFAULT_PDF_RENDER_JPEG_CONTRAST = 1.04;
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

type PdfRenderConfig = ReturnType<typeof getPdfRenderConfig>;

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
  const normalizedValue =
    rawValue === 'jpeg' ||
    rawValue === 'jpg' ||
    rawValue === 'jepg' ||
    rawValue === 'image/jpg' ||
    rawValue === 'image/jepg'
      ? 'image/jpeg'
      : rawValue;

  if (
    SUPPORTED_PDF_RENDER_IMAGE_FORMATS.includes(
      normalizedValue as PdfRenderImageFormat,
    )
  ) {
    return normalizedValue as PdfRenderImageFormat;
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

function getBooleanEnvValue(rawValue: string | undefined, fallback: boolean) {
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    return fallback;
  }

  const normalizedValue = rawValue.trim().toLowerCase();

  if (['0', 'false', 'off', 'no'].includes(normalizedValue)) {
    return false;
  }

  if (['1', 'true', 'on', 'yes'].includes(normalizedValue)) {
    return true;
  }

  return fallback;
}

function getPdfAutoRotatePages() {
  return getBooleanEnvValue(
    process.env.NEXT_PUBLIC_PDF_AUTO_ROTATE_PAGES,
    DEFAULT_PDF_AUTO_ROTATE_PAGES,
  );
}

function getPdfRenderJpegMaxLongEdge() {
  const parsedValue = Number(
    process.env.NEXT_PUBLIC_PDF_RENDER_JPEG_MAX_LONG_EDGE,
  );

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return DEFAULT_PDF_RENDER_JPEG_MAX_LONG_EDGE;
  }

  return Math.min(8000, Math.max(0, Math.floor(parsedValue)));
}

function getPdfRenderJpegBackgroundCleanup() {
  return getBooleanEnvValue(
    process.env.NEXT_PUBLIC_PDF_RENDER_JPEG_BACKGROUND_CLEANUP,
    DEFAULT_PDF_RENDER_JPEG_BACKGROUND_CLEANUP,
  );
}

function getPdfRenderJpegGrayscale() {
  return getBooleanEnvValue(
    process.env.NEXT_PUBLIC_PDF_RENDER_JPEG_GRAYSCALE,
    DEFAULT_PDF_RENDER_JPEG_GRAYSCALE,
  );
}

function getPdfRenderJpegBackgroundWhiteThreshold() {
  const parsedValue = Number(
    process.env.NEXT_PUBLIC_PDF_RENDER_JPEG_BACKGROUND_WHITE_THRESHOLD,
  );

  if (!Number.isFinite(parsedValue)) {
    return DEFAULT_PDF_RENDER_JPEG_BACKGROUND_WHITE_THRESHOLD;
  }

  return Math.min(255, Math.max(0, parsedValue));
}

function getPdfRenderJpegBackgroundInkThreshold() {
  const parsedValue = Number(
    process.env.NEXT_PUBLIC_PDF_RENDER_JPEG_BACKGROUND_INK_THRESHOLD,
  );

  if (!Number.isFinite(parsedValue)) {
    return DEFAULT_PDF_RENDER_JPEG_BACKGROUND_INK_THRESHOLD;
  }

  return Math.min(255, Math.max(0, parsedValue));
}

function getPdfRenderJpegContrast() {
  const parsedValue = Number(process.env.NEXT_PUBLIC_PDF_RENDER_JPEG_CONTRAST);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return DEFAULT_PDF_RENDER_JPEG_CONTRAST;
  }

  return Math.min(3, Math.max(0.1, parsedValue));
}

export function getPdfRenderConfig() {
  return {
    scale: getPdfRenderScale(),
    imageFormat: getPdfRenderImageFormat(),
    imageQuality: getPdfRenderJpegQuality(),
    autoRotatePages: getPdfAutoRotatePages(),
    jpegMaxLongEdge: getPdfRenderJpegMaxLongEdge(),
    jpegBackgroundCleanup: getPdfRenderJpegBackgroundCleanup(),
    jpegGrayscale: getPdfRenderJpegGrayscale(),
    jpegBackgroundWhiteThreshold: getPdfRenderJpegBackgroundWhiteThreshold(),
    jpegBackgroundInkThreshold: getPdfRenderJpegBackgroundInkThreshold(),
    jpegContrast: getPdfRenderJpegContrast(),
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
  const context = canvas.getContext('2d', { willReadFrequently: true });

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

function resizeCanvasToMaxLongEdge(
  canvas: HTMLCanvasElement,
  maxLongEdge: number,
) {
  if (!Number.isFinite(maxLongEdge) || maxLongEdge <= 0) {
    return canvas;
  }

  const longEdge = Math.max(canvas.width, canvas.height);

  if (longEdge <= maxLongEdge) {
    return canvas;
  }

  const resizeScale = maxLongEdge / longEdge;
  const resizedCanvas = document.createElement('canvas');
  const context = resizedCanvas.getContext('2d');

  if (!context) {
    throw new Error('Failed to create resized PDF page canvas.');
  }

  resizedCanvas.width = Math.max(1, Math.round(canvas.width * resizeScale));
  resizedCanvas.height = Math.max(1, Math.round(canvas.height * resizeScale));
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(
    canvas,
    0,
    0,
    canvas.width,
    canvas.height,
    0,
    0,
    resizedCanvas.width,
    resizedCanvas.height,
  );

  return resizedCanvas;
}

function enhanceCanvasForJpeg(
  canvas: HTMLCanvasElement,
  config: PdfRenderConfig,
) {
  if (
    !config.jpegBackgroundCleanup &&
    !config.jpegGrayscale &&
    config.jpegContrast === 1
  ) {
    return;
  }

  const context = canvas.getContext('2d', { willReadFrequently: true });

  if (!context) {
    return;
  }

  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = imageData;

  for (let index = 0; index < data.length; index += 4) {
    const red = data[index] ?? 255;
    const green = data[index + 1] ?? 255;
    const blue = data[index + 2] ?? 255;
    const gray = 0.299 * red + 0.587 * green + 0.114 * blue;

    if (
      config.jpegBackgroundCleanup &&
      gray >= config.jpegBackgroundWhiteThreshold
    ) {
      data[index] = 255;
      data[index + 1] = 255;
      data[index + 2] = 255;
      continue;
    }

    const contrastedGray = Math.max(
      0,
      Math.min(255, (gray - 128) * config.jpegContrast + 128),
    );

    if (config.jpegGrayscale) {
      const nextValue =
        config.jpegBackgroundCleanup &&
        contrastedGray <= config.jpegBackgroundInkThreshold
          ? Math.max(0, contrastedGray - 6)
          : contrastedGray;

      data[index] = nextValue;
      data[index + 1] = nextValue;
      data[index + 2] = nextValue;
      continue;
    }

    data[index] = Math.max(
      0,
      Math.min(255, (red - 128) * config.jpegContrast + 128),
    );
    data[index + 1] = Math.max(
      0,
      Math.min(255, (green - 128) * config.jpegContrast + 128),
    );
    data[index + 2] = Math.max(
      0,
      Math.min(255, (blue - 128) * config.jpegContrast + 128),
    );
  }

  context.putImageData(imageData, 0, 0);
}

export function createOptimizedPdfJpegCanvas(
  canvas: HTMLCanvasElement,
  config: PdfRenderConfig = getPdfRenderConfig(),
) {
  const optimizedCanvas = resizeCanvasToMaxLongEdge(
    canvas,
    config.jpegMaxLongEdge,
  );

  enhanceCanvasForJpeg(optimizedCanvas, config);

  return optimizedCanvas;
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
  config: PdfRenderConfig,
): PdfVisionPageRotation {
  if (!config.autoRotatePages || !contentBounds) {
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

function createPdfVisionCanvas(
  canvas: HTMLCanvasElement,
  config: PdfRenderConfig,
) {
  const initialCrop = findCanvasContentBounds(canvas);
  const rotationApplied = analyzeCanvasSidewaysRotation(
    canvas,
    initialCrop,
    config,
  );
  const orientedCanvas = rotateCanvas(canvas, rotationApplied);
  const crop =
    rotationApplied === 0
      ? initialCrop
      : findCanvasContentBounds(orientedCanvas);
  const croppedCanvas = crop ? cropCanvas(orientedCanvas, crop) : orientedCanvas;
  const optimizedCanvas =
    config.imageFormat === 'image/jpeg'
      ? resizeCanvasToMaxLongEdge(croppedCanvas, config.jpegMaxLongEdge)
      : croppedCanvas;

  if (config.imageFormat === 'image/jpeg') {
    enhanceCanvasForJpeg(optimizedCanvas, config);
  }

  return {
    canvas: optimizedCanvas,
    crop: crop ?? undefined,
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
  const renderConfig = getPdfRenderConfig();
  const { scale, imageFormat, imageQuality } = renderConfig;
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

    const visionCanvas = createPdfVisionCanvas(canvas, renderConfig);
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
