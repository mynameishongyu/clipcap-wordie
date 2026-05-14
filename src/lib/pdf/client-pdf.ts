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

const DEFAULT_PDF_RENDER_SCALE = 6.0;
const DEFAULT_PDF_RENDER_IMAGE_FORMAT = 'image/png';
const DEFAULT_PDF_RENDER_JPEG_QUALITY = 0.92;
const DEFAULT_PDF_VISION_UPLOAD_CONCURRENCY = 3;
const MAX_PDF_VISION_UPLOAD_CONCURRENCY = 8;
const PDF_AUTO_CROP_WHITE_MARGIN = true;
const PDF_CROP_WHITE_THRESHOLD = 245;
const PDF_CROP_CONTENT_DIFFERENCE_THRESHOLD = 18;
const PDF_CROP_PADDING_RATIO = 0.025;
const PDF_CROP_MIN_CONTENT_RATIO = 0.02;
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

export function getPdfRenderConfig() {
  return {
    scale: getPdfRenderScale(),
    imageFormat: getPdfRenderImageFormat(),
    imageQuality: getPdfRenderJpegQuality(),
  };
}

export function getPdfVisionUploadConcurrency() {
  const parsedValue = Number(
    process.env.NEXT_PUBLIC_PDF_VISION_UPLOAD_CONCURRENCY,
  );

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return DEFAULT_PDF_VISION_UPLOAD_CONCURRENCY;
  }

  return Math.min(
    MAX_PDF_VISION_UPLOAD_CONCURRENCY,
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

function createPdfVisionCanvas(canvas: HTMLCanvasElement) {
  const crop = findCanvasContentBounds(canvas);

  if (!crop) {
    return {
      canvas,
      crop: undefined,
    };
  }

  return {
    canvas: cropCanvas(canvas, crop),
    crop,
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
  const renderConcurrency = Math.min(
    getPdfVisionUploadConcurrency(),
    Math.max(1, Math.floor(options?.concurrency ?? 1)),
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
    };
    completedPageCount += 1;
    options?.onPageRendered?.({
      pageNumber,
      index: completedPageCount,
      total: pageNumbers.length,
    });
  });

  return results.filter((result): result is PdfVisionPageInput => Boolean(result));
}
