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
  ["resend.com", "Resend", "Email API for developers.", "C", "Carbon", 1],
  ["resend.com", "Resend", "Email API for developers.", "Ne", "Neon", 21],
  ["resend.com", "Resend", "Email API for developers.", "Ti", "Titanium", 33],
  ["lemonsqueezy.com", "Lemon Squeezy", "Payments and merchant of record for indie software.", "Au", "Gold", 3],
  ["lemonsqueezy.com", "Lemon Squeezy", "Payments and merchant of record for indie software.", "Ag", "Silver", 13],
  ["lemonsqueezy.com", "Lemon Squeezy", "Payments and merchant of record for indie software.", "Cu", "Copper", 25],
  ["cal.com", "Cal.com", "Open-source scheduling infrastructure.", "Si", "Silicon", 5],
  ["cal.com", "Cal.com", "Open-source scheduling infrastructure.", "B", "Boron", 17],
  ["cal.com", "Cal.com", "Open-source scheduling infrastructure.", "Ga", "Gallium", 29],
  ["railway.app", "Railway", "Ship apps without wiring up the infrastructure.", "H", "Hydrogen", 7],
  ["railway.app", "Railway", "Ship apps without wiring up the infrastructure.", "He", "Helium", 19],
  ["railway.app", "Railway", "Ship apps without wiring up the infrastructure.", "O", "Oxygen", 27],
  ["neon.tech", "Neon", "Serverless Postgres with branching.", "Fe", "Iron", 9],
  ["neon.tech", "Neon", "Serverless Postgres with branching.", "Co", "Cobalt", 23],
  ["neon.tech", "Neon", "Serverless Postgres with branching.", "Ni", "Nickel", 31],
  ["replicate.com", "Replicate", "Run open-source models behind one API.", "DM", "Dark Matter", 11],
  ["replicate.com", "Replicate", "Run open-source models behind one API.", "U", "Uranium", 15],
  ["replicate.com", "Replicate", "Run open-source models behind one API.", "Pu", "Plutonium", 35],
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

export const MOCK_ORDER = ["lemonsqueezy.com", "replicate.com", "resend.com", "cal.com", "neon.tech", "railway.app"];

export const MOCK_ACTIVITY = MOCK_STAKES.slice(0, 6);
