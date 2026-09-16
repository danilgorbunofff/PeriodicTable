/* The analytics consent gate (R18-13).
 *
 * Doc 18 §3.9/§5.6 found the switch and the script were the same thing: setting
 * `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` served a third-party script to every visitor,
 * with no gate and no notice in the served HTML. Configuring a vendor is a
 * deployment decision; collecting from a visitor is a different decision, and
 * the code now has to make both before anything is sent.
 *
 * So there are two conditions, and this module is the only place they are
 * combined:
 *   1. the deployment configured a domain (`analyticsDomain`), and
 *   2. this browser recorded an explicit "granted" (`readAnalyticsConsent`).
 *
 * Deliberately dependency-free and DOM-light: it is imported by a client
 * component, by `lib/analytics.ts` on every funnel event, and by the suite in a
 * node environment, so nothing here may touch `window`, `document` or
 * `process.env` except through an argument with a working default.
 *
 * Every failure mode is closed. Unreadable storage, corrupt JSON, an unknown
 * schema version, a storage that throws on write: the visitor is treated as
 * un-asked, and un-asked means no script and no events. A consent gate that
 * fails open is a disclosure, not a gate.
 */

/** The third-party script. One constant so the privacy page, the banner and the
 * injector cannot describe three different vendors. */
export const ANALYTICS_SCRIPT_URL = "https://plausible.io/js/script.js";
export const ANALYTICS_SCRIPT_ID = "plausible-analytics";

/** The stored choice. Versioned, because the meaning of "granted" can change
 * (a new vendor, a new category) and an old record must not silently satisfy a
 * new question. */
export const ANALYTICS_CONSENT_KEY = "ptl:analytics-consent";
export const ANALYTICS_CONSENT_VERSION = 1;

export type AnalyticsConsentChoice = "granted" | "denied";

/** The minimum of the Web Storage API this needs — declared structurally so the
 * suite can pass a fake, and so the module does not depend on the DOM lib. */
export type ConsentStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

type ConsentRecord = {
  v: number;
  choice: AnalyticsConsentChoice;
  at: string;
};

/** The deployment's Plausible domain, or null when analytics is unconfigured.
 * Trimmed: a whitespace-only variable is a misconfiguration, not a domain, and
 * it must leave analytics off rather than inject an empty `data-domain`. */
export function analyticsDomain(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN;
  const domain = typeof raw === "string" ? raw.trim() : "";
  return domain.length > 0 ? domain : null;
}

/** `localStorage`, or null where it is unavailable (server render, Safari
 * private mode, a sandboxed iframe, a browser that blocks storage). Reading the
 * property itself can throw, so the access is inside the try. */
function defaultStorage(): ConsentStorage | null {
  try {
    const store = (globalThis as { localStorage?: ConsentStorage }).localStorage;
    return store ?? null;
  } catch {
    return null;
  }
}

function isChoice(value: unknown): value is AnalyticsConsentChoice {
  return value === "granted" || value === "denied";
}

/** The recorded choice, or null when this browser has never answered. Anything
 * unparseable — old schema, hand-edited value, truncated write — reads as null,
 * which is the same state as never asked. */
export function readAnalyticsConsent(
  storage: ConsentStorage | null = defaultStorage(),
): AnalyticsConsentChoice | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(ANALYTICS_CONSENT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Partial<ConsentRecord>;
    if (record.v !== ANALYTICS_CONSENT_VERSION) return null;
    return isChoice(record.choice) ? record.choice : null;
  } catch {
    return null;
  }
}

/** Records the visitor's answer. Returns false when it could not be stored (the
 * caller must then not treat the answer as durable): a choice that does not
 * survive a reload would ask again, or worse, be taken for a grant that was
 * never given. */
export function writeAnalyticsConsent(
  choice: AnalyticsConsentChoice,
  storage: ConsentStorage | null = defaultStorage(),
): boolean {
  if (!storage) return false;
  const record: ConsentRecord = {
    v: ANALYTICS_CONSENT_VERSION,
    choice,
    at: new Date().toISOString(),
  };
  try {
    storage.setItem(ANALYTICS_CONSENT_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/** Both conditions, in one place. `lib/analytics.ts` calls this before every
 * event and `components/AnalyticsConsent.tsx` calls it before injecting the
 * script, so "the script is not loaded" and "no event is sent" cannot disagree. */
export function analyticsAllowed(
  env: Record<string, string | undefined> = process.env,
  storage: ConsentStorage | null = defaultStorage(),
): boolean {
  if (!analyticsDomain(env)) return false;
  return readAnalyticsConsent(storage) === "granted";
}

/** The injector the banner calls once the visitor accepts. It is a function
 * rather than a `<script>` element rendered from state for the reason the gate
 * exists: a script element in the tree is fetched by the browser whether or not
 * React would have preferred otherwise, whereas this runs only after a stored
 * grant. Idempotent — a remount must not load the script twice. */
export function ensureAnalyticsScript(
  domain: string | null,
  doc: Document | null = typeof document === "undefined" ? null : document,
): boolean {
  if (!domain || !doc) return false;
  if (doc.getElementById(ANALYTICS_SCRIPT_ID)) return true;
  const script = doc.createElement("script");
  script.id = ANALYTICS_SCRIPT_ID;
  script.defer = true;
  script.setAttribute("data-domain", domain);
  script.src = ANALYTICS_SCRIPT_URL;
  (doc.head ?? doc.body).appendChild(script);
  return true;
}
