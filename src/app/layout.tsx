import { ColorSchemeScript, mantineHtmlProps } from '@mantine/core';
import { Noto_Sans_SC } from 'next/font/google';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import '@/src/styles/index.css';
import { siteMetadata } from '@/src/config/site-metadata';
import { AppProvider } from '@/src/providers/AppProvider';

const notoSansSc = Noto_Sans_SC({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
});

export const metadata = siteMetadata;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" {...mantineHtmlProps} className={notoSansSc.className}>
      <head>
        <ColorSchemeScript defaultColorScheme="dark" forceColorScheme="dark" />
      </head>
      <body>
        <AppProvider>{children}</AppProvider>
      </body>
    </html>
  );
}
