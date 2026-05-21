const DEFAULT_PDF_RENDER_SCALE = 6.0;
const DEFAULT_PDF_RENDER_JPEG_QUALITY = 0.92;
const DEFAULT_PDF_AUTO_ROTATE_PAGES = true;
const DEFAULT_PDF_JPEG_MAX_LONG_EDGE = 3200;
const DEFAULT_PDF_JPEG_GRAYSCALE = false;
const DEFAULT_PDF_JPEG_BACKGROUND_CLEANUP = false;
const DEFAULT_PDF_JPEG_BACKGROUND_WHITE_THRESHOLD = 246;
const DEFAULT_PDF_JPEG_BACKGROUND_INK_THRESHOLD = 190;
const DEFAULT_PDF_JPEG_CONTRAST = 1.04;
const PDF_AUTO_CROP_WHITE_MARGIN = true;
const PDF_CROP_WHITE_THRESHOLD = 245;
const PDF_CROP_CONTENT_DIFFERENCE_THRESHOLD = 18;
const PDF_CROP_PADDING_RATIO = 0.025;
const PDF_CROP_MIN_CONTENT_RATIO = 0.02;
const PDF_ROTATION_ANALYSIS_MAX_DIMENSION = 420;
const PDF_ROTATION_SIDEWAYS_ASPECT_RATIO = 1.12;
const PDF_ROTATION_PROJECTION_RATIO = 1.18;
const PDF_ROTATION_SIDE_STRIP_RATIO = 0.16;
const PDF_PREVIEW_BASE_WIDTH = 1020;
const PDF_PREVIEW_MIN_ZOOM = 0.45;
const PDF_PREVIEW_MAX_ZOOM = 2.2;
const PDF_PREVIEW_ZOOM_STEP = 0.1;
const PDF_PREVIEW_MAX_DEVICE_PIXEL_RATIO = 2;
const PDF_PREVIEW_IMAGE_SMOOTHING_QUALITY = 'high';
const PDF_PREVIEW_SHARPEN_STRENGTH = 0.25;

const PDFJS_VERSION = '5.6.205';
const PDFJS_CMAP_URL = `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/cmaps/`;
const PDFJS_STANDARD_FONT_DATA_URL = `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/standard_fonts/`;
const PDFJS_WORKER_URL = `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;

let pdfJsPromise = null;
let envRenderConfig = null;
let latestRenderSizeSummary = null;

function clampNumber(value, fallback, min, max) {
  const parsedValue = Number(value);

  if (!Number.isFinite(parsedValue)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsedValue));
}

function formatMegabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatImageSize(bytes) {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(2)} KB`;
  }

  return formatMegabytes(bytes);
}

function formatDuration(ms) {
  if (ms < 1000) {
    return `${ms}ms`;
  }

  return `${(ms / 1000).toFixed(2)}s`;
}

function getPreviewDevicePixelRatio() {
  const rawRatio = window.devicePixelRatio || 1;

  if (!Number.isFinite(rawRatio) || rawRatio <= 0) {
    return 1;
  }

  return Math.min(PDF_PREVIEW_MAX_DEVICE_PIXEL_RATIO, rawRatio);
}

function getPreviewSmoothingQuality() {
  const quality = PDF_PREVIEW_IMAGE_SMOOTHING_QUALITY.trim().toLowerCase();

  if (quality === 'low' || quality === 'medium' || quality === 'high') {
    return quality;
  }

  return 'high';
}

