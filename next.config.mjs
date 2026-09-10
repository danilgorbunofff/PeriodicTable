/** @type {import('next').NextConfig} */
const csp = [
  "default-src 'self'",
  // Next.js hydration needs inline scripts; third parties are allowlisted by
  // host. No nonce plumbing yet — script-src stays explicit, everything else
  // is locked down (Phase 6, shared abuse controls item 5).
  "script-src 'self' 'unsafe-inline' https://plausible.io https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  // s2/favicons 302-redirects to t*.gstatic.com/faviconV2 — the redirect
  // target must also be allowlisted or Chrome blocks the image entirely.
  // Microlink: api.microlink.io serves live shots, iad.microlink.io serves the
  // cached ones we store, so the wildcard covers both.
  "img-src 'self' data: https://*.microlink.io https://www.google.com https://*.gstatic.com",
  "connect-src 'self' https://plausible.io",
  "frame-src https://challenges.cloudflare.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ");

const nextConfig = {
  async headers() {
    // CSP is production-only: webpack dev uses eval() for HMR, which a
    // script-src without 'unsafe-eval' would kill. Production builds use
    // static chunks, so the policy below holds exactly where it matters.
    // Structural headers apply everywhere (harmless in dev).
    const security = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      // Ignored by browsers over plain http (local dev); enforced in prod.
      { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
    ];
    if (process.env.NODE_ENV === "production") {
      security.push({ key: "Content-Security-Policy", value: csp });
    }
    return [{ source: "/:path*", headers: security }];
  },
};

export default nextConfig;
