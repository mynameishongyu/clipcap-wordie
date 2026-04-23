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

const PDFJS_VERSION = '5.6.205';
const PDFJS_CMAP_URL = `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/cmaps/`;
const PDFJS_STANDARD_FONT_DATA_URL = `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/standard_fonts/`;
const PDFJS_WORKER_URL = `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;
let pdfJsPromise: Promise<typeof import('pdfjs-dist')> | null = null;

function normalizePdfText(rawText: string) {
  return rawText.replace(/\s+/g, ' ').trim();
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

  for (const pageNumber of pageNumbers) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
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
      imageDataUrl: canvas.toDataURL('image/jpeg', 0.78),
    });
  }

  return results;
}
