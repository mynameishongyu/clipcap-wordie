'use client';

export function logLlmUsageToBrowserConsole(
  label: string,
  usage: unknown,
  context?: Record<string, unknown>,
) {
  if (!usage) {
    return;
  }

  console.info(`[LLM Usage][${label}]`, {
    ...(context ?? {}),
    usage,
  });
}
