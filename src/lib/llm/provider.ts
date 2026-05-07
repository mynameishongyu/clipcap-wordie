import {
  getOptionalEnv,
  getTextLlmApiKey,
  getTextLlmBaseUrl,
  getTextLlmModel,
  getVisionLlmApiKey,
  getVisionLlmBaseUrl,
  getVisionLlmModel,
} from '@/src/lib/llm/env';

export type LlmRole = 'text' | 'vision';
export type LlmProvider = 'kimi' | 'gemini' | 'openai-compatible';

export interface LlmRuntimeConfig {
  provider: LlmProvider;
  model: string;
  apiKey: string;
  baseUrl: string;
  chatCompletionsUrl: string;
  extraBody: Record<string, unknown>;
}

const KIMI_K25_INSTANT_THINKING_CONFIG = {
  type: 'disabled',
} as const;
const GEMINI_REASONING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
] as const;
type GeminiReasoningEffort = (typeof GEMINI_REASONING_EFFORTS)[number];

function normalizeModelName(model: string) {
  return model.trim().toLowerCase();
}

function detectProvider(model: string): LlmProvider {
  const normalizedModel = normalizeModelName(model);

  if (normalizedModel.startsWith('gemini-')) {
    return 'gemini';
  }

  if (
    normalizedModel.startsWith('kimi-') ||
    normalizedModel.startsWith('moonshot-')
  ) {
    return 'kimi';
  }

  return 'openai-compatible';
}

function resolveChatCompletionsUrl(baseUrl: string) {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');

  if (normalizedBaseUrl.endsWith('/chat/completions')) {
    return normalizedBaseUrl;
  }

  return `${normalizedBaseUrl}/chat/completions`;
}

function getRoleApiKey(role: LlmRole) {
  return role === 'text' ? getTextLlmApiKey() : getVisionLlmApiKey();
}

function getRoleBaseUrl(role: LlmRole) {
  return role === 'text' ? getTextLlmBaseUrl() : getVisionLlmBaseUrl();
}

function getRoleModel(role: LlmRole) {
  return role === 'text' ? getTextLlmModel() : getVisionLlmModel();
}

function getRoleThinkingEnabledEnvName(role: LlmRole) {
  return role === 'text'
    ? 'TEXT_LLM_THINKING_ENABLED'
    : 'VISION_LLM_THINKING_ENABLED';
}

function getRoleReasoningEffortEnvName(role: LlmRole) {
  return role === 'text'
    ? 'TEXT_LLM_REASONING_EFFORT'
    : 'VISION_LLM_REASONING_EFFORT';
}

function getProviderApiKey(role: LlmRole, provider: LlmProvider) {
  if (provider === 'gemini') {
    return getOptionalEnv('GEMINI_API_KEY') ?? getRoleApiKey(role);
  }

  if (provider === 'kimi') {
    return (
      getOptionalEnv('KIMI_API_KEY') ??
      getOptionalEnv('MOONSHOT_API_KEY') ??
      getRoleApiKey(role)
    );
  }

  return getRoleApiKey(role);
}

function getProviderBaseUrl(role: LlmRole, provider: LlmProvider) {
  if (provider === 'gemini') {
    return (
      getOptionalEnv('GEMINI_BASE_URL') ??
      'https://generativelanguage.googleapis.com/v1beta/openai'
    );
  }

  if (provider === 'kimi') {
    return (
      getOptionalEnv('KIMI_BASE_URL') ??
      getOptionalEnv('MOONSHOT_BASE_URL') ??
      getRoleBaseUrl(role)
    );
  }

  return getRoleBaseUrl(role);
}

function getRoleThinkingEnabled(role: LlmRole) {
  const rawValue = getOptionalEnv(getRoleThinkingEnabledEnvName(role));

  if (!rawValue) {
    return false;
  }

  const normalizedValue = rawValue.trim().toLowerCase();

  if (['1', 'true', 'yes', 'on'].includes(normalizedValue)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalizedValue)) {
    return false;
  }

  throw new Error(
    `${getRoleThinkingEnabledEnvName(role)} must be true or false when configured.`,
  );
}

function getGeminiReasoningEffort(role: LlmRole): GeminiReasoningEffort {
  const rawValue =
    getOptionalEnv(getRoleReasoningEffortEnvName(role)) ?? 'medium';
  const normalizedValue = rawValue.trim().toLowerCase();

  if (
    GEMINI_REASONING_EFFORTS.includes(normalizedValue as GeminiReasoningEffort)
  ) {
    return normalizedValue as GeminiReasoningEffort;
  }

  throw new Error(
    `${getRoleReasoningEffortEnvName(role)} must be one of: ${GEMINI_REASONING_EFFORTS.join(', ')}.`,
  );
}

function getProviderExtraBody(
  role: LlmRole,
  provider: LlmProvider,
  model: string,
) {
  const normalizedModel = normalizeModelName(model);
  const thinkingEnabled = getRoleThinkingEnabled(role);

  if (provider === 'gemini') {
    return {
      reasoning_effort: thinkingEnabled
        ? getGeminiReasoningEffort(role)
        : 'none',
    };
  }

  if (
    provider === 'kimi' &&
    normalizedModel === 'kimi-k2.5' &&
    !thinkingEnabled
  ) {
    return {
      thinking: KIMI_K25_INSTANT_THINKING_CONFIG,
    };
  }

  return {};
}

export function getLlmRuntimeConfig(role: LlmRole): LlmRuntimeConfig {
  const model = getRoleModel(role);
  const provider = detectProvider(model);
  const baseUrl = getProviderBaseUrl(role, provider);

  return {
    provider,
    model,
    apiKey: getProviderApiKey(role, provider),
    baseUrl,
    chatCompletionsUrl: resolveChatCompletionsUrl(baseUrl),
    extraBody: getProviderExtraBody(role, provider, model),
  };
}

export function buildChatCompletionBody(
  config: LlmRuntimeConfig,
  input: {
    messages: Array<{
      role: 'system' | 'user' | 'assistant';
      content:
        | string
        | Array<
            | { type: 'text'; text: string }
            | { type: 'image_url'; image_url: { url: string } }
          >;
    }>;
  },
) {
  return {
    model: config.model,
    ...config.extraBody,
    messages: input.messages,
  };
}
