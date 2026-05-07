'use client';

function isBrowserProcessLogEnabled() {
  return process.env.NEXT_PUBLIC_BROWSER_PROCESS_LOGS_ENABLED === 'true';
}

export const browserProcessLog = {
  log(...args: unknown[]) {
    if (isBrowserProcessLogEnabled()) {
      console.log(...args);
    }
  },
  info(...args: unknown[]) {
    if (isBrowserProcessLogEnabled()) {
      console.info(...args);
    }
  },
  warn(...args: unknown[]) {
    if (isBrowserProcessLogEnabled()) {
      console.warn(...args);
    }
  },
  error(...args: unknown[]) {
    if (isBrowserProcessLogEnabled()) {
      console.error(...args);
    }
  },
};
