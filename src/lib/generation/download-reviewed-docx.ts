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
  requireUnreviewedWarning?: boolean;
}) {
  if (
    input.requireUnreviewedWarning &&
    !window.confirm(
      '当前内容还没有经过人工核查，可能存在填写不准确的情况。确认仍要下载吗？',
    )
  ) {
    return;
  }

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

export function requestGenerationTaskBatchDocxDownload(input: {
  taskId: string;
  defaultFileName: string;
}) {
  const sanitizedDefaultName = ensureZipExtension(
    sanitizeDownloadFileName(input.defaultFileName) ||
      'batch-generation-results.zip',
  );

  const nextFileName = window.prompt('请输入下载文件名', sanitizedDefaultName);

  if (nextFileName === null) {
    return;
  }

  const sanitizedFileName = sanitizeDownloadFileName(nextFileName);

  if (!sanitizedFileName) {
    return;
  }

  const finalFileName = ensureZipExtension(sanitizedFileName);
  const searchParams = new URLSearchParams({ filename: finalFileName });

  window.open(
    `/api/generation-tasks/${input.taskId}/download?${searchParams.toString()}`,
    '_blank',
    'noopener,noreferrer',
  );
}

function ensureZipExtension(value: string) {
  return value.toLowerCase().endsWith('.zip') ? value : `${value}.zip`;
}
