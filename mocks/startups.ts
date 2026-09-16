/* Dev-seed fixtures (prisma/seed.ts). The inventory mirrors
   prisma/launch-seed.ts: one seat per element, three elements per holder, all
   at the $5 floor (`MIN_STAKE`), no clicks and no city — a seat nobody bought
   has not sent traffic and did not tell us where it is. Kept as a literal list
   rather than imported from the seeder so `npm run seed` reads as fixture data;
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
  ["stripe.com", "Stripe", "Payments infrastructure for the internet.", "C", "Carbon", 1],
  ["stripe.com", "Stripe", "Payments infrastructure for the internet.", "Ne", "Neon", 21],
  ["stripe.com", "Stripe", "Payments infrastructure for the internet.", "Ti", "Titanium", 33],
  ["coinbase.com", "Coinbase", "The easiest place to buy and sell crypto.", "Au", "Gold", 3],
  ["coinbase.com", "Coinbase", "The easiest place to buy and sell crypto.", "Ag", "Silver", 13],
  ["coinbase.com", "Coinbase", "The easiest place to buy and sell crypto.", "Cu", "Copper", 25],
  ["nvidia.com", "NVIDIA", "Accelerated computing for the AI era.", "Si", "Silicon", 5],
  ["nvidia.com", "NVIDIA", "Accelerated computing for the AI era.", "B", "Boron", 17],
  ["nvidia.com", "NVIDIA", "Accelerated computing for the AI era.", "Ga", "Gallium", 29],
  ["cloudflare.com", "Cloudflare", "The connectivity cloud for a faster internet.", "H", "Hydrogen", 7],
  ["cloudflare.com", "Cloudflare", "The connectivity cloud for a faster internet.", "He", "Helium", 19],
  ["cloudflare.com", "Cloudflare", "The connectivity cloud for a faster internet.", "O", "Oxygen", 27],
  ["supabase.com", "Supabase", "Open source Postgres at the edge.", "Fe", "Iron", 9],
  ["supabase.com", "Supabase", "Open source Postgres at the edge.", "Co", "Cobalt", 23],
  ["supabase.com", "Supabase", "Open source Postgres at the edge.", "Ni", "Nickel", 31],
  ["anthropic.com", "Anthropic", "AI safety and research.", "DM", "Dark Matter", 11],
  ["anthropic.com", "Anthropic", "AI safety and research.", "U", "Uranium", 15],
  ["anthropic.com", "Anthropic", "AI safety and research.", "Pu", "Plutonium", 35],
];

export const MOCK_STAKES: MockStake[] = SEATS.map(
  ([domain, title, pitch, symbol, elementName, hoursAgo]) => ({
    domain,
    title,
    pitch,
    symbol,
    elementName,
    amount: SEAT_USD,
    logo: faviconFor(domain, 64),
    ts: NOW - hoursAgo * H,
    clicks: 0,
    firstClaim: true,
  }),
);

export const MOCK_ORDER = ["coinbase.com", "anthropic.com", "stripe.com", "nvidia.com", "supabase.com", "cloudflare.com"];

export const MOCK_ACTIVITY = MOCK_STAKES.slice(0, 6);
