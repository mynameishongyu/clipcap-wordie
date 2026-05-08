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
  imageDataUrl: string;
}

const DEFAULT_PDF_RENDER_SCALE = 4.0;
const DEFAULT_PDF_RENDER_IMAGE_FORMAT = 'image/png';
const DEFAULT_PDF_RENDER_JPEG_QUALITY = 0.92;
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
  const rawValue = process.env.NEXT_PUBLIC_PDF_RENDER_IMAGE_FORMAT?.trim().toLowerCase();

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

  const totalTextLength = pages.reduce((sum, page) => sum + page.text.length, 0);
  const lowTextPageCount = pages.filter((page) => page.text.length <= 10).length;
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

export async function renderPdfPagesForVision(
  file: File,
  pageNumbers: number[],
): Promise<PdfVisionPageInput[]> {
  const pdf = await loadPdfDocument(file);
  const results: PdfVisionPageInput[] = [];
  const { scale, imageFormat, imageQuality } = getPdfRenderConfig();

  for (const pageNumber of pageNumbers) {
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

    results.push({
      pageNumber,
      imageDataUrl:
        imageFormat === 'image/png'
          ? canvas.toDataURL(imageFormat)
          : canvas.toDataURL(imageFormat, imageQuality),
    });
  }

  return results;
}
