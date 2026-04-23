import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  getTextLlmApiKey,
  getTextLlmBaseUrl,
  getVisionLlmApiKey,
  getVisionLlmBaseUrl,
} from '@/src/lib/llm/env';

export function createTextLlmClient() {
  return createOpenAICompatible({
    apiKey: getTextLlmApiKey(),
    baseURL: getTextLlmBaseUrl(),
    name: 'text-llm',
    supportsStructuredOutputs: true,
  });
}

export function createVisionLlmClient() {
  return createOpenAICompatible({
    apiKey: getVisionLlmApiKey(),
    baseURL: getVisionLlmBaseUrl(),
    name: 'vision-llm',
    supportsStructuredOutputs: true,
  });
}
