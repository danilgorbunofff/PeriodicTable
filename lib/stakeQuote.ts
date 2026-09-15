import { joinMin, reclaimFor, smallestFreeAmount } from "./pricing";

/**
 * What the checkout form may claim about a stake, given the board it can see
 * (R04-1, R04-2). Two asymmetries drive these rules, so they live here instead
 * of in the component that renders them.
 *
 * First, an amount the app minted is a machine figure: `?stake=` in an outbid
 * mail or a share link was priced off the board at send time, so it has to keep
 * tracking the live quote until the buyer edits it. A figure the buyer typed is
 * never rewritten.
 *
 * Second, the client can only price what it can see. A concealed listing is
 * missing from `stakes` by design, so on such an element the client cannot tell
 * a newcomer from a returning holder: it must not restate money in the field,
 * and it must not promise a hold the server may never create.
 *
 * Third, #1 can be taken out of play by someone else's live take quote (R09-1).
 * While one runs, the checkout refuses every amount at or above its reserved
 * total and the tie rule refuses the rest, so the copy has to name the hold
 * instead of promising a takeover — see `crownCopy` and `joinSpace`.
 */
export type StakeQuoteInput = {
  /** False until the element payload is in hand. */
  boardLoaded: boolean;
  /** True when the payload's rows are every live listing on the element. */
  boardComplete: boolean;
  /** prices.takeLead from the payload. */
  takeLead?: number;
  /** The top live, non-hidden stake total. */
  leaderTotal?: number;
  /** True once the form holds a domain the caller owns. */
  domainKnown: boolean;
  /** Live total that domain already holds here, as the board shows it. */
  priorTotal: number;
  /** Whole dollars the amount field currently holds. */
  amount: number;
  /** A live take quote that is NOT the caller's (R09-1). */
  takeQuote?: { expiresAt: string | Date; reservedTotal: number } | null;
  /** Clock, for tests. */
  now?: number;
};

export type StakeQuote = {
  boardComplete: boolean;
  priorTotal: number;
  /** The caller already holds a live stake here. */
  priorHere: boolean;
  /** Already the top listed bidder, so any stake is an extension. */
  alreadyLead: boolean;
  /** What it costs to be #1 from where the caller stands. */
  need: number | null;
  /**
   * The live figure an app-minted, still-untouched amount must be replaced by
   * — or null when the board cannot price that caller honestly.
   */
  reconciledAmount: number | null;
  /** The field holds less than `need`, so this payment does not take #1. */
  belowNeed: boolean;
  /** A TAKE quote — and therefore a 15-minute reservation — is expected. */
  takeQuoted: boolean;
  /**
   * R09-1: while a rival's take quote is live, #1 is unavailable to everyone
   * else (ISO string, null when no rival hold is live).
   */
  heldByOtherUntil: string | null;
  /** The rival quote's reserved total — the amount holding #1 (null = none). */
  heldByOtherTotal: number | null;
};

export function stakeQuote({
  boardLoaded,
  boardComplete,
  takeLead,
  leaderTotal,
  domainKnown,
  priorTotal,
  amount,
  takeQuote,
  now,
}: StakeQuoteInput): StakeQuote {
  const priorHere = domainKnown && priorTotal > 0;
  const alreadyLead = priorHere && leaderTotal != null && priorTotal >= leaderTotal;
  // Prices stay unknown until the payload lands: the crown must never flash a
  // guess built from whatever the field already holds.
  const need = !boardLoaded ? null : priorHere ? reclaimFor(leaderTotal, priorTotal) : (takeLead ?? amount);
  // Only a visible prior holding can be reconciled against: without one, a
  // fresh amount is repriced only while the board is whole, so a newcomer on a
  // board with concealed rows keeps the figure they were shown instead of being
  // quoted a price that ignores the listing they may own.
  const reconciledAmount = !boardLoaded || need == null ? null : priorHere || boardComplete ? need : null;
  const belowNeed = priorHere && need != null && amount > 0 && amount < need;
  // Only a TAKE writes a Reservation (app/api/checkout/route.ts): a newcomer's
  // amount reaching the visible take price, on a board with nothing concealed.
  const takeQuoted = boardComplete && !priorHere && leaderTotal != null && need != null && amount >= need;
  // An expired quote stops holding anything even before the row is swept.
  const held =
    !boardLoaded || takeQuote == null || new Date(takeQuote.expiresAt).getTime() <= (now ?? Date.now())
      ? null
      : takeQuote;
  return {
    boardComplete,
    priorTotal,
    priorHere,
    alreadyLead,
    need,
    reconciledAmount,
    belowNeed,
    takeQuoted,
    heldByOtherUntil: held == null ? null : new Date(held.expiresAt).toISOString(),
    heldByOtherTotal: held?.reservedTotal ?? null,
  };
}