function getPdfAutoRotatePages(rawValue) {
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

function getControlConfig() {
  return {
    scale: clampNumber(
      document.querySelector('#render-scale')?.value,
      envRenderConfig?.scale ?? DEFAULT_PDF_RENDER_SCALE,
      0.5,
      10,
    ),
    imageFormat: 'image/jpeg',
    imageQuality: clampNumber(
      document.querySelector('#jpeg-quality')?.value,
      envRenderConfig?.imageQuality ?? DEFAULT_PDF_RENDER_JPEG_QUALITY,
      0.1,
      1,
    ),
    maxLongEdge: Math.floor(
      clampNumber(
        document.querySelector('#max-long-edge')?.value,
        envRenderConfig?.maxLongEdge ?? DEFAULT_PDF_JPEG_MAX_LONG_EDGE,
        0,
        8000,
      ),
    ),
    autoCropWhiteMargin:
      document.querySelector('#auto-crop')?.checked ??
      PDF_AUTO_CROP_WHITE_MARGIN,
    autoRotatePages:
      document.querySelector('#auto-rotate')?.checked ??
      DEFAULT_PDF_AUTO_ROTATE_PAGES,
    grayscale:
      document.querySelector('#grayscale')?.checked ??
      DEFAULT_PDF_JPEG_GRAYSCALE,
    backgroundCleanup:
      document.querySelector('#background-cleanup')?.checked ??
      DEFAULT_PDF_JPEG_BACKGROUND_CLEANUP,
    backgroundWhiteThreshold:
      envRenderConfig?.backgroundWhiteThreshold ??
      DEFAULT_PDF_JPEG_BACKGROUND_WHITE_THRESHOLD,
    backgroundInkThreshold:
      envRenderConfig?.backgroundInkThreshold ??
      DEFAULT_PDF_JPEG_BACKGROUND_INK_THRESHOLD,
    contrast:
      envRenderConfig?.contrast ?? DEFAULT_PDF_JPEG_CONTRAST,
  };
}

function renderConfigInfo() {
  const target = document.querySelector('#render-config-info');
  const config = getControlConfig();

  if (!target) {
    return;
  }

  const latestSummary = latestRenderSizeSummary
    ? `
      <div class="summary">
        Latest rendered file: <code>${latestRenderSizeSummary.fileName}</code><br />
        Page count: <code>${latestRenderSizeSummary.pageCount}</code><br />
        JPEG total: <code>${formatMegabytes(latestRenderSizeSummary.totalBytes)}</code><br />
        Average page: <code>${formatImageSize(latestRenderSizeSummary.averageBytes)}</code><br />
        Render time: <code>${formatDuration(latestRenderSizeSummary.durationMs)}</code>
      </div>
    `
    : '';

  target.innerHTML = `
    <div class="notice">
      V2 固定导出 <code>image/jpeg</code>，用于测试降低体积但保持文字清晰的策略。
    </div>
    <div>
      当前参数：
      scale=<code>${config.scale}</code>，
      quality=<code>${config.imageQuality}</code>，
      maxLongEdge=<code>${config.maxLongEdge || 'off'}</code>，
      crop=<code>${config.autoCropWhiteMargin}</code>，
      autoRotate=<code>${config.autoRotatePages}</code>，
      grayscale=<code>${config.grayscale}</code>，
      backgroundCleanup=<code>${config.backgroundCleanup}</code>
    </div>
    <div>
      .env.local 原始值：
      NEXT_PUBLIC_PDF_RENDER_SCALE=<code>${envRenderConfig?.rawEnv?.NEXT_PUBLIC_PDF_RENDER_SCALE || '未读取'}</code>，
      NEXT_PUBLIC_PDF_RENDER_JPEG_QUALITY=<code>${envRenderConfig?.rawEnv?.NEXT_PUBLIC_PDF_RENDER_JPEG_QUALITY || '未读取'}</code>，
      NEXT_PUBLIC_PDF_AUTO_ROTATE_PAGES=<code>${envRenderConfig?.rawEnv?.NEXT_PUBLIC_PDF_AUTO_ROTATE_PAGES || '未读取'}</code>
    </div>
    ${latestSummary}
  `;
}

function hydrateControlsFromEnv() {
  const renderScaleInput = document.querySelector('#render-scale');
  const jpegQualityInput = document.querySelector('#jpeg-quality');
  const maxLongEdgeInput = document.querySelector('#max-long-edge');
  const autoCropInput = document.querySelector('#auto-crop');
  const autoRotateInput = document.querySelector('#auto-rotate');
  const grayscaleInput = document.querySelector('#grayscale');
  const backgroundCleanupInput = document.querySelector('#background-cleanup');

  renderScaleInput.value = String(envRenderConfig?.scale ?? DEFAULT_PDF_RENDER_SCALE);
  jpegQualityInput.value = String(
    envRenderConfig?.imageQuality ?? DEFAULT_PDF_RENDER_JPEG_QUALITY,
  );
  maxLongEdgeInput.value = String(
    envRenderConfig?.maxLongEdge ?? DEFAULT_PDF_JPEG_MAX_LONG_EDGE,
  );
  autoCropInput.checked = PDF_AUTO_CROP_WHITE_MARGIN;
  autoRotateInput.checked =
    envRenderConfig?.autoRotatePages ?? DEFAULT_PDF_AUTO_ROTATE_PAGES;
  grayscaleInput.checked =
    envRenderConfig?.grayscale ?? DEFAULT_PDF_JPEG_GRAYSCALE;
  backgroundCleanupInput.checked =
    envRenderConfig?.backgroundCleanup ?? DEFAULT_PDF_JPEG_BACKGROUND_CLEANUP;
}

async function loadEnvRenderConfig() {
  try {
    const response = await fetch(`/api/config?t=${Date.now()}`, {
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new Error(`读取 /api/config 失败：${response.status}`);
    }

    envRenderConfig = await response.json();
  } catch (error) {
    console.warn('[PDF JPEG V2] 未读取到 .env.local 配置，将使用测试页默认值。', error);
    envRenderConfig = null;
  }

  hydrateControlsFromEnv();
  renderConfigInfo();
}

async function loadPdfJs() {
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

function isLikelyWhitePixel(data, index) {
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

function findCanvasContentBounds(canvas, config) {
  const context = canvas.getContext('2d', { willReadFrequently: true });

  if (!context || !config.autoCropWhiteMargin) {
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

function cropCanvas(canvas, crop) {
  const croppedCanvas = document.createElement('canvas');
  const context = croppedCanvas.getContext('2d');

  if (!context) {
    throw new Error('无法创建裁剪后的 PDF 页面画布。');
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

function calculateStandardDeviation(values) {
  if (values.length === 0) {
    return 0;
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    values.length;

  return Math.sqrt(variance);
}

function getEdgeInkDensity(data, width, height, edge) {
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

function analyzeCanvasSidewaysRotation(canvas, contentBounds, config) {
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
  const analysisWidth = Math.max(
    1,
    Math.round(contentBounds.width * analysisScale),
  );
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

  const leftDensity = getEdgeInkDensity(data, analysisWidth, analysisHeight, 'left');
  const rightDensity = getEdgeInkDensity(
    data,
    analysisWidth,
    analysisHeight,
    'right',
  );

  return leftDensity >= rightDensity ? 90 : -90;
}

function rotateCanvas(canvas, rotation) {
  if (rotation === 0) {
    return canvas;
  }

  const rotatedCanvas = document.createElement('canvas');
  const context = rotatedCanvas.getContext('2d');

  if (!context) {
    throw new Error('无法创建旋转后的 PDF 页面画布。');
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

function resizeCanvasToMaxLongEdge(canvas, maxLongEdge) {
  if (!maxLongEdge || maxLongEdge <= 0) {
    return {
      canvas,
      resized: false,
      resizeScale: 1,
    };
  }

  const longEdge = Math.max(canvas.width, canvas.height);

  if (longEdge <= maxLongEdge) {
    return {
      canvas,
      resized: false,
      resizeScale: 1,
    };
  }

  const resizeScale = maxLongEdge / longEdge;
  const resizedCanvas = document.createElement('canvas');
  const context = resizedCanvas.getContext('2d');

  if (!context) {
    throw new Error('无法创建降采样后的 PDF 页面画布。');
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

  return {
    canvas: resizedCanvas,
    resized: true,
    resizeScale,
  };
}

function enhanceCanvasForJpeg(canvas, config) {
  if (
    !config.grayscale &&
    !config.backgroundCleanup &&
    config.contrast === 1
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

    if (config.backgroundCleanup && gray >= config.backgroundWhiteThreshold) {
      data[index] = 255;
      data[index + 1] = 255;
      data[index + 2] = 255;
      continue;
    }

    const contrasted = Math.max(
      0,
      Math.min(255, (gray - 128) * config.contrast + 128),
    );

    if (config.grayscale) {
      const value =
        config.backgroundCleanup && contrasted <= config.backgroundInkThreshold
          ? Math.max(0, contrasted - 6)
          : contrasted;

      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
      continue;
    }

    data[index] = Math.max(0, Math.min(255, (red - 128) * config.contrast + 128));
    data[index + 1] = Math.max(
      0,
      Math.min(255, (green - 128) * config.contrast + 128),
    );
    data[index + 2] = Math.max(
      0,
      Math.min(255, (blue - 128) * config.contrast + 128),
    );
  }

  context.putImageData(imageData, 0, 0);
}

function createPdfVisionCanvas(canvas, config) {
  const initialCrop = findCanvasContentBounds(canvas, config);
  const rotationApplied = analyzeCanvasSidewaysRotation(canvas, initialCrop, config);
  const orientedCanvas = rotateCanvas(canvas, rotationApplied);
  const crop =
    rotationApplied === 0
      ? initialCrop
      : findCanvasContentBounds(orientedCanvas, config);
  const croppedCanvas = crop ? cropCanvas(orientedCanvas, crop) : orientedCanvas;
  const resizedResult = resizeCanvasToMaxLongEdge(croppedCanvas, config.maxLongEdge);

  enhanceCanvasForJpeg(resizedResult.canvas, config);

  return {
    canvas: resizedResult.canvas,
    crop,
    rotationApplied,
    resized: resizedResult.resized,
    resizeScale: resizedResult.resizeScale,
  };
}

function canvasToJpegBlob(canvas, imageQuality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('导出 JPEG 失败。'));
          return;
        }

        resolve(blob);
      },
      'image/jpeg',
      imageQuality,
    );
  });
}

async function renderPdfPagesForJpegV2(pdf, pageNumbers, config, onPageRendered) {
  const results = [];

  for (const [index, pageNumber] of pageNumbers.entries()) {
    const startedAt = performance.now();
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: config.scale });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');

    if (!context) {
      throw new Error('无法创建 PDF 页面画布。');
    }

    canvas.width = viewport.width;
    canvas.height = viewport.height;

    await page.render({
      canvas,
      canvasContext: context,
      viewport,
    }).promise;

    const visionCanvas = createPdfVisionCanvas(canvas, config);
    const imageBlob = await canvasToJpegBlob(visionCanvas.canvas, config.imageQuality);
    const imageUrl = URL.createObjectURL(imageBlob);
    const durationMs = Math.round(performance.now() - startedAt);

    results.push({
      pageNumber,
      imageBlob,
      imageUrl,
      width: visionCanvas.canvas.width,
      height: visionCanvas.canvas.height,
      sourceWidth: canvas.width,
      sourceHeight: canvas.height,
      crop: visionCanvas.crop,
      rotationApplied: visionCanvas.rotationApplied,
      resized: visionCanvas.resized,
      resizeScale: visionCanvas.resizeScale,
      durationMs,
    });

    onPageRendered?.({
      pageNumber,
      index: index + 1,
      total: pageNumbers.length,
      bytes: imageBlob.size,
      durationMs,
    });
  }

  return results;
}

function setStatus(message) {
  document.querySelector('#status').textContent = message;
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

function drawImageToPreviewCanvas(image, canvas, displayWidth) {
  const ratio = getPreviewDevicePixelRatio();
  const cssWidth = Math.max(1, Math.round(displayWidth));
  const cssHeight = Math.max(
    1,
    Math.round(cssWidth * (image.naturalHeight / image.naturalWidth)),
  );
  const canvasWidth = Math.max(1, Math.round(cssWidth * ratio));
  const canvasHeight = Math.max(1, Math.round(cssHeight * ratio));
  const context = canvas.getContext('2d');

  if (!context) {
    return;
  }

  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  canvas.dataset.naturalWidth = String(image.naturalWidth);
  canvas.dataset.naturalHeight = String(image.naturalHeight);

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = getPreviewSmoothingQuality();
  context.clearRect(0, 0, canvasWidth, canvasHeight);
  context.drawImage(
    image,
    0,
    0,
    image.naturalWidth,
    image.naturalHeight,
    0,
    0,
    canvasWidth,
    canvasHeight,
  );
  sharpenCanvas(canvas, PDF_PREVIEW_SHARPEN_STRENGTH);
}

function updatePreviewZoom(previewState) {
  const displayWidth = PDF_PREVIEW_BASE_WIDTH * previewState.zoom;
  const image = previewState.image;

  previewState.wrap.style.width = `${Math.round(displayWidth)}px`;
  previewState.page.style.minWidth = `${Math.max(620, Math.round(displayWidth + 28))}px`;
  drawImageToPreviewCanvas(image, previewState.canvas, displayWidth);
  previewState.zoomLabel.textContent = `${Math.round(previewState.zoom * 100)}%`;
}

function clampPreviewZoom(value) {
  return Math.min(PDF_PREVIEW_MAX_ZOOM, Math.max(PDF_PREVIEW_MIN_ZOOM, value));
}

function createPreviewControls(previewState) {
  const toolbar = document.createElement('div');
  const zoomOutButton = document.createElement('button');
  const zoomInButton = document.createElement('button');
  const fitButton = document.createElement('button');
  const zoomLabel = document.createElement('span');

  toolbar.className = 'preview-toolbar';
  zoomOutButton.type = 'button';
  zoomInButton.type = 'button';
  fitButton.type = 'button';
  zoomOutButton.textContent = '缩小';
  zoomInButton.textContent = '放大';
  fitButton.textContent = '适宽';
  zoomLabel.className = 'preview-zoom';
  previewState.zoomLabel = zoomLabel;

  zoomOutButton.addEventListener('click', () => {
    previewState.zoom = Number(
      clampPreviewZoom(previewState.zoom - PDF_PREVIEW_ZOOM_STEP).toFixed(2),
    );
    updatePreviewZoom(previewState);
  });
  zoomInButton.addEventListener('click', () => {
    previewState.zoom = Number(
      clampPreviewZoom(previewState.zoom + PDF_PREVIEW_ZOOM_STEP).toFixed(2),
    );
    updatePreviewZoom(previewState);
  });
  fitButton.addEventListener('click', () => {
    previewState.zoom = 1;
    updatePreviewZoom(previewState);
  });

  toolbar.append(zoomOutButton, zoomLabel, zoomInButton, fitButton);

  return toolbar;
}

function createPageResult(result, fileName) {
  const section = document.createElement('section');
  const title = document.createElement('h2');
  const meta = document.createElement('p');
  const preview = document.createElement('div');
  const badge = document.createElement('span');
  const wrap = document.createElement('div');
  const canvas = document.createElement('canvas');
  const image = new Image();
  const previewState = {
    zoom: 1,
    image,
    canvas,
    wrap,
    page: preview,
    zoomLabel: null,
  };

  section.className = 'page';
  title.textContent = `PDF 第 ${result.pageNumber} 页`;
  meta.className = 'page-meta';
  meta.innerHTML = [
    `JPEG size: <code>${formatImageSize(result.imageBlob.size)}</code>`,
    `final: <code>${result.width} x ${result.height}</code>`,
    `rendered: <code>${result.sourceWidth} x ${result.sourceHeight}</code>`,
    result.crop
      ? `crop: <code>x=${result.crop.left}, y=${result.crop.top}, w=${result.crop.width}, h=${result.crop.height}</code>`
      : 'crop: <code>none</code>',
    result.rotationApplied
      ? `rotation: <code>${result.rotationApplied}</code>`
      : 'rotation: <code>0</code>',
    result.resized
      ? `resizeScale: <code>${result.resizeScale.toFixed(3)}</code>`
      : 'resizeScale: <code>1</code>',
    `time: <code>${formatDuration(result.durationMs)}</code>`,
  ].join('；');

  preview.className = 'slot-review-page';
  badge.className = 'page-badge';
  badge.textContent = `PDF 第 ${result.pageNumber} 页`;
  wrap.className = 'slot-review-canvas-wrap';
  canvas.className = 'preview-canvas';
  canvas.setAttribute('aria-label', `${fileName} 第 ${result.pageNumber} 页`);

  image.onload = () => updatePreviewZoom(previewState);
  image.src = result.imageUrl;

  wrap.append(canvas);
  preview.append(badge, wrap);
  section.append(title, meta, createPreviewControls(previewState), preview);

  const actions = document.createElement('div');
  const downloadLink = document.createElement('a');
  actions.className = 'page-actions';
  downloadLink.href = result.imageUrl;
  downloadLink.download = `pdf-page-${result.pageNumber}.jpg`;
  downloadLink.textContent = '下载 JPEG';
  actions.append(downloadLink);
  section.append(actions);

  const details = document.createElement('details');
  const summary = document.createElement('summary');
  const textarea = document.createElement('textarea');
  summary.textContent = '查看 Object URL';
  textarea.readOnly = true;
  textarea.value = result.imageUrl;
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
  latestRenderSizeSummary = null;
  renderConfigInfo();

  const config = getControlConfig();
  const startedAt = performance.now();
  setStatus('正在读取 PDF...');

  const pdf = await loadPdfDocument(file);
  const pageNumbers = Array.from({ length: pdf.numPages }, (_, index) => index + 1);

  setStatus(
    `正在渲染 ${pageNumbers.length} 页，配置：${JSON.stringify(config)}`,
  );

  const results = await renderPdfPagesForJpegV2(
    pdf,
    pageNumbers,
    config,
    ({ pageNumber, index, total, bytes, durationMs }) => {
      setStatus(
        `已渲染 ${index}/${total} 页：PDF 第 ${pageNumber} 页，${formatImageSize(
          bytes,
        )}，${formatDuration(durationMs)}`,
      );
    },
  );
  const totalBytes = results.reduce((sum, result) => sum + result.imageBlob.size, 0);
  const durationMs = Math.round(performance.now() - startedAt);

  latestRenderSizeSummary = {
    fileName: file.name,
    pageCount: results.length,
    totalBytes,
    averageBytes: results.length > 0 ? totalBytes / results.length : 0,
    durationMs,
  };
  window.pdfJpegV2Pages = results;
  renderConfigInfo();
  pagesContainer.replaceChildren(
    ...results.map((result) => createPageResult(result, file.name)),
  );
  console.info('[PDF JPEG V2][Completed]', {
    fileName: file.name,
    pageCount: results.length,
    totalBytes,
    averageBytes: latestRenderSizeSummary.averageBytes,
    durationMs,
    config,
    pages: results.map((result) => ({
      pageNumber: result.pageNumber,
      bytes: result.imageBlob.size,
      width: result.width,
      height: result.height,
      crop: result.crop,
      rotationApplied: result.rotationApplied,
      resized: result.resized,
      resizeScale: result.resizeScale,
      durationMs: result.durationMs,
    })),
  });
  setStatus(
    `完成：已导出 ${results.length} 页 JPEG，总大小 ${formatMegabytes(
      totalBytes,
    )}，耗时 ${formatDuration(durationMs)}。`,
  );
}

document.querySelector('#render-button').addEventListener('click', () => {
  handleRender().catch((error) => {
    console.error(error);
    setStatus(error instanceof Error ? error.message : String(error));
  });
});

document
  .querySelectorAll('input, select')
  .forEach((input) => input.addEventListener('change', renderConfigInfo));

loadEnvRenderConfig();
