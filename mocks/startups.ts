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
  { domain: "acme.com", title: "Acme", pitch: "Instant infra for ambitious startups. Deploy in minutes, scale forever.", symbol: "C", elementName: "Carbon", amount: 50, logo: "https://www.google.com/s2/favicons?domain=acme.com&sz=64", ts: NOW - 1 * H, clicks: 267, city: "Berlin", firstClaim: true },
  { domain: "aurum.fi", title: "Aurum", pitch: "Gold-grade treasury for onchain teams.", symbol: "Au", elementName: "Gold", amount: 88, logo: "https://www.google.com/s2/favicons?domain=aurum.fi&sz=64", ts: NOW - 3 * H, clicks: 412, city: "Singapore", firstClaim: true },
  { domain: "waferly.io", title: "Waferly", pitch: "Chip-grade CI that never flakes.", symbol: "Si", elementName: "Silicon", amount: 34, logo: "https://www.google.com/s2/favicons?domain=waferly.io&sz=64", ts: NOW - 5 * H, clicks: 98, city: "Prague", firstClaim: true },
  { domain: "hydro.dev", title: "Hydro", pitch: "The lightest edge runtime.", symbol: "H", elementName: "Hydrogen", amount: 12, logo: "https://www.google.com/s2/favicons?domain=hydro.dev&sz=64", ts: NOW - 8 * H, clicks: 41, city: "Austin", firstClaim: true },
  { domain: "ferrous.cloud", title: "Ferrous", pitch: "Ironclad Postgres hosting.", symbol: "Fe", elementName: "Iron", amount: 21, logo: "https://www.google.com/s2/favicons?domain=ferrous.cloud&sz=64", ts: NOW - 26 * H, clicks: 73, city: "Toronto", firstClaim: true },
  { domain: "darkpool.gg", title: "Darkpool", pitch: "Stealth infra for funds that move quietly.", symbol: "DM", elementName: "Dark Matter", amount: 66, logo: "https://www.google.com/s2/favicons?domain=darkpool.gg&sz=64", ts: NOW - 30 * H, clicks: 190, city: "Zurich", firstClaim: true },
  { domain: "beta.acme.com", title: "Acme Beta", pitch: "Second seat on carbon — climbing.", symbol: "C", elementName: "Carbon", amount: 31, logo: "https://www.google.com/s2/favicons?domain=beta.acme.com&sz=64", ts: NOW - 2 * H, clicks: 55, city: "Berlin" },
  { domain: "gamma.tools", title: "Gamma", pitch: "Third seat, watching the crown.", symbol: "C", elementName: "Carbon", amount: 18, logo: "https://www.google.com/s2/favicons?domain=gamma.tools&sz=64", ts: NOW - 20 * H, clicks: 12, city: "Oslo" },
  { domain: "acme.com", title: "Acme", pitch: "Instant infra for ambitious startups.", symbol: "Ti", elementName: "Titanium", amount: 17, logo: "https://www.google.com/s2/favicons?domain=acme.com&sz=64", ts: NOW - 10 * H, clicks: 38 },
  { domain: "acme.com", title: "Acme", pitch: "Instant infra for ambitious startups.", symbol: "Ge", elementName: "Germanium", amount: 13, logo: "https://www.google.com/s2/favicons?domain=acme.com&sz=64", ts: NOW - 16 * H, clicks: 29 },
  { domain: "acme.com", title: "Acme", pitch: "Instant infra for ambitious startups.", symbol: "Ne", elementName: "Neon", amount: 9, logo: "https://www.google.com/s2/favicons?domain=acme.com&sz=64", ts: NOW - 22 * H, clicks: 21 },
  { domain: "aurum.fi", title: "Aurum", pitch: "Gold-grade treasury for onchain teams.", symbol: "Pt", elementName: "Platinum", amount: 42, logo: "https://www.google.com/s2/favicons?domain=aurum.fi&sz=64", ts: NOW - 7 * H, clicks: 84 },
  { domain: "aurum.fi", title: "Aurum", pitch: "Gold-grade treasury for onchain teams.", symbol: "Ag", elementName: "Silver", amount: 29, logo: "https://www.google.com/s2/favicons?domain=aurum.fi&sz=64", ts: NOW - 13 * H, clicks: 63 },
  { domain: "aurum.fi", title: "Aurum", pitch: "Gold-grade treasury for onchain teams.", symbol: "Cu", elementName: "Copper", amount: 18, logo: "https://www.google.com/s2/favicons?domain=aurum.fi&sz=64", ts: NOW - 19 * H, clicks: 47 },
  { domain: "waferly.io", title: "Waferly", pitch: "Chip-grade CI that never flakes.", symbol: "B", elementName: "Boron", amount: 19, logo: "https://www.google.com/s2/favicons?domain=waferly.io&sz=64", ts: NOW - 9 * H, clicks: 52 },
  { domain: "waferly.io", title: "Waferly", pitch: "Chip-grade CI that never flakes.", symbol: "P", elementName: "Phosphorus", amount: 14, logo: "https://www.google.com/s2/favicons?domain=waferly.io&sz=64", ts: NOW - 15 * H, clicks: 33 },
  { domain: "waferly.io", title: "Waferly", pitch: "Chip-grade CI that never flakes.", symbol: "Ga", elementName: "Gallium", amount: 11, logo: "https://www.google.com/s2/favicons?domain=waferly.io&sz=64", ts: NOW - 23 * H, clicks: 24 },
  { domain: "hydro.dev", title: "Hydro", pitch: "The lightest edge runtime.", symbol: "O", elementName: "Oxygen", amount: 15, logo: "https://www.google.com/s2/favicons?domain=hydro.dev&sz=64", ts: NOW - 11 * H, clicks: 46 },
  { domain: "hydro.dev", title: "Hydro", pitch: "The lightest edge runtime.", symbol: "He", elementName: "Helium", amount: 10, logo: "https://www.google.com/s2/favicons?domain=hydro.dev&sz=64", ts: NOW - 18 * H, clicks: 28 },
  { domain: "hydro.dev", title: "Hydro", pitch: "The lightest edge runtime.", symbol: "N", elementName: "Nitrogen", amount: 8, logo: "https://www.google.com/s2/favicons?domain=hydro.dev&sz=64", ts: NOW - 27 * H, clicks: 19 },
  { domain: "ferrous.cloud", title: "Ferrous", pitch: "Ironclad Postgres hosting.", symbol: "Cr", elementName: "Chromium", amount: 16, logo: "https://www.google.com/s2/favicons?domain=ferrous.cloud&sz=64", ts: NOW - 12 * H, clicks: 42 },
  { domain: "ferrous.cloud", title: "Ferrous", pitch: "Ironclad Postgres hosting.", symbol: "Ni", elementName: "Nickel", amount: 13, logo: "https://www.google.com/s2/favicons?domain=ferrous.cloud&sz=64", ts: NOW - 21 * H, clicks: 31 },
  { domain: "ferrous.cloud", title: "Ferrous", pitch: "Ironclad Postgres hosting.", symbol: "Co", elementName: "Cobalt", amount: 10, logo: "https://www.google.com/s2/favicons?domain=ferrous.cloud&sz=64", ts: NOW - 28 * H, clicks: 23 },
  { domain: "darkpool.gg", title: "Darkpool", pitch: "Stealth infra for funds that move quietly.", symbol: "U", elementName: "Uranium", amount: 39, logo: "https://www.google.com/s2/favicons?domain=darkpool.gg&sz=64", ts: NOW - 14 * H, clicks: 76 },
  { domain: "darkpool.gg", title: "Darkpool", pitch: "Stealth infra for funds that move quietly.", symbol: "Pu", elementName: "Plutonium", amount: 25, logo: "https://www.google.com/s2/favicons?domain=darkpool.gg&sz=64", ts: NOW - 24 * H, clicks: 49 },
  { domain: "darkpool.gg", title: "Darkpool", pitch: "Stealth infra for funds that move quietly.", symbol: "Np", elementName: "Neptunium", amount: 16, logo: "https://www.google.com/s2/favicons?domain=darkpool.gg&sz=64", ts: NOW - 32 * H, clicks: 37 },
];

export const MOCK_ORDER = ["aurum.fi", "darkpool.gg", "acme.com", "waferly.io", "ferrous.cloud", "hydro.dev"];

export const MOCK_ACTIVITY = MOCK_STAKES.slice(0, 6);
