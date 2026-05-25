const form = document.querySelector('#convert-form');
const submitButton = document.querySelector('#submit-button');
const statusEl = document.querySelector('#status');
const resultEl = document.querySelector('#result');
const resultTitleEl = document.querySelector('#result-title');
const linksEl = document.querySelector('#links');
const logEl = document.querySelector('#log');

function getValue(selector) {
  return document.querySelector(selector).value.trim();
}

function setBusy(isBusy) {
  submitButton.disabled = isBusy;
  submitButton.textContent = isBusy ? '生成中...' : '生成 PDF';
  statusEl.textContent = isBusy ? '正在下载 PNG 并合成 PDF。' : '';
}

function showResult(payload) {
  resultEl.classList.add('visible');
  linksEl.innerHTML = '';

  if (payload.error) {
    resultTitleEl.textContent = payload.error;
    logEl.textContent = payload.log || '';
    return;
  }

  const data = payload.data;
  resultTitleEl.textContent = `完成：${data.pageCount} 页`;

  [
    ['打开 PDF', data.pdfUrl],
    ['查看 manifest', data.manifestUrl],
  ].forEach(([label, href]) => {
    const link = document.createElement('a');

    link.href = href;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = label;
    linksEl.appendChild(link);
  });

  logEl.textContent = [
    `输出目录: ${data.outputDir}`,
    data.uploadedPath ? `已上传: ${data.uploadedPath}` : '',
    '',
    data.log || '',
  ]
    .filter(Boolean)
    .join('\n');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  setBusy(true);
  resultEl.classList.remove('visible');

  try {
    const response = await fetch('/api/convert', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        prefix: getValue('#prefix'),
        bucket: getValue('#bucket') || 'generation-pdfs',
        pageWidth: getValue('#page-width'),
        pageHeight: getValue('#page-height'),
        uploadPath: getValue('#upload-path'),
      }),
    });
    const payload = await response.json();

    showResult(payload);
  } catch (error) {
    showResult({
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    setBusy(false);
  }
});
