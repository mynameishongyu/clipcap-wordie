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
export type LlmProvider =
  | 'kimi'
  | 'gemini'
  | 'qwen'
  | 'doubao'
  | 'openai-compatible';

export interface LlmRuntimeConfig {
  provider: LlmProvider;
  model: string;
  apiKey: string;
  baseUrl: string;
  chatCompletionsUrl: string;
  extraBody: Record<string, unknown>;
}

export interface LlmRuntimeTraceConfig {
  provider: LlmProvider;
  modelEnvName: string;
  model: string;
  thinkingEnabledEnvName: string;
  thinkingEnabled: boolean;
  reasoningEffortEnvName: string;
  reasoningEffort: string | null;
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
const DOUBAO_REASONING_EFFORTS = ['low', 'medium', 'high'] as const;
type DoubaoReasoningEffort = (typeof DOUBAO_REASONING_EFFORTS)[number];
const DOUBAO_DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

function normalizeModelName(model: string) {
  return model.trim().toLowerCase();
}

function normalizeProviderName(provider: string | undefined): LlmProvider | null {
  const normalizedProvider = provider?.trim().toLowerCase();

  if (
    normalizedProvider === 'gemini' ||
    normalizedProvider === 'qwen' ||
    normalizedProvider === 'kimi' ||
    normalizedProvider === 'doubao' ||
    normalizedProvider === 'openai-compatible'
  ) {
    return normalizedProvider;
  }

  return null;
}

function detectProvider(model: string): LlmProvider {
  const normalizedModel = normalizeModelName(model);

  if (normalizedModel.startsWith('gemini-')) {
    return 'gemini';
  }

  if (normalizedModel.startsWith('qwen')) {
    return 'qwen';
  }

  if (normalizedModel.startsWith('doubao-')) {
    return 'doubao';
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

function getOptionalRoleBaseUrl(role: LlmRole) {
  return getOptionalEnv(
    role === 'text' ? 'TEXT_LLM_BASE_URL' : 'VISION_LLM_BASE_URL',
  );
}

function getRoleModel(role: LlmRole) {
  return role === 'text' ? getTextLlmModel() : getVisionLlmModel();
}

function getRoleModelEnvName(role: LlmRole) {
  return role === 'text' ? 'TEXT_LLM_MODEL' : 'VISION_LLM_MODEL';
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

function getRoleProviderEnvName(role: LlmRole) {
  return role === 'text' ? 'TEXT_LLM_PROVIDER' : 'VISION_LLM_PROVIDER';
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

  if (provider === 'qwen') {
    return (
      getOptionalEnv('QWEN_API_KEY') ??
      getOptionalEnv('DASHSCOPE_API_KEY') ??
      getRoleApiKey(role)
    );
  }

  if (provider === 'doubao') {
    return (
      getOptionalEnv('DOUBAO_API_KEY') ??
      getOptionalEnv('ARK_API_KEY') ??
      getOptionalEnv('VOLCENGINE_API_KEY') ??
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

  if (provider === 'qwen') {
    return (
      getOptionalEnv('QWEN_BASE_URL') ??
      getOptionalEnv('DASHSCOPE_BASE_URL') ??
      getOptionalRoleBaseUrl(role) ??
      'https://dashscope.aliyuncs.com/compatible-mode/v1'
    );
  }

  if (provider === 'doubao') {
    return (
      getOptionalEnv('DOUBAO_BASE_URL') ??
      getOptionalEnv('ARK_BASE_URL') ??
      getOptionalEnv('VOLCENGINE_BASE_URL') ??
      getOptionalRoleBaseUrl(role) ??
      DOUBAO_DEFAULT_BASE_URL
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

function getDoubaoReasoningEffort(role: LlmRole): DoubaoReasoningEffort {
  const rawValue =
    getOptionalEnv(getRoleReasoningEffortEnvName(role)) ?? 'medium';
  const normalizedValue = rawValue.trim().toLowerCase();

  if (
    DOUBAO_REASONING_EFFORTS.includes(
      normalizedValue as DoubaoReasoningEffort,
    )
  ) {
    return normalizedValue as DoubaoReasoningEffort;
  }

  throw new Error(
    `${getRoleReasoningEffortEnvName(role)} must be one of: ${DOUBAO_REASONING_EFFORTS.join(', ')} for doubao models.`,
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

  if (provider === 'qwen') {
    return {
      enable_thinking: Boolean(thinkingEnabled),
    };
  }

  if (provider === 'doubao' && thinkingEnabled) {
    return {
      reasoning_effort: getDoubaoReasoningEffort(role),
    };
  }

  return {};
}

export function getLlmRuntimeConfig(role: LlmRole): LlmRuntimeConfig {
  const model = getRoleModel(role);
  const provider =
    normalizeProviderName(getOptionalEnv(getRoleProviderEnvName(role))) ??
    detectProvider(model);
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

export function getLlmRuntimeTraceConfig(role: LlmRole): LlmRuntimeTraceConfig {
  const config = getLlmRuntimeConfig(role);

  return {
    provider: config.provider,
    modelEnvName: getRoleModelEnvName(role),
    model: config.model,
    thinkingEnabledEnvName: getRoleThinkingEnabledEnvName(role),
    thinkingEnabled: getRoleThinkingEnabled(role),
    reasoningEffortEnvName: getRoleReasoningEffortEnvName(role),
    reasoningEffort: getOptionalEnv(getRoleReasoningEffortEnvName(role)) ?? null,
    extraBody: config.extraBody,
  };
}

export function buildChatCompletionHeaders(config: LlmRuntimeConfig) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
  };

  if (config.provider === 'doubao') {
    headers['ark-beta-image-process'] = 'true';
  }

  return headers;
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
            | {
                type: 'gemini_file';
                gemini_file: {
                  uri: string;
                  name?: string | null;
                  mime_type?: string | null;
                  mimeType?: string | null;
                  size_bytes?: number | null;
                  display_name?: string | null;
                };
              }
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
