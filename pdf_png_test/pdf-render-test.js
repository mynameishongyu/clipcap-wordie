const PDF_RENDER_SCALE = 6.0;
const PDF_RENDER_IMAGE_FORMAT = 'image/png';
const PDF_RENDER_JPEG_QUALITY = 0.92;
const PDF_RENDER_ENHANCE_GRAYSCALE = false;
const PDF_RENDER_ENHANCE_CONTRAST = 1;
const PDF_RENDER_ENHANCE_THRESHOLD = 0;
const PDF_PREVIEW_BASE_WIDTH = 760;
const PDF_PREVIEW_DEFAULT_ZOOM = 1;
const PDF_PREVIEW_MIN_ZOOM = 0.2;
const PDF_PREVIEW_MAX_ZOOM = 3;
const PDF_PREVIEW_ZOOM_STEP = 0.1;
const PDF_PREVIEW_MAX_DEVICE_PIXEL_RATIO = 2;
const PDF_PREVIEW_IMAGE_SMOOTHING_QUALITY = 'high';
const PDF_PREVIEW_SHARPEN_STRENGTH = 0.25;
const PDF_AUTO_CROP_WHITE_MARGIN = true;
const PDF_CROP_WHITE_THRESHOLD = 245;
const PDF_CROP_CONTENT_DIFFERENCE_THRESHOLD = 18;
const PDF_CROP_PADDING_RATIO = 0.025;
const PDF_CROP_MIN_CONTENT_RATIO = 0.02;
const SUPPORTED_PDF_RENDER_IMAGE_FORMATS = [
  'image/png',
  'image/jpeg',
  'image/webp',
];

