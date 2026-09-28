/* Dev-seed fixtures (prisma/seed.ts). The inventory mirrors
   prisma/launch-seed.ts: the site's own Pt seat plus the ten platforms this
   site is actually built on, one seat per element, all at the $5 floor
   (`MIN_STAKE`), no clicks and no city — a seat nobody bought has not sent
   traffic and did not tell us where it is. Kept as a literal list rather than
   imported from the seeder so `npm run seed` reads as fixture data;
   lib/launchInventory.ts is the allowlist both must agree with, and
   lib/launchInventory.test.ts pins that agreement. */
import { faviconFor } from "../lib/screenshots";

export type MockStake = {
  domain: string;
  title: string;
  pitch: string;
  symbol: string;
  elementName: string;
  amount: number;
  logo: string;
  ts: number;
  clicks: number;
  city?: string;
  firstClaim?: boolean;
};

const H = 3600_000;
const NOW = Date.now();
const SEAT_USD = 5;

type MockSeat = [domain: string, title: string, pitch: string, symbol: string, elementName: string, hoursAgo: number];

const SEATS: MockSeat[] = [
  ["periodictable.lol", "PeriodicTable.lol", "Put your startup on the table. Literally.", "Pt", "Platinum", 1],
  ["vercel.com", "Vercel", "Deploy and host the modern web.", "H", "Hydrogen", 2],
  ["nextjs.org", "Next.js", "The React framework for the web.", "N", "Nitrogen", 3],
  ["react.dev", "React", "The library for web and native user interfaces.", "Al", "Aluminium", 5],
  ["typescriptlang.org", "TypeScript", "JavaScript with syntax for types.", "Fe", "Iron", 7],
  ["prisma.io", "Prisma", "Type-safe database access for Node.js and TypeScript.", "Zr", "Zirconium", 9],
  ["neon.tech", "Neon", "Serverless Postgres with branching.", "Xe", "Xenon", 11],
  ["tailwindcss.com", "Tailwind CSS", "Utility-first CSS for rapid UI development.", "W", "Tungsten", 13],
  ["stripe.com", "Stripe", "Payments infrastructure for the internet.", "Pb", "Lead", 17],
  ["resend.com", "Resend", "Email API for developers.", "Rn", "Radon", 21],
  ["vitest.dev", "Vitest", "Next-generation testing framework.", "Og", "Oganesson", 25],
];

/* A local asset for a seat whose icon must not depend on the icon service: the
   site's own seat draws the app icon. Everything else goes through the proxy. */
const LOGO_OVERRIDES: Record<string, string> = { "periodictable.lol": "/icon.png" };

export const MOCK_STAKES: MockStake[] = SEATS.map(
  ([domain, title, pitch, symbol, elementName, hoursAgo]) => ({
    domain,
    title,
    pitch,
    symbol,
    elementName,
    amount: SEAT_USD,
    logo: LOGO_OVERRIDES[domain] ?? faviconFor(domain, 64),
    ts: NOW - hoursAgo * H,
    clicks: 0,
    firstClaim: true,
  }),
);

export const MOCK_ORDER = [
  "periodictable.lol",
  "vercel.com",
  "nextjs.org",
  "react.dev",
  "typescriptlang.org",
  "prisma.io",
  "neon.tech",
  "tailwindcss.com",
  "stripe.com",
  "resend.com",
  "vitest.dev",
];

export const MOCK_ACTIVITY = MOCK_STAKES.slice(0, 6);
