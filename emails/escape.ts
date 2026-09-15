/** Minimal HTML-escape for values interpolated into mail bodies.
 *
 * The two intake templates (report, waitlist) print text a person supplied —
 * a free-text report reason, a submitted domain. The listing templates only
 * ever printed fields that had been through domainFromUrl; these cannot rely
 * on that, so they escape at the interpolation site.
 */
export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}