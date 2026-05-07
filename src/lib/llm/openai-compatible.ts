import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { getLlmRuntimeConfig } from '@/src/lib/llm/provider';

export function createTextLlmClient() {
  const config = getLlmRuntimeConfig('text');

  return createOpenAICompatible({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    name: 'text-llm',
    supportsStructuredOutputs: true,
  });
}

export function createVisionLlmClient() {
  const config = getLlmRuntimeConfig('vision');

  return createOpenAICompatible({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    name: 'vision-llm',
    supportsStructuredOutputs: true,
  });
}
