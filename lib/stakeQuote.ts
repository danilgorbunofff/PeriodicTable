import { reclaimFor } from "./pricing";

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
  const belowNeed = priorHere && need != null && amount > 0 && amount < need;
  // Only a TAKE writes a Reservation (app/api/checkout/route.ts): a newcomer's
  // amount reaching the visible take price, on a board with nothing concealed.
  const takeQuoted = boardComplete && !priorHere && leaderTotal != null && need != null && amount >= need;
  return { boardComplete, priorTotal, priorHere, alreadyLead, need, reconciledAmount, belowNeed, takeQuoted };
}