const PDFJS_VERSION = '5.6.205';
const PDFJS_CMAP_URL = `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/cmaps/`;
const PDFJS_STANDARD_FONT_DATA_URL = `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/standard_fonts/`;
const PDFJS_WORKER_URL = `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;

let pdfJsPromise = null;

function getPdfRenderScale() {
  const parsedValue = Number(PDF_RENDER_SCALE);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return 4;
  }

  return parsedValue;
}

function getPdfRenderImageFormat() {
  const rawValue = String(PDF_RENDER_IMAGE_FORMAT)
    .trim()
    .toLowerCase();

  if (SUPPORTED_PDF_RENDER_IMAGE_FORMATS.includes(rawValue)) {
    return rawValue;
  }

  return 'image/png';
}

function getPdfRenderJpegQuality() {
  const parsedValue = Number(PDF_RENDER_JPEG_QUALITY);

  if (!Number.isFinite(parsedValue)) {
    return 0.92;
  }

  return Math.min(1, Math.max(0.1, parsedValue));
}

function getPdfRenderConfig() {
  return {
    scale: getPdfRenderScale(),
    imageFormat: getPdfRenderImageFormat(),
    imageQuality: getPdfRenderJpegQuality(),
    enhanceGrayscale: PDF_RENDER_ENHANCE_GRAYSCALE,
    enhanceContrast: getEnhanceContrast(),
    enhanceThreshold: getEnhanceThreshold(),
  };
}

function getEnhanceContrast() {
  const parsedValue = Number(PDF_RENDER_ENHANCE_CONTRAST);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return 1;
  }

  return parsedValue;
}

function getEnhanceThreshold() {
  const parsedValue = Number(PDF_RENDER_ENHANCE_THRESHOLD);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return 0;
  }

  return Math.min(255, Math.max(0, parsedValue));
}

function enhanceCanvas(canvas, config) {
  if (
    !config.enhanceGrayscale &&
    config.enhanceContrast === 1 &&
    config.enhanceThreshold <= 0
  ) {
    return;
  }

  const context = canvas.getContext('2d');
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = imageData;

  for (let index = 0; index < data.length; index += 4) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const gray = 0.299 * red + 0.587 * green + 0.114 * blue;
    const baseValue = config.enhanceGrayscale ? gray : (red + green + blue) / 3;
    const contrasted = Math.max(
      0,
      Math.min(255, (baseValue - 128) * config.enhanceContrast + 128),
    );
    const nextValue =
      config.enhanceThreshold > 0
        ? contrasted >= config.enhanceThreshold
          ? 255
          : 0
        : contrasted;

    if (config.enhanceGrayscale || config.enhanceThreshold > 0) {
      data[index] = nextValue;
      data[index + 1] = nextValue;
      data[index + 2] = nextValue;
      continue;
    }

    data[index] = Math.max(
      0,
      Math.min(255, (red - 128) * config.enhanceContrast + 128),
    );
    data[index + 1] = Math.max(
      0,
      Math.min(255, (green - 128) * config.enhanceContrast + 128),
    );
    data[index + 2] = Math.max(
      0,
      Math.min(255, (blue - 128) * config.enhanceContrast + 128),
    );
  }

  context.putImageData(imageData, 0, 0);
}

async function loadPdfJs() {
  if (typeof window === 'undefined') {
    throw new Error('PDF parsing is only available in the browser.');
  }

  if (!pdfJsPromise) {
    pdfJsPromise = import(
      `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/build/pdf.mjs`
    ).then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      return pdfjs;
    });
  }

  return pdfJsPromise;
}

async function loadPdfDocument(file) {
  const pdfjs = await loadPdfJs();
  const data = new Uint8Array(await file.arrayBuffer());

  return pdfjs.getDocument({
    data,
    cMapUrl: PDFJS_CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: PDFJS_STANDARD_FONT_DATA_URL,
  }).promise;
}

async function renderPdfPagesForVision(file, pageNumbers) {
  const pdf = await loadPdfDocument(file);
  const results = [];
  const config = getPdfRenderConfig();
  const { scale, imageFormat, imageQuality } = config;

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

    enhanceCanvas(canvas, config);

    results.push({
      pageNumber,
      canvas,
      imageFormat,
      imageDataUrl:
        imageFormat === 'image/png'
          ? canvas.toDataURL(imageFormat)
          : canvas.toDataURL(imageFormat, imageQuality),
    });
  }

  return results;
}

function setStatus(message) {
  document.querySelector('#status').textContent = message;
}

function isLikelyWhitePixel(data, index) {
  const red = data[index];
  const green = data[index + 1];
  const blue = data[index + 2];
  const alpha = data[index + 3];
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

function findCanvasContentBounds(canvas) {
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

  if (
    maxX < minX ||
    maxY < minY ||
    contentRatio < PDF_CROP_MIN_CONTENT_RATIO
  ) {
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
    contentRatio,
  };
}

function cropCanvas(canvas, crop) {
  const croppedCanvas = document.createElement('canvas');
  const context = croppedCanvas.getContext('2d');

  if (!context) {
    throw new Error('无法创建裁剪后的 PDF 预览画布。');
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

function createPreviewSourceCanvas(canvas) {
  const crop = findCanvasContentBounds(canvas);

  if (!crop) {
    return {
      canvas,
      crop: null,
    };
  }

  return {
    canvas: cropCanvas(canvas, crop),
    crop,
  };
}

function createPreviewCanvas() {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');

  if (!context) {
    throw new Error('无法创建 PDF 预览画布。');
  }

  return canvas;
}

function getPreviewDevicePixelRatio() {
  const rawRatio = window.devicePixelRatio || 1;

  if (!Number.isFinite(rawRatio) || rawRatio <= 0) {
    return 1;
  }

  return Math.min(PDF_PREVIEW_MAX_DEVICE_PIXEL_RATIO, rawRatio);
}

function getPreviewSmoothingQuality() {
  const quality = String(PDF_PREVIEW_IMAGE_SMOOTHING_QUALITY)
    .trim()
    .toLowerCase();

  if (quality === 'low' || quality === 'medium' || quality === 'high') {
    return quality;
  }

  return 'high';
}

function getPreviewSharpenStrength() {
  const parsedValue = Number(PDF_PREVIEW_SHARPEN_STRENGTH);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return 0;
  }

  return Math.min(1, parsedValue);
}

function sharpenCanvas(canvas, strength) {
  if (strength <= 0) {
    return;
  }

  const context = canvas.getContext('2d');
  const { width, height } = canvas;

  if (!context || width < 3 || height < 3) {
    return;
  }

  const imageData = context.getImageData(0, 0, width, height);
  const source = imageData.data;
  const output = new Uint8ClampedArray(source);
  const centerWeight = 1 + strength * 4;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = (y * width + x) * 4;
      const topIndex = index - width * 4;
      const bottomIndex = index + width * 4;
      const leftIndex = index - 4;
      const rightIndex = index + 4;

      for (let channel = 0; channel < 3; channel += 1) {
        output[index + channel] = Math.max(
          0,
          Math.min(
            255,
            source[index + channel] * centerWeight -
              source[topIndex + channel] * strength -
              source[bottomIndex + channel] * strength -
              source[leftIndex + channel] * strength -
              source[rightIndex + channel] * strength,
          ),
        );
      }
    }
  }

  imageData.data.set(output);
  context.putImageData(imageData, 0, 0);
}

function redrawReviewPreviewCanvas(sourceCanvas, previewCanvas, targetCssWidth) {
  const ratio = getPreviewDevicePixelRatio();
  const targetCssHeight = Math.round(
    targetCssWidth * (sourceCanvas.height / sourceCanvas.width),
  );
  const targetCanvasWidth = Math.max(1, Math.round(targetCssWidth * ratio));
  const targetCanvasHeight = Math.max(1, Math.round(targetCssHeight * ratio));
  const context = previewCanvas.getContext('2d');

  if (!context) {
    throw new Error('无法绘制 PDF 预览画布。');
  }

  previewCanvas.width = targetCanvasWidth;
  previewCanvas.height = targetCanvasHeight;
  previewCanvas.style.width = `${targetCssWidth}px`;
  previewCanvas.style.height = `${targetCssHeight}px`;

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = getPreviewSmoothingQuality();
  context.clearRect(0, 0, targetCanvasWidth, targetCanvasHeight);
  context.drawImage(
    sourceCanvas,
    0,
    0,
    sourceCanvas.width,
    sourceCanvas.height,
    0,
    0,
    targetCanvasWidth,
    targetCanvasHeight,
  );
  sharpenCanvas(previewCanvas, getPreviewSharpenStrength());
}

function updateReviewPreviewZoom(sourceCanvas, previewCanvas, zoom, label) {
  const targetWidth = Math.max(1, Math.round(PDF_PREVIEW_BASE_WIDTH * zoom));

  redrawReviewPreviewCanvas(sourceCanvas, previewCanvas, targetWidth);
  label.textContent = `${Math.round(zoom * 100)}%`;
}

function createReviewPreviewControls(sourceCanvas, previewCanvas, preview) {
  let zoom = PDF_PREVIEW_DEFAULT_ZOOM;
  const toolbar = document.createElement('div');
  const zoomOutButton = document.createElement('button');
  const zoomInButton = document.createElement('button');
  const fitButton = document.createElement('button');
  const originalButton = document.createElement('button');
  const zoomLabel = document.createElement('span');

  toolbar.className = 'slot-review-preview-toolbar';
  zoomOutButton.type = 'button';
  zoomOutButton.textContent = '缩小';
  zoomInButton.type = 'button';
  zoomInButton.textContent = '放大';
  fitButton.type = 'button';
  fitButton.textContent = '适宽';
  originalButton.type = 'button';
  originalButton.textContent = '1:1';
  zoomLabel.className = 'slot-review-preview-zoom';

  const fitToWidth = () => {
    const availableWidth = Math.max(1, preview.clientWidth - 28);

    zoom = Math.min(
      PDF_PREVIEW_MAX_ZOOM,
      Math.max(PDF_PREVIEW_MIN_ZOOM, availableWidth / PDF_PREVIEW_BASE_WIDTH),
    );
    updateReviewPreviewZoom(sourceCanvas, previewCanvas, zoom, zoomLabel);
  };

  zoomOutButton.addEventListener('click', () => {
    zoom = Math.max(
      PDF_PREVIEW_MIN_ZOOM,
      Number((zoom - PDF_PREVIEW_ZOOM_STEP).toFixed(2)),
    );
    updateReviewPreviewZoom(sourceCanvas, previewCanvas, zoom, zoomLabel);
  });
  zoomInButton.addEventListener('click', () => {
    zoom = Math.min(
      PDF_PREVIEW_MAX_ZOOM,
      Number((zoom + PDF_PREVIEW_ZOOM_STEP).toFixed(2)),
    );
    updateReviewPreviewZoom(sourceCanvas, previewCanvas, zoom, zoomLabel);
  });
  fitButton.addEventListener('click', fitToWidth);
  originalButton.addEventListener('click', () => {
    zoom = Math.min(
      PDF_PREVIEW_MAX_ZOOM,
      Math.max(
        PDF_PREVIEW_MIN_ZOOM,
        sourceCanvas.width / PDF_PREVIEW_BASE_WIDTH,
      ),
    );
    updateReviewPreviewZoom(sourceCanvas, previewCanvas, zoom, zoomLabel);
  });

  updateReviewPreviewZoom(sourceCanvas, previewCanvas, zoom, zoomLabel);
  toolbar.append(
    zoomOutButton,
    zoomInButton,
    fitButton,
    originalButton,
    zoomLabel,
  );

  return toolbar;
}

function updateCanvasZoom(canvas, zoom, label) {
  canvas.style.width = `${canvas.width * zoom}px`;
  canvas.style.height = 'auto';
  label.textContent = `${Math.round(zoom * 100)}%`;
}

function createCanvasPreview(result) {
  let zoom = 1;
  const container = document.createElement('div');
  const toolbar = document.createElement('div');
  const zoomOutButton = document.createElement('button');
  const zoomInButton = document.createElement('button');
  const fitButton = document.createElement('button');
  const originalButton = document.createElement('button');
  const zoomLabel = document.createElement('span');
  const canvasWrap = document.createElement('div');

  toolbar.className = 'canvas-toolbar';
  zoomOutButton.type = 'button';
  zoomOutButton.textContent = '缩小';
  zoomInButton.type = 'button';
  zoomInButton.textContent = '放大';
  fitButton.type = 'button';
  fitButton.textContent = '适宽';
  originalButton.type = 'button';
  originalButton.textContent = '原始';
  zoomLabel.className = 'canvas-zoom-label';
  canvasWrap.className = 'raw-canvas-wrap';

  const fitCanvasToWidth = () => {
    const availableWidth = Math.max(1, canvasWrap.clientWidth - 24);
    zoom = Math.min(1, availableWidth / result.canvas.width);
    updateCanvasZoom(result.canvas, zoom, zoomLabel);
  };

  zoomOutButton.addEventListener('click', () => {
    zoom = Math.max(0.1, Number((zoom - 0.1).toFixed(2)));
    updateCanvasZoom(result.canvas, zoom, zoomLabel);
  });
  zoomInButton.addEventListener('click', () => {
    zoom = Math.min(3, Number((zoom + 0.1).toFixed(2)));
    updateCanvasZoom(result.canvas, zoom, zoomLabel);
  });
  fitButton.addEventListener('click', fitCanvasToWidth);
  originalButton.addEventListener('click', () => {
    zoom = 1;
    updateCanvasZoom(result.canvas, zoom, zoomLabel);
  });

  toolbar.append(
    zoomOutButton,
    zoomInButton,
    fitButton,
    originalButton,
    zoomLabel,
  );
  canvasWrap.append(result.canvas);
  container.append(toolbar, canvasWrap);

  window.requestAnimationFrame(fitCanvasToWidth);

  return container;
}

function renderPageResult(result) {
  const section = document.createElement('section');
  section.className = 'page';
  const previewSource = createPreviewSourceCanvas(result.canvas);

  const title = document.createElement('h2');
  title.textContent = `PDF 第 ${result.pageNumber} 页`;
  section.append(title);

  if (previewSource.crop) {
    const cropInfo = document.createElement('p');
    cropInfo.className = 'crop-info';
    cropInfo.textContent = `已自动裁剪白边：x=${previewSource.crop.left}, y=${previewSource.crop.top}, w=${previewSource.crop.width}, h=${previewSource.crop.height}`;
    section.append(cropInfo);
  }

  const preview = document.createElement('div');
  preview.className = 'slot-review-preview';

  const badge = document.createElement('span');
  badge.className = 'page-badge';
  badge.textContent = `PDF 第 ${result.pageNumber} 页`;

  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'slot-review-canvas-wrap';

  const previewCanvas = createPreviewCanvas();
  previewCanvas.className = 'preview-canvas';
  previewCanvas.setAttribute('aria-label', `PDF 第 ${result.pageNumber} 页预览`);
  canvasWrap.append(previewCanvas);
  section.append(createReviewPreviewControls(previewSource.canvas, previewCanvas, preview));
  preview.append(badge, canvasWrap);
  section.append(preview);

  const actions = document.createElement('div');
  actions.className = 'page-actions';
  const downloadLink = document.createElement('a');
  const imageExtension = result.imageFormat.split('/')[1] || 'png';
  downloadLink.href = result.imageDataUrl;
  downloadLink.download = `pdf-page-${result.pageNumber}.${imageExtension}`;
  downloadLink.textContent = `下载高清 ${imageExtension.toUpperCase()}`;
  actions.append(downloadLink);
  section.append(actions);

  const canvasDetails = document.createElement('details');
  const canvasSummary = document.createElement('summary');
  canvasSummary.textContent = '查看 canvas 预览';
  canvasDetails.append(canvasSummary, createCanvasPreview(result));
  section.append(canvasDetails);

  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = '查看 imageDataUrl';
  const textarea = document.createElement('textarea');
  textarea.readOnly = true;
  textarea.value = result.imageDataUrl;
  details.append(summary, textarea);
  section.append(details);

  return section;
}

async function handleRender() {
  const fileInput = document.querySelector('#pdf-file');
  const pagesContainer = document.querySelector('#pages');
  const file = fileInput.files?.[0];

  if (!file) {
    setStatus('请先选择 PDF 文件。');
    return;
  }

  pagesContainer.replaceChildren();
  setStatus('正在读取 PDF...');

  const pdf = await loadPdfDocument(file);
  const pageNumbers = Array.from(
    { length: pdf.numPages },
    (_, index) => index + 1,
  );

  setStatus(`正在渲染 ${pageNumbers.length} 页，配置：${JSON.stringify(getPdfRenderConfig())}`);
  const results = await renderPdfPagesForVision(file, pageNumbers);

  window.pdfCanvasPages = results;
  pagesContainer.replaceChildren(...results.map(renderPageResult));
  setStatus(`完成：已导出 ${results.length} 张图片。控制台可查看 window.pdfCanvasPages。`);
}

document.querySelector('#render-button').addEventListener('click', () => {
  handleRender().catch((error) => {
    console.error(error);
    setStatus(error instanceof Error ? error.message : String(error));
  });
});
