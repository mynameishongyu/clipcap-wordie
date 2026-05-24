export function stripJsonMarkdownFence(rawContent: string) {
  const trimmed = rawContent.trim();
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);

  return fencedMatch?.[1]?.trim() ?? trimmed;
}

export function extractFirstCompleteJsonValue(rawContent: string) {
  const content = stripJsonMarkdownFence(rawContent);
  const startIndex = content.search(/[\[{]/);

  if (startIndex < 0) {
    return content;
  }

  const stack: Array<'}' | ']'> = [];
  let inString = false;
  let escaping = false;

  for (let index = startIndex; index < content.length; index += 1) {
    const character = content[index]!;

    if (escaping) {
      escaping = false;
      continue;
    }

    if (character === '\\') {
      escaping = true;
      continue;
    }

    if (character === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (character === '{') {
      stack.push('}');
      continue;
    }

    if (character === '[') {
      stack.push(']');
      continue;
    }

    if (character !== '}' && character !== ']') {
      continue;
    }

    const expected = stack.at(-1);

    if (expected !== character) {
      continue;
    }

    stack.pop();

    if (stack.length === 0) {
      return content.slice(startIndex, index + 1);
    }
  }

  return content.slice(startIndex);
}

export function extractOuterJsonCandidate(rawContent: string) {
  const content = stripJsonMarkdownFence(rawContent);
  const firstObject = content.indexOf('{');
  const firstArray = content.indexOf('[');
  const firstIndex =
    firstObject < 0
      ? firstArray
      : firstArray < 0
        ? firstObject
        : Math.min(firstObject, firstArray);
  const lastObject = content.lastIndexOf('}');
  const lastArray = content.lastIndexOf(']');
  const lastIndex = Math.max(lastObject, lastArray);

  if (firstIndex < 0 || lastIndex <= firstIndex) {
    return content;
  }

  return content.slice(firstIndex, lastIndex + 1);
}

export function escapeControlCharactersInsideJsonStrings(rawJson: string) {
  let result = '';
  let inString = false;
  let escaping = false;

  for (let index = 0; index < rawJson.length; index += 1) {
    const char = rawJson[index]!;

    if (escaping) {
      result += char;
      escaping = false;
      continue;
    }

    if (char === '\\') {
      result += char;
      escaping = true;
      continue;
    }

    if (char === '"') {
      result += char;
      inString = !inString;
      continue;
    }

    if (inString) {
      if (char === '\n') {
        result += '\\n';
        continue;
      }

      if (char === '\r') {
        result += '\\r';
        continue;
      }

      if (char === '\t') {
        result += '\\t';
        continue;
      }

      const code = char.charCodeAt(0);

      if (code >= 0 && code <= 0x1f) {
        result += `\\u${code.toString(16).padStart(4, '0')}`;
        continue;
      }
    }

    result += char;
  }

  return result;
}

export function balanceJsonClosers(rawContent: string) {
  let inString = false;
  let escaping = false;
  const stack: Array<'}' | ']'> = [];

  for (const character of rawContent) {
    if (escaping) {
      escaping = false;
      continue;
    }

    if (character === '\\') {
      escaping = true;
      continue;
    }

    if (character === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (character === '{') {
      stack.push('}');
      continue;
    }

    if (character === '[') {
      stack.push(']');
      continue;
    }

    if (character === '}' || character === ']') {
      const expected = stack.at(-1);

      if (expected === character) {
        stack.pop();
      }
    }
  }

  const withoutDanglingSeparator = rawContent.replace(/[\s,\uFF0C]+$/u, '');

  return `${withoutDanglingSeparator}${stack.reverse().join('')}`;
}

function normalizeJsonPunctuation(rawJson: string) {
  return rawJson.replace(/\uFF0C/gu, ',').replace(/\uFF1A/gu, ':');
}

function removeTrailingCommas(rawJson: string) {
  return rawJson.replace(/,\s*([}\]])/gu, '$1');
}

export function buildJsonParseCandidates(rawContent: string) {
  const normalized = stripJsonMarkdownFence(rawContent);
  const firstComplete = extractFirstCompleteJsonValue(normalized);
  const outer = extractOuterJsonCandidate(normalized);
  const baseCandidates = [firstComplete, outer, normalized];
  const repairedCandidates = baseCandidates.flatMap((candidate) => {
    const normalizedPunctuation = normalizeJsonPunctuation(candidate);
    const withoutTrailingCommas = removeTrailingCommas(normalizedPunctuation);
    const escaped = escapeControlCharactersInsideJsonStrings(
      withoutTrailingCommas,
    );

    return [
      candidate,
      normalizedPunctuation,
      withoutTrailingCommas,
      escaped,
      balanceJsonClosers(escaped),
    ];
  });

  return Array.from(new Set(repairedCandidates.map((value) => value.trim())));
}

export function parseModelJsonOutput<T>(
  rawContent: string,
  options?: {
    context?: string;
    transformCandidate?: (candidate: string) => string;
  },
) {
  let lastError: unknown = null;
  const candidates = buildJsonParseCandidates(rawContent);

  for (const [candidateIndex, candidate] of candidates.entries()) {
    const transformed = options?.transformCandidate
      ? options.transformCandidate(candidate)
      : candidate;

    try {
      return {
        data: JSON.parse(transformed) as T,
        usedRepair: candidateIndex > 0 || transformed !== candidate,
      };
    } catch (error) {
      lastError = error;
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  const preview = extractFirstCompleteJsonValue(rawContent).slice(0, 240);
  const label = options?.context ?? 'Model JSON';

  throw new Error(`${label} parse failed: ${reason}. Snippet: ${preview}`);
}
