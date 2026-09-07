# 02 — Previews, OG Images & SEO

**Parent:** Phase 4 README · **Covers:** ROADMAP §7.4 hover preview, §11 screenshots/OG

## Objective
Hover preview proves traffic value; element pages capture `carbon element startup` search intent.

## Screenshot job
- [ ] On `Payment.paid`: enqueue job (QStash/cron) → Microlink/ScreenshotOne `https://shot?url=` → store `Startup.previewImgUrl` (R2/S3) within 24h; retry x3, fallback favicon
- [ ] HoverPreview: `img` 16:9 lazy, `onError` → favicon; prefetch on row hover debounce 150ms
- [ ] Backfill script for existing stakes

## OG + element pages
- [ ] `/og/[sym].png` (next/og): navy bg, tile large, `#1 domain $price`, `periodictable.lol`
- [ ] `/elements/[sym]` static-ish page (ISR 60s): H1 `{Name} ({Symbol}) — startups on the table`, rank table, CTA deep-links to `/?element=C` (opens drawer), canonical + JSON-LD `ItemList`
- [ ] Sitemap: 122 element URLs + homepage; `robots.txt` allow

## Acceptance
- [ ] New claim → preview image appears ≤24h without deploy
- [ ] `curl /elements/C` contains H1 + rank rows + OG meta; Lighthouse SEO 100

## Files
- `lib/screenshots.ts`, `app/api/jobs/screenshot/route.ts`, `app/og/[sym]/route.tsx`, `app/elements/[sym]/page.tsx`
