/** Normalize a user URL: add https:// if missing, lowercase host. Returns null if unusable. */
export function normalizeUrl(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null; // credentials in URLs are never legitimate listings
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!isPublicHost(host)) return null;
  u.hostname = host;
  return u.toString();
}

/** Suffixes that must never be fetched/stored: cloud metadata, internal DNS,
 * and wildcard-DNS helpers that resolve to private IPs (nip.io/xip.io/sslip). */
const BLOCKED_HOST_SUFFIXES = [
  "metadata.google.internal",
  "metadata.google.com",
  "instance-data.compute.internal",
  "metadata.azure.internal",
  "metadata.aws.internal",
  "nip.io",
  "xip.io",
  "sslip.io",
  "local",
  "internal",
  "intranet",
  "invalid",
];

/** True for public DNS names only: no IPs (any notation), no localhost, no
 * private/link-local ranges, no metadata endpoints, no wildcard-DNS helpers.
 * SSRF-adjacent inputs (preview fetcher, logo proxy) must never receive these. */
export function isPublicHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (!h || !h.includes(".")) return false;
  if (h === "localhost") return false;
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (h === suffix || h.endsWith("." + suffix)) return false;
  }
  if (h.startsWith("metadata.")) return false;
  if (h.startsWith("instance-data.")) return false;
  // IPv4 dotted (incl. obfuscated all-numeric forms like 2130706433-style
  // dotted quads and octal/hex labels) + IPv6 literals.
  // Numeric/obfuscated hosts (dotted quads incl. octal/hex labels, IPv6
  // literals): listings must be DNS names, never raw IPs.
  const labels = h.split(".");
  if (labels.every((l) => /^[0-9]+$/.test(l) || /^0x[0-9a-f]+$/i.test(l))) return false;
  if (h.includes(":")) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return false;
  return true;
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
    // Accept a raw handle ("@foo", "foo") or the client's URL form
    // ("https://foo.social") — the server derives canonical identity either way.
    let handle = (input.url ?? "").trim().replace(/^@/, "");
    const socialUrl = handle.match(/^https?:\/\/([a-zA-Z0-9._]+)\.social\/?$/i);
    if (socialUrl) handle = socialUrl[1];
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

export type ProfileInputResult =
  | { ok: true; url: string; domain: string; title: string; pitch: string; linkType: "product" | "social" }
  | { ok: false; error: string; field?: "url" | "title" | "pitch" | "email" | "logoUrl" };

/**
 * Verified-owner profile update validation (Phase 1 management sessions).
 * Same field rules as checkout, minus amounts — plus email + logoUrl.
 */
export function validateProfileInput(input: {
  url?: string;
  linkType?: string;
  title?: string;
  pitch?: string;
  email?: string | null;
  logoUrl?: string;
}): ProfileInputResult {
  const base = validateCheckoutInput({
    url: input.url,
    linkType: input.linkType,
    title: input.title,
    pitch: input.pitch,
  });
  if (!base.ok) return base;
  if (input.email != null && input.email !== "") {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email.trim())) {
      return { ok: false, error: "That email doesn't look right.", field: "email" };
    }
  }
  if (input.logoUrl != null && input.logoUrl !== "") {
    if (!normalizeUrl(input.logoUrl)) {
      return { ok: false, error: "Logo must be a full https:// URL.", field: "logoUrl" };
    }
  }
  return base;
}
