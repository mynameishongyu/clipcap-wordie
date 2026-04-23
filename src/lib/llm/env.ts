function getRequiredEnv(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is not configured`);
  }

  return value;
}

export function getTextLlmApiKey() {
  return getRequiredEnv('TEXT_LLM_API_KEY');
}

export function getTextLlmBaseUrl() {
  return getRequiredEnv('TEXT_LLM_BASE_URL');
}

export function getTextLlmModel() {
  return getRequiredEnv('TEXT_LLM_MODEL');
}

export function getVisionLlmApiKey() {
  return getRequiredEnv('VISION_LLM_API_KEY');
}

export function getVisionLlmBaseUrl() {
  return getRequiredEnv('VISION_LLM_BASE_URL');
}

export function getVisionLlmModel() {
  return getRequiredEnv('VISION_LLM_MODEL');
}
