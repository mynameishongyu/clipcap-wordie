import type { Metadata } from 'next';

export const siteName = 'ClipCap Word';
export const siteUrl = new URL('https://clipcap-word.local');
export const defaultSiteTitle = 'ClipCap Word | 文档抽取工作台';
export const defaultSiteDescription =
  '上传 DOCX 模板识别槽位，再上传 PDF 抽取内容并自动回填。';

export const siteMetadata: Metadata = {
  metadataBase: siteUrl,
  applicationName: siteName,
  title: {
    default: defaultSiteTitle,
    template: `%s | ${siteName}`,
  },
  description: defaultSiteDescription,
};
