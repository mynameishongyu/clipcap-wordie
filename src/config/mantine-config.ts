import type { MantineThemeOverride } from '@mantine/core';

export const MantineThemeConfig: MantineThemeOverride = {
  fontFamily:
    '"Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", ui-sans-serif, sans-serif',
  primaryColor: 'teal',
  cursorType: 'pointer',
  defaultRadius: 'xl',
  fontSizes: {
    xs: '0.625rem',
    sm: '0.6875rem',
    md: '0.75rem',
    lg: '0.8125rem',
    xl: '0.875rem',
  },
  components: {
    Container: {
      defaultProps: {
        size: 'xl',
      },
    },
  },
};
