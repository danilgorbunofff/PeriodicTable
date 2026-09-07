/** Normalize a user URL: add https:// if missing, lowercase host. Returns null if unusable. */
export function normalizeUrl(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname.includes(".")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Derive the canonical identity domain from a URL. */
export function domainFromUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return host || null;
  } catch {
    return null;
  }
}

export function domainFromSocial(handle: string): string {
  const h = handle.trim().replace(/^@/, "").toLowerCase();
  return h ? h + ".social" : "";
}

const BLOCKED_DOMAINS = ["localhost", "127.0.0.1", "0.0.0.0", "example.com", "periodictable.lol"];

export function isBlockedDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return BLOCKED_DOMAINS.some((b) => d === b || d.endsWith("." + b));
}

export type CheckoutInputResult =
  | { ok: true; url: string; domain: string; title: string; pitch: string; linkType: "product" | "social" }
  | { ok: false; error: string; field?: "url" | "title" | "pitch" };

/** Full checkout input validation — mirrors spec 01-checkout-flow.md. */
export function validateCheckoutInput(input: {
  url?: string;
  linkType?: string;
  title?: string;
  pitch?: string;
}): CheckoutInputResult {
  const linkType = input.linkType === "social" ? "social" : "product";

  const title = (input.title ?? "").trim();
  if (title.length < 2) return { ok: false, error: "Name must be at least 2 characters.", field: "title" };
  if (title.length > 32) return { ok: false, error: "Name must be 32 characters max.", field: "title" };

  const pitch = (input.pitch ?? "").trim();
  if (pitch.length < 2) return { ok: false, error: "Pitch must be at least 2 characters.", field: "pitch" };
  if (pitch.length > 140) return { ok: false, error: "Pitch must be 140 characters max.", field: "pitch" };

  if (linkType === "social") {
    const handle = (input.url ?? "").trim().replace(/^@/, "");
    if (!/^[a-zA-Z0-9._]{2,30}$/.test(handle))
      return { ok: false, error: "Enter a valid @handle (letters, numbers, dots, underscores).", field: "url" };
    const domain = domainFromSocial(handle);
    if (!domain || isBlockedDomain(domain))
      return { ok: false, error: "Enter a valid @handle.", field: "url" };
    return { ok: true, url: `https://x.com/${handle}`, domain, title, pitch, linkType };
  }

  const url = normalizeUrl(input.url ?? "");
  if (!url) return { ok: false, error: "Enter a full URL starting with https://", field: "url" };
  const domain = domainFromUrl(url);
  if (!domain) return { ok: false, error: "Enter a full URL starting with https://", field: "url" };
  if (isBlockedDomain(domain)) return { ok: false, error: "That domain is not allowed.", field: "url" };
  return { ok: true, url, domain, title, pitch, linkType };
}
