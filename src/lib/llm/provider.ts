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
  reasoningEffortEnvName: string | null;
  reasoningEffort: string | null;
  extraBody: Record<string, unknown>;
}

export interface LlmRuntimeConfigOptions {
  reasoningEffortEnvName?: string;
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
  return role === 'text' ? 'TEXT_LLM_REASONING_EFFORT' : null;
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

function getReasoningEffortRawValue(
  role: LlmRole,
  options?: LlmRuntimeConfigOptions,
) {
  const roleReasoningEffortEnvName = getRoleReasoningEffortEnvName(role);

  return (
    (options?.reasoningEffortEnvName
      ? getOptionalEnv(options.reasoningEffortEnvName)
      : undefined) ??
    (roleReasoningEffortEnvName
      ? getOptionalEnv(roleReasoningEffortEnvName)
      : undefined) ??
    'medium'
  );
}

function getReasoningEffortEnvName(
  role: LlmRole,
  options?: LlmRuntimeConfigOptions,
) {
  return options?.reasoningEffortEnvName ?? getRoleReasoningEffortEnvName(role);
}

function getGeminiReasoningEffort(
  role: LlmRole,
  options?: LlmRuntimeConfigOptions,
): GeminiReasoningEffort {
  const rawValue = getReasoningEffortRawValue(role, options);
  const normalizedValue = rawValue.trim().toLowerCase();

  if (
    GEMINI_REASONING_EFFORTS.includes(normalizedValue as GeminiReasoningEffort)
  ) {
    return normalizedValue as GeminiReasoningEffort;
  }

  const envName = getReasoningEffortEnvName(role, options);
  throw new Error(
    `${envName ?? 'reasoning effort'} must be one of: ${GEMINI_REASONING_EFFORTS.join(', ')}.`,
  );
}

function getDoubaoReasoningEffort(
  role: LlmRole,
  options?: LlmRuntimeConfigOptions,
): DoubaoReasoningEffort {
  const rawValue = getReasoningEffortRawValue(role, options);
  const normalizedValue = rawValue.trim().toLowerCase();

  if (
    DOUBAO_REASONING_EFFORTS.includes(
      normalizedValue as DoubaoReasoningEffort,
    )
  ) {
    return normalizedValue as DoubaoReasoningEffort;
  }

  const envName = getReasoningEffortEnvName(role, options);
  throw new Error(
    `${envName ?? 'reasoning effort'} must be one of: ${DOUBAO_REASONING_EFFORTS.join(', ')} for doubao models.`,
  );
}

function getProviderExtraBody(
  role: LlmRole,
  provider: LlmProvider,
  model: string,
  options?: LlmRuntimeConfigOptions,
) {
  const normalizedModel = normalizeModelName(model);
  const thinkingEnabled = getRoleThinkingEnabled(role);

  if (provider === 'gemini') {
    return {
      reasoning_effort: thinkingEnabled
        ? getGeminiReasoningEffort(role, options)
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
      reasoning_effort: getDoubaoReasoningEffort(role, options),
    };
  }

  return {};
}

type ChatCompletionMessage = Parameters<typeof buildChatCompletionBody>[1]['messages'][number];

function convertGeminiFilePartForChatCompletions(
  part: Extract<ChatCompletionMessage['content'], unknown[]>[number],
) {
  if (part.type !== 'gemini_file') {
    return part;
  }

  return {
    type: 'image_url',
    image_url: {
      url: part.gemini_file.uri,
    },
  } as const;
}

function normalizeChatCompletionMessageForProvider(
  config: LlmRuntimeConfig,
  message: ChatCompletionMessage,
) {
  const providerAcceptsGeminiFileParts = config.provider === 'gemini';

  if (
    providerAcceptsGeminiFileParts ||
    !Array.isArray(message.content)
  ) {
    return message;
  }

  return {
    ...message,
    content: message.content.map(convertGeminiFilePartForChatCompletions),
  };
}

export function getLlmRuntimeConfig(
  role: LlmRole,
  options?: LlmRuntimeConfigOptions,
): LlmRuntimeConfig {
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
    extraBody: getProviderExtraBody(role, provider, model, options),
  };
}

export function getLlmRuntimeTraceConfig(
  role: LlmRole,
  options?: LlmRuntimeConfigOptions,
): LlmRuntimeTraceConfig {
  const config = getLlmRuntimeConfig(role, options);

  return {
    provider: config.provider,
    modelEnvName: getRoleModelEnvName(role),
    model: config.model,
    thinkingEnabledEnvName: getRoleThinkingEnabledEnvName(role),
    thinkingEnabled: getRoleThinkingEnabled(role),
    reasoningEffortEnvName: getReasoningEffortEnvName(role, options),
    reasoningEffort: getReasoningEffortRawValue(role, options),
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
  const messages = input.messages.map((message) =>
    normalizeChatCompletionMessageForProvider(config, message),
  );

  return {
    model: config.model,
    ...config.extraBody,
    messages,
  };
}
