import { TIE_CLEARANCE, reclaimFor } from "./pricing";

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
 * a newcomer from a returning holder: it must not restate money in the field.
 *
 * There are no holds: a newcomer's only way onto a claimed element is the
 * takeover, and a holder keeps the gap rule. The copy never addresses the buyer
 * by their position (no "You're #1", no "reclaims", no "top-ups") — only the
 * price is derived per buyer.
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
};

export type StakeQuote = {
  boardComplete: boolean;
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
};

export function stakeQuote({
  boardLoaded,
  boardComplete,
  takeLead,
  leaderTotal,
  domainKnown,
  priorTotal,
  amount,
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
  return {
    boardComplete,
    priorHere,
    alreadyLead,
    need,
    reconciledAmount,
  };
}

export type CrownCopyInput = {
  elementName: string;
  /** True when the rows are every live listing (R04-2). */
  boardComplete: boolean;
  /** Already the top listed bidder: the price is a top-up, not a takeover. */
  alreadyLead: boolean;
  /** quote.need — never null: the caller renders inside a `need != null` guard. */
  need: number;
  /** Live total this domain already holds here. */
  priorTotal: number;
};

/**
 * The two sentences above the amount field (R09-6), stated as facts about the
 * board and the price — never as facts about the buyer. What can be promised
 * depends on the board the client can see whole (R04-2), and on whether the
 * reader is already #1 (where "takes #1" would be nonsense and the honest
 * figure is the held total).
 */
export function crownCopy({
  elementName,
  boardComplete,
  alreadyLead,
  need,
  priorTotal,
}: CrownCopyInput): { lead: string; joins: string } {
  if (alreadyLead) {
    return {
      lead: `👑 ${elementName}'s #1 holds $${priorTotal}.`,
      joins: `Top-ups are $${TIE_CLEARANCE}+ — exact ties are rejected.`,
    };
  }
  return {
    // "Aims at", not "takes": a same-moment equal payment can settle first and
    // keep #1 (the ledger's tie order), so the copy must not promise the crown.
    lead: `👑 $${need} aims at #1 in ${elementName}!`,
    joins: boardComplete
      ? `A $${need} bid beats the current #1. Exact ties are rejected — if an equal amount settles first, $${TIE_CLEARANCE} more takes #1.`
      : `Some listings may be concealed — $${need} is the highest visible takeover price.`,
  };
}
