'use client';

function sanitizeDownloadFileName(value: string) {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/g, '');
}

function ensureDocxExtension(value: string) {
  return value.toLowerCase().endsWith('.docx') ? value : `${value}.docx`;
}

export function requestReviewedDocxDownload(input: {
  taskItemId: string;
  defaultFileName: string;
}) {
  const sanitizedDefaultName = ensureDocxExtension(
    sanitizeDownloadFileName(input.defaultFileName) || '核查结果.docx',
  );

  const nextFileName = window.prompt('请输入下载文件名', sanitizedDefaultName);

  if (nextFileName === null) {
    return;
  }

  const sanitizedFileName = sanitizeDownloadFileName(nextFileName);

  if (!sanitizedFileName) {
    return;
  }

  const finalFileName = ensureDocxExtension(sanitizedFileName);
  const searchParams = new URLSearchParams({ filename: finalFileName });

  window.open(
    `/api/generation-task-items/${input.taskItemId}/download?${searchParams.toString()}`,
    '_blank',
    'noopener,noreferrer',
  );
}