/** How much room a live rival take quote leaves below #1 (R09-1). */
export type JoinSpace =
  /** The smallest bid that lands while the hold runs. */
  | { kind: "room"; amount: number }
  /** No amount lands: every one either ties a bid or is covered by the hold. */
  | { kind: "locked"; free: number }
  /** No rival hold is live — the ordinary board rules apply. */
  | { kind: "free" };

export function joinSpace(existingTotals: number[], heldTotal: number | null): JoinSpace {
  if (heldTotal == null) return { kind: "free" };
  const amount = smallestFreeAmount(existingTotals);
  return amount < heldTotal ? { kind: "room", amount } : { kind: "locked", free: amount };
}

export type CrownCopyInput = {
  elementName: string;
  /** True when the rows are every live listing (R04-2). */
  boardComplete: boolean;
  priorHere: boolean;
  alreadyLead: boolean;
  /** quote.need — never null: the caller renders inside a `need != null` guard. */
  need: number;
  /** Live total this domain already holds here. */
  priorTotal: number;
  /** quote.heldByOtherUntil / heldByOtherTotal (R09-1). */
  heldUntil?: string | null;
  heldTotal?: number | null;
  /** Every total the client can see, so it can state the smallest real bid. */
  existingTotals: number[];
  now?: number;
};

/**
 * The two sentences above the amount field (R09-6). Derived from the quote
 * instead of a fixed "$5+": while a rival take quote is live they name the hold
 * and its expiry (R09-1) and the amount that would clear it, and otherwise they
 * name the smallest amount that can actually land on this board. `takeQuoted`'s
 * "held for 15 min" suffix stays in the component — it is a statement about
 * this form, not about the board.
 *
 * What can be promised depends on who is reading: the hold owner's top-ups are
 * never refused, so the incumbent is told what to add rather than told to wait,
 * and a floor figure is only stated on a board the client can see whole
 * (R04-2) — otherwise the sentence says "may" and names the tie rule instead.
 */
export function crownCopy({
  elementName,
  boardComplete,
  priorHere,
  alreadyLead,
  need,
  priorTotal,
  heldUntil = null,
  heldTotal = null,
  existingTotals,
  now,
}: CrownCopyInput): { lead: string; joins: string } {
  const held =
    heldUntil != null && heldTotal != null && new Date(heldUntil).getTime() > (now ?? Date.now());
  if (held) {
    const hhmm = new Date(heldUntil as string).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const space = joinSpace(existingTotals, heldTotal);
    return {
      // "Aims at", not "holds": the incumbent reads this line too, and a quote
      // only takes #1 once it is paid.
      lead: alreadyLead
        ? `👑 You're #1 in ${elementName} — extend your lead!`
        : `⏳ A take quote at $${heldTotal} aims at #1 in ${elementName} until ${hhmm}`,
      joins: priorHere
        ? alreadyLead
          ? // Their own top-ups are never refused, but a $1 top-up lands exactly
            // on the quote's total, so clearing it costs one dollar more.
            `Top-ups are $1+ — add $${need + 1} to clear that quote while it runs.`
          : `Top-ups are $1+ — $${priorTotal + need} takes #1, but that total is inside the quote until ${hhmm}.`
        : !boardComplete
          ? `A bid below $${heldTotal} may still land while that quote runs — exact ties are refused, so stand $1 clear.`
          : space.kind === "room"
            ? `A first bid is $${space.amount}+ while that quote runs — exact ties are refused, so stand $1 clear.`
            : // Nothing free sits under the quote, so name the wall instead of an
              // amount that would be refused.
              `The lowest amount still free is $${smallestFreeAmount(existingTotals)}, and the quote covers it.`,
    };
  }
  return {
    lead: alreadyLead
      ? `👑 You're #1 in ${elementName} — extend your lead!`
      : priorHere
        ? `👑 $${need} more reclaims #1 in ${elementName}!`
        : `👑 $${need} takes #1 in ${elementName}!`,
    joins: priorHere
      ? `Top-ups are $1+ — $${need} more puts you back on top. Exact ties are rejected, so stand $1 clear.`
      : boardComplete
        ? `A first bid is $${smallestFreeAmount(existingTotals)}+ — $${need} takes #1 right now. Exact ties are rejected, so stand $1 clear.`
        : `Any $${joinMin()}+ amount joins the ladder — $${need} grabs #1 right now. Exact ties are rejected, so stand $1 clear.`,
  };
}
