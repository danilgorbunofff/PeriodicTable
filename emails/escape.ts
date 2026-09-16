/** Minimal HTML-escape for values interpolated into mail bodies.
 *
 * The two intake templates (report, waitlist) print text a person supplied —
 * a free-text report reason, a submitted domain. The listing templates only
 * ever printed fields that had been through domainFromUrl; these cannot rely
 * on that, so they escape at the interpolation site.
 *
 * R14-4 states the channel rule, because "escape everything" is wrong here in
 * two places this module does not cover:
 *
 * - An `href` is not text. `lib/links.ts` and `lib/email.ts` build and encode
 *   those URLs at construction; entity-escaping one at the template would turn
 *   `&` into `&amp;` inside the query string and break the link, so the URL
 *   slots are deliberately raw (`lib/listingMail.test.ts` asserts the rendered
 *   link still equals the URL it was given).
 * - A subject is not HTML; it is a plain-text header. `esc()` is still the
 *   wrong function to call on one — a mailbox renders `&amp;` as five
 *   characters. Every subject value is an element constant or a hostname from
 *   `new URL().hostname`, a charset that cannot carry markup, and the *preview*
 *   route escapes the subject where it embeds it into a document
 *   (app/api/emails/preview/route.ts). If a deliberately permissive field ever
 *   needs to reach a subject, sanitise it at the write boundary and say so in
 *   the schema comment — do not wrap the subject builder in esc().
 */
export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}