import type { Metadata } from "next";
import { Fredoka, Nunito } from "next/font/google";
import { homeMetadata } from "@/lib/shareMeta";
import { analyticsDomain } from "@/lib/analyticsConsent";
import AnalyticsConsent from "@/components/AnalyticsConsent";
import ClientErrorReporter from "@/components/ClientErrorReporter";
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
  // R18-13: the domain is the deployment's switch, not the visitor's consent. A
  // configured domain renders the notice; the script is injected by the gate
  // only after a stored grant (`lib/analyticsConsent.ts`).
  const plausibleDomain = analyticsDomain();
  return (
    <html lang="en">
      <body className={`${display.variable} ${body.variable} font-sans antialiased`}>
        {plausibleDomain ? <AnalyticsConsent domain={plausibleDomain} /> : null}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[var(--z-skip)] focus:rounded-full focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-bold focus:text-ink focus:shadow-float"
        >
          Skip to main content
        </a>
        {children}
        <ClientErrorReporter />
      </body>
    </html>
  );
}
