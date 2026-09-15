import type { Metadata } from "next";
import { Fredoka, Nunito } from "next/font/google";
import { homeMetadata } from "@/lib/shareMeta";
import "./globals.css";

const display = Fredoka({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-display",
});

const body = Nunito({
  subsets: ["latin"],
  weight: ["600", "700", "800", "900"],
  variable: "--font-body",
});

export const metadata: Metadata = homeMetadata();

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const plausibleDomain = process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN;
  return (
    <html lang="en">
      <body className={`${display.variable} ${body.variable} font-sans antialiased`}>
        {plausibleDomain ? (
          <script defer data-domain={plausibleDomain} src="https://plausible.io/js/script.js" />
        ) : null}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[var(--z-skip)] focus:rounded-full focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-bold focus:text-ink focus:shadow-float"
        >
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
