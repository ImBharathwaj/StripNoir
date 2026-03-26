import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Script from 'next/script';
import { Plus_Jakarta_Sans } from 'next/font/google';
import ClientShell from '../components/ClientShell';
import './globals.css';

const plusJakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-plus-jakarta',
  display: 'swap',
  weight: ['400', '500', '600', '700', '800']
});

export const metadata: Metadata = {
  title: 'StripNoir',
  description: 'Frontend'
};

const themeScript = `(function(){try{var k='stripnoir-theme';var t=localStorage.getItem(k);var r=document.documentElement;if(t==='light')r.classList.add('light');else if(t==='dark')r.classList.remove('light');else if(window.matchMedia('(prefers-color-scheme: light)').matches)r.classList.add('light');}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={plusJakarta.variable} suppressHydrationWarning>
      <body className={`${plusJakarta.className} min-h-full antialiased`}>
        <Script id="stripnoir-theme-init" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: themeScript }} />
        <ClientShell>{children}</ClientShell>
      </body>
    </html>
  );
}
