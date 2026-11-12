import type { Metadata } from 'next';
import { DM_Sans, Noto_Serif } from 'next/font/google';
import './globals.css';

const dmSans = DM_Sans({
  subsets: ['latin'],
  variable: '--font-dm-sans',
  display: 'swap',
  axes: ['opsz'],
});

const notoSerif = Noto_Serif({
  subsets: ['latin'],
  variable: '--font-noto-serif',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Ken Research — Auth Redesign (Loop)',
  description: 'Loop Engineering Mode build workspace for the Ken Research auth flow redesign.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${dmSans.variable} ${notoSerif.variable}`} suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
