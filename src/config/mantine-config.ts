import type { MantineThemeOverride } from '@mantine/core';

export const MantineThemeConfig: MantineThemeOverride = {
  fontFamily:
    '"Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", ui-sans-serif, sans-serif',
  primaryColor: 'teal',
  cursorType: 'pointer',
  defaultRadius: 'xl',
  components: {
    Container: {
      defaultProps: {
        size: 'xl',
      },
    },
  },
};
