import { isEmail } from "./validate";

/**
 * The claim form's two refusals, as pure functions (R06-1, R06-3, R06-4,
 * R06-5, R06-6, R06-7, R06-9).
 *
 * The modal needs a DOM to render and this repo has no DOM suite (U06-1), so
 * every decision the buyer sees is taken here: the gate that stops a submit
 * before a request is made — with the sentence that goes with it — and the
 * branch that turns a refused response into either a field message or the one
 * shared error line under the button.
 */

export type CheckoutTab = "url" | "social";

/** Fields the modal renders a message under (`co-<field>-error`). A server
 *  `field` outside this list would be set and never shown, so it has to fall
 *  back to the shared error line instead (R06-4). `attest` is on the list
 *  because the route refuses it twice — an unticked box, and a tab whose rules
 *  revision is stale (R16-7) — and both sentences belong on the checkbox the
 *  buyer has to touch, not on a line under the button. */
export const FIELD_RENDERERS = ["url", "title", "pitch", "email", "attest"] as const;

export function fieldHasRenderer(field: string): boolean {
  return (FIELD_RENDERERS as readonly string[]).includes(field);
}

export const CHECKOUT_MSG = {
  url: "Enter a full URL starting with https://",
  handle: "Enter a valid @handle (letters, numbers, dots, underscores).",
  email: "That email doesn't look right.",
  title: "Name must be 2–32 characters.",
  pitch: "Pitch must be 2–140 characters.",
  attest: "Please confirm you own or may promote this URL.",
  humanCheck: "The human check could not load — reload or use another network.",
  canceled:
    "Not paid — nothing was charged. Your claim is still here, and any take quote it held stays reserved for up to 15 minutes.",
} as const;

/** The server's `field:"url"` covers two rules — a product URL and a social
 *  handle — so the client's fallback sentence has to follow the tab the buyer
 *  is on (R06-5). */
export function urlMessage(tab: CheckoutTab): string {
  return tab === "url" ? CHECKOUT_MSG.url : CHECKOUT_MSG.handle;
}

function socialHandle(url: string): string {
  return `https://x.com/${url.replace(/^@/, "")}`;
}

export function urlShapeBad(tab: CheckoutTab, url: string): boolean {
  if (url.length === 0) return false;
  return !/^https?:\/\/.+\..+/.test(tab === "url" ? url : socialHandle(url));
}

export function emailShapeBad(email: string): boolean {
  return email.length > 0 && !isEmail(email);
}

export function titleShapeBad(title: string): boolean {
  return title.length > 0 && (title.trim().length < 2 || title.trim().length > 32);
}

export function pitchShapeBad(pitch: string): boolean {
  return pitch.length > 0 && (pitch.trim().length < 2 || pitch.trim().length > 140);
}

export type SubmitBlock = {
  /** Input to hang the sentence under, or null for the shared error line. */
  field: "url" | "email" | "title" | "pitch" | "attest" | null;
  message: string;
  /** True when the sentence is already on screen (the failed widget prints
   *  it), so the modal announces it instead of printing it a second time. */
  shown?: boolean;
};

/**
 * The one gate standing between this form and a request, with the sentence the
 * buyer gets for it — or null when nothing blocks. It never returns null and
 * silent: the modal used to `return` here with no text at all, so an untouched
 * form (or a handle typed without its `@`, which resolves no domain) produced
 * no request and no explanation (R06-1).
 */
