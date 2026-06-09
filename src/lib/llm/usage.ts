export type LlmUsageTokenSummary = {
  call_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
};

export type LlmUsageCall = LlmUsageTokenSummary & {
  phase: string;
  provider: string;
  model: string;
  request_label?: string;
};

export type LlmUsageSummary = LlmUsageTokenSummary & {
  provider?: string;
  model?: string;
  model_env_name?: string;
  phases: Record<string, LlmUsageTokenSummary>;
  calls: LlmUsageCall[];
};

export type LlmUsageAccumulator = {
  calls: LlmUsageCall[];
};

const EMPTY_TOKEN_SUMMARY: LlmUsageTokenSummary = {
  call_count: 0,
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  cached_tokens: 0,
  reasoning_tokens: 0,
};

function asRecord(value: unknown) {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function readNumber(record: Record<string, unknown>, keys: string[]) {
  return readOptionalNumber(record, keys) ?? 0;
}

function readOptionalNumber(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

function addTokenSummary(
  target: LlmUsageTokenSummary,
  source: LlmUsageTokenSummary,
) {
  target.call_count += source.call_count;
  target.prompt_tokens += source.prompt_tokens;
  target.completion_tokens += source.completion_tokens;
  target.total_tokens += source.total_tokens;
  target.cached_tokens += source.cached_tokens;
  target.reasoning_tokens += source.reasoning_tokens;
}

export function createLlmUsageAccumulator(): LlmUsageAccumulator {
  return { calls: [] };
}

export function extractLlmUsageTokenSummary(
  payload: unknown,
): LlmUsageTokenSummary | null {
  const response = asRecord(payload);
  const usage = asRecord(
    response.usage ??
      response.usageMetadata ??
      response.usage_metadata ??
      response.tokenUsage,
  );

  if (Object.keys(usage).length === 0) {
    return null;
  }

  const explicitPromptTokens = readOptionalNumber(usage, [
    'prompt_tokens',
    'promptTokenCount',
    'input_tokens',
    'inputTokenCount',
  ]);
  const completionTokens = readNumber(usage, [
    'completion_tokens',
    'candidatesTokenCount',
    'output_tokens',
    'outputTokenCount',
  ]);
  const promptDetails = asRecord(
    usage.prompt_tokens_details ?? usage.promptTokensDetails,
  );
  const completionDetails = asRecord(
    usage.completion_tokens_details ?? usage.completionTokensDetails,
  );
  const reasoningTokens =
    readNumber(usage, ['thoughtsTokenCount', 'reasoning_tokens']) ||
    readNumber(completionDetails, ['reasoning_tokens', 'reasoningTokens']);
  const explicitTotalTokens = readOptionalNumber(usage, [
    'total_tokens',
    'totalTokenCount',
  ]);
  const promptTokens =
    explicitPromptTokens ??
    (explicitTotalTokens !== null
      ? Math.max(0, explicitTotalTokens - completionTokens - reasoningTokens)
      : 0);
  const totalTokens =
    explicitTotalTokens ?? promptTokens + completionTokens + reasoningTokens;

  return {
    call_count: 1,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    cached_tokens:
      readNumber(usage, [
        'cached_tokens',
        'cachedContentTokenCount',
        'cacheReadInputTokens',
      ]) || readNumber(promptDetails, ['cached_tokens', 'cachedTokens']),
    reasoning_tokens: reasoningTokens,
  };
}

export function recordLlmUsageFromPayload(
  accumulator: LlmUsageAccumulator | undefined,
  input: {
    phase: string;
    provider: string;
    model: string;
    requestLabel?: string;
    payload: unknown;
  },
) {
  if (!accumulator) {
    return;
  }

  const usage = extractLlmUsageTokenSummary(input.payload);

  if (!usage) {
    return;
  }

  accumulator.calls.push({
    ...usage,
    phase: input.phase,
    provider: input.provider,
    model: input.model,
    ...(input.requestLabel ? { request_label: input.requestLabel } : {}),
  });
}

export function extractAiSdkUsageTokenSummary(
  usage: unknown,
): LlmUsageTokenSummary | null {
  const usageRecord = asRecord(usage);

  if (Object.keys(usageRecord).length === 0) {
    return null;
  }

  const inputTokenDetails = asRecord(usageRecord.inputTokenDetails);
  const outputTokenDetails = asRecord(usageRecord.outputTokenDetails);
  const promptTokens = readNumber(usageRecord, ['inputTokens']);
  const completionTokens = readNumber(usageRecord, ['outputTokens']);
  const reasoningTokens =
    readNumber(outputTokenDetails, ['reasoningTokens']) ||
    readNumber(usageRecord, ['reasoningTokens']);
  const explicitTotalTokens = readOptionalNumber(usageRecord, [
    'totalTokens',
  ]);

  return {
    call_count: 1,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens:
      explicitTotalTokens ?? promptTokens + completionTokens,
    cached_tokens:
      readNumber(inputTokenDetails, ['cacheReadTokens']) ||
      readNumber(usageRecord, ['cachedInputTokens']),
    reasoning_tokens: reasoningTokens,
  };
}

export function recordLlmUsageFromAiSdkUsage(
  accumulator: LlmUsageAccumulator | undefined,
  input: {
    phase: string;
    provider: string;
    model: string;
    requestLabel?: string;
    usage: unknown;
  },
) {
  if (!accumulator) {
    return;
  }

  const usage = extractAiSdkUsageTokenSummary(input.usage);

  if (!usage) {
    return;
  }

  accumulator.calls.push({
    ...usage,
    phase: input.phase,
    provider: input.provider,
    model: input.model,
    ...(input.requestLabel ? { request_label: input.requestLabel } : {}),
  });
}

export function summarizeLlmUsage(
  accumulator: LlmUsageAccumulator,
  metadata?: {
    provider?: string;
    model?: string;
    modelEnvName?: string;
  },
): LlmUsageSummary {
  const summary: LlmUsageSummary = {
    ...EMPTY_TOKEN_SUMMARY,
    ...(metadata?.provider ? { provider: metadata.provider } : {}),
    ...(metadata?.model ? { model: metadata.model } : {}),
    ...(metadata?.modelEnvName
      ? { model_env_name: metadata.modelEnvName }
      : {}),
    phases: {},
    calls: accumulator.calls,
  };

  for (const call of accumulator.calls) {
    addTokenSummary(summary, call);

    const phaseSummary = summary.phases[call.phase] ?? {
      ...EMPTY_TOKEN_SUMMARY,
    };
    addTokenSummary(phaseSummary, call);
    summary.phases[call.phase] = phaseSummary;
  }

  return summary;
}
