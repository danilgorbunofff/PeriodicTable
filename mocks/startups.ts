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

export const MOCK_STAKES: MockStake[] = [
  { domain: "stripe.com", title: "Stripe", pitch: "Payments infrastructure for the internet.", symbol: "C", elementName: "Carbon", amount: 50, logo: "https://www.google.com/s2/favicons?domain=stripe.com&sz=64", ts: NOW - 1 * H, clicks: 267, city: "Berlin", firstClaim: true },
  { domain: "coinbase.com", title: "Coinbase", pitch: "The easiest place to buy and sell crypto.", symbol: "Au", elementName: "Gold", amount: 88, logo: "https://www.google.com/s2/favicons?domain=coinbase.com&sz=64", ts: NOW - 3 * H, clicks: 412, city: "Singapore", firstClaim: true },
  { domain: "nvidia.com", title: "NVIDIA", pitch: "Accelerated computing for the AI era.", symbol: "Si", elementName: "Silicon", amount: 34, logo: "https://www.google.com/s2/favicons?domain=nvidia.com&sz=64", ts: NOW - 5 * H, clicks: 98, city: "Prague", firstClaim: true },
  { domain: "cloudflare.com", title: "Cloudflare", pitch: "The connectivity cloud for a faster internet.", symbol: "H", elementName: "Cloudflaregen", amount: 12, logo: "https://www.google.com/s2/favicons?domain=cloudflare.com&sz=64", ts: NOW - 8 * H, clicks: 41, city: "Austin", firstClaim: true },
  { domain: "supabase.com", title: "Supabase", pitch: "Open source Postgres at the edge.", symbol: "Fe", elementName: "Iron", amount: 21, logo: "https://www.google.com/s2/favicons?domain=supabase.com&sz=64", ts: NOW - 26 * H, clicks: 73, city: "Toronto", firstClaim: true },
  { domain: "anthropic.com", title: "Anthropic", pitch: "AI safety and research.", symbol: "DM", elementName: "Dark Matter", amount: 66, logo: "https://www.google.com/s2/favicons?domain=anthropic.com&sz=64", ts: NOW - 30 * H, clicks: 190, city: "Zurich", firstClaim: true },
  { domain: "adyen.com", title: "Adyen", pitch: "Second seat on carbon — climbing.", symbol: "C", elementName: "Carbon", amount: 31, logo: "https://www.google.com/s2/favicons?domain=adyen.com&sz=64", ts: NOW - 2 * H, clicks: 55, city: "Berlin" },
  { domain: "squareup.com", title: "Square", pitch: "Third seat, watching the crown.", symbol: "C", elementName: "Carbon", amount: 18, logo: "https://www.google.com/s2/favicons?domain=squareup.com&sz=64", ts: NOW - 20 * H, clicks: 12, city: "Oslo" },
  { domain: "stripe.com", title: "Stripe", pitch: "Payments infrastructure for the internet.", symbol: "Ti", elementName: "Titanium", amount: 17, logo: "https://www.google.com/s2/favicons?domain=stripe.com&sz=64", ts: NOW - 10 * H, clicks: 38 },
  { domain: "stripe.com", title: "Stripe", pitch: "Payments infrastructure for the internet.", symbol: "Ge", elementName: "Germanium", amount: 13, logo: "https://www.google.com/s2/favicons?domain=stripe.com&sz=64", ts: NOW - 16 * H, clicks: 29 },
  { domain: "stripe.com", title: "Stripe", pitch: "Payments infrastructure for the internet.", symbol: "Ne", elementName: "Neon", amount: 9, logo: "https://www.google.com/s2/favicons?domain=stripe.com&sz=64", ts: NOW - 22 * H, clicks: 21 },
  { domain: "coinbase.com", title: "Coinbase", pitch: "The easiest place to buy and sell crypto.", symbol: "Pt", elementName: "Platinum", amount: 42, logo: "https://www.google.com/s2/favicons?domain=coinbase.com&sz=64", ts: NOW - 7 * H, clicks: 84 },
  { domain: "coinbase.com", title: "Coinbase", pitch: "The easiest place to buy and sell crypto.", symbol: "Ag", elementName: "Silver", amount: 29, logo: "https://www.google.com/s2/favicons?domain=coinbase.com&sz=64", ts: NOW - 13 * H, clicks: 63 },
  { domain: "coinbase.com", title: "Coinbase", pitch: "The easiest place to buy and sell crypto.", symbol: "Cu", elementName: "Copper", amount: 18, logo: "https://www.google.com/s2/favicons?domain=coinbase.com&sz=64", ts: NOW - 19 * H, clicks: 47 },
  { domain: "nvidia.com", title: "NVIDIA", pitch: "Accelerated computing for the AI era.", symbol: "B", elementName: "Boron", amount: 19, logo: "https://www.google.com/s2/favicons?domain=nvidia.com&sz=64", ts: NOW - 9 * H, clicks: 52 },
  { domain: "nvidia.com", title: "NVIDIA", pitch: "Accelerated computing for the AI era.", symbol: "P", elementName: "Phosphorus", amount: 14, logo: "https://www.google.com/s2/favicons?domain=nvidia.com&sz=64", ts: NOW - 15 * H, clicks: 33 },
  { domain: "nvidia.com", title: "NVIDIA", pitch: "Accelerated computing for the AI era.", symbol: "Ga", elementName: "Gallium", amount: 11, logo: "https://www.google.com/s2/favicons?domain=nvidia.com&sz=64", ts: NOW - 23 * H, clicks: 24 },
  { domain: "cloudflare.com", title: "Cloudflare", pitch: "The connectivity cloud for a faster internet.", symbol: "O", elementName: "Oxygen", amount: 15, logo: "https://www.google.com/s2/favicons?domain=cloudflare.com&sz=64", ts: NOW - 11 * H, clicks: 46 },
  { domain: "cloudflare.com", title: "Cloudflare", pitch: "The connectivity cloud for a faster internet.", symbol: "He", elementName: "Helium", amount: 10, logo: "https://www.google.com/s2/favicons?domain=cloudflare.com&sz=64", ts: NOW - 18 * H, clicks: 28 },
  { domain: "cloudflare.com", title: "Cloudflare", pitch: "The connectivity cloud for a faster internet.", symbol: "N", elementName: "Nitrogen", amount: 8, logo: "https://www.google.com/s2/favicons?domain=cloudflare.com&sz=64", ts: NOW - 27 * H, clicks: 19 },
  { domain: "supabase.com", title: "Supabase", pitch: "Open source Postgres at the edge.", symbol: "Cr", elementName: "Chromium", amount: 16, logo: "https://www.google.com/s2/favicons?domain=supabase.com&sz=64", ts: NOW - 12 * H, clicks: 42 },
  { domain: "supabase.com", title: "Supabase", pitch: "Open source Postgres at the edge.", symbol: "Ni", elementName: "Nickel", amount: 13, logo: "https://www.google.com/s2/favicons?domain=supabase.com&sz=64", ts: NOW - 21 * H, clicks: 31 },
  { domain: "supabase.com", title: "Supabase", pitch: "Open source Postgres at the edge.", symbol: "Co", elementName: "Cobalt", amount: 10, logo: "https://www.google.com/s2/favicons?domain=supabase.com&sz=64", ts: NOW - 28 * H, clicks: 23 },
  { domain: "anthropic.com", title: "Anthropic", pitch: "AI safety and research.", symbol: "U", elementName: "Uranium", amount: 39, logo: "https://www.google.com/s2/favicons?domain=anthropic.com&sz=64", ts: NOW - 14 * H, clicks: 76 },
  { domain: "anthropic.com", title: "Anthropic", pitch: "AI safety and research.", symbol: "Pu", elementName: "Plutonium", amount: 25, logo: "https://www.google.com/s2/favicons?domain=anthropic.com&sz=64", ts: NOW - 24 * H, clicks: 49 },
  { domain: "anthropic.com", title: "Anthropic", pitch: "AI safety and research.", symbol: "Np", elementName: "Neptunium", amount: 16, logo: "https://www.google.com/s2/favicons?domain=anthropic.com&sz=64", ts: NOW - 32 * H, clicks: 37 },
];

export const MOCK_ORDER = ["coinbase.com", "anthropic.com", "stripe.com", "nvidia.com", "supabase.com", "cloudflare.com"];

export const MOCK_ACTIVITY = MOCK_STAKES.slice(0, 6);