export function submitBlocked(input: {
  tab: CheckoutTab;
  url: string;
  title: string;
  pitch: string;
  email: string;
  attest: boolean;
  /** The domain the form resolved, or null when it resolved none. */
  domain: string | null;
  /** The pricing preview's refusal (lib/pricing.ts classifyAndValidate). */
  clientErr: string | null;
  /** True once the Turnstile script failed to load (R06-6). */
  humanCheckFailed: boolean;
}): SubmitBlock | null {
  if (urlShapeBad(input.tab, input.url) || !input.domain) {
    return { field: "url", message: urlMessage(input.tab) };
  }
  if (emailShapeBad(input.email)) return { field: "email", message: CHECKOUT_MSG.email };
  // The name and the pitch are labelled `required` in the form and are the two
  // fields the server silently substitutes (the domain and "Staked on <element>")
  // when they arrive empty — so an empty one is refused here, with the sentence
  // the length rule already has, instead of being quietly invented for the
  // buyer (R06-1).
  if (input.title.trim().length === 0 || titleShapeBad(input.title)) {
    return { field: "title", message: CHECKOUT_MSG.title };
  }
  if (input.pitch.trim().length === 0 || pitchShapeBad(input.pitch)) {
    return { field: "pitch", message: CHECKOUT_MSG.pitch };
  }
  if (!input.attest) return { field: "attest", message: CHECKOUT_MSG.attest };
  if (input.humanCheckFailed) return { field: null, message: CHECKOUT_MSG.humanCheck, shown: true };
  if (input.clientErr) return { field: null, message: input.clientErr };
  return null;
}

export type CheckoutRefusal = {
  /** Sentence for the shared error line under the button. */
  serverErr: string | null;
  /** Sentence that belongs under one input, when that input has a renderer. */
  field: { field: string; message: string } | null;
  /** The live floor the server quoted, so the buyer can accept it (R06-3). */
  priceMoved: number | null;
};

/**
 * What a refused `/api/checkout` response means to the buyer.
 *
 * Only `PRICE_MOVED` came from a board that actually moved, so only it may
 * quote a new price; a floor or a tie states its rule instead of implying the
 * board moved under the buyer (R06-3). Any other `field` reaches the shared
 * line rather than vanishing into state with no node to render it (R06-4).
 */
export function checkoutRefusal(status: number, body: unknown): CheckoutRefusal {
  const json = (body ?? {}) as Record<string, unknown>;
  const error = typeof json.error === "string" ? json.error : null;
  const takeLead = typeof json.takeLead === "number" ? json.takeLead : null;
  if (status === 409 && json.code === "PRICE_MOVED" && takeLead != null) {
    return { serverErr: error ?? "Price moved. Review the new minimum.", field: null, priceMoved: takeLead };
  }
  if (json.code === "RESERVATION_CONFLICT" && typeof json.expiresAt === "string") {
    // R09-1: the hold is the answer, so it is stated with the amount it refuses
    // and the time it ends, and the rule text that used to collide with it (a
    // tie hint) is replaced by the amount that still lands underneath.
    const heldUntil = new Date(json.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const joinHint = typeof json.joinHint === "number" ? json.joinHint : null;
    const tail =
      joinHint != null
        ? ` A $${joinHint} bid still joins the ladder.`
        : json.joinBlocked === true
          ? " No amount lands until that hold ends."
          : "";
    return {
      serverErr: `${error ?? "This element has a held take quote."} Held until ${heldUntil}.${tail}`,
      field: null,
      priceMoved: null,
    };
  }
  if (json.code === "PROVIDER_UNAVAILABLE" && typeof json.paymentId === "string") {
    // R06-7: the row exists and holds its claim, so say so with the id that
    // names it. The form reuses this attempt's key, so a retry here resumes
    // that same row instead of writing a second pending payment.
    return {
      serverErr: `${error ?? "Payment provider unavailable. Try again."} Your reference: ${json.paymentId}.`,
      field: null,
      priceMoved: null,
    };
  }
  if (error != null && typeof json.field === "string" && fieldHasRenderer(json.field)) {
    return { serverErr: null, field: { field: json.field, message: error }, priceMoved: null };
  }
  // Includes the replay of a checkout that already ended (`200` + `status`,
  // no `checkoutUrl`), whose `error` is the sentence the buyer needs (R06-9).
  return { serverErr: error ?? "Something went wrong. Try again.", field: null, priceMoved: null };
}
