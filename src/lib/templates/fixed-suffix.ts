type FixedSuffixGroup = {
  replacementSuffixes: string[];
  followingPrefixes: string[];
};

const FIXED_SUFFIX_GROUPS: FixedSuffixGroup[] = [
  {
    replacementSuffixes: ['%', '％'],
    followingPrefixes: ['%', '％'],
  },
  {
    replacementSuffixes: ['万元'],
    followingPrefixes: ['万元'],
  },
  {
    replacementSuffixes: ['元'],
    followingPrefixes: ['元'],
  },
  {
    replacementSuffixes: ['族'],
    followingPrefixes: ['族'],
  },
];

function stripReplacementSuffix(value: string, suffixes: string[]) {
  for (const suffix of suffixes) {
    if (!value.endsWith(suffix)) {
      continue;
    }

    const nextValue = value.slice(0, -suffix.length).trimEnd();

    if (nextValue.length > 0) {
      return nextValue;
    }
  }

  return value;
}

export function removeDuplicateFixedSuffixFromReplacement(input: {
  replacementValue: string;
  followingText: string;
}) {
  let nextValue = input.replacementValue.trim();
  const followingText = input.followingText.trimStart();

  for (const group of FIXED_SUFFIX_GROUPS) {
    const hasMatchingFollowingSuffix = group.followingPrefixes.some((prefix) =>
      followingText.startsWith(prefix),
    );

    if (!hasMatchingFollowingSuffix) {
      continue;
    }

    nextValue = stripReplacementSuffix(nextValue, group.replacementSuffixes);
  }

  return nextValue;
}

export function removeTemplateFixedSuffixFromValue(input: {
  value: string;
  templateOriginalValue?: string | null;
  templateContext?: string | null;
}) {
  const value = input.value.trim();
  const templateOriginalValue = input.templateOriginalValue?.trim() ?? '';
  const templateContext = input.templateContext?.trim() ?? '';

  if (!value || !templateOriginalValue || !templateContext) {
    return value;
  }

  const originalValueIndex = templateContext.indexOf(templateOriginalValue);

  if (originalValueIndex < 0) {
    return value;
  }

  return removeDuplicateFixedSuffixFromReplacement({
    replacementValue: value,
    followingText: templateContext.slice(
      originalValueIndex + templateOriginalValue.length,
    ),
  });
}
