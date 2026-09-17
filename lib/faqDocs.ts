/* The FAQ's copy, as data (R19-4).
 *
 * Doc 19 §5.4 found the marketing surface answering the questions a buyer asks
 * *before* paying — what a stake costs, what it buys, what happens when someone
 * outbids you — in four places that had drifted apart: the help modal, the
 * element page, the rules document and the seed instrument. This module is the
 * one place those answers live now, and the page renders no sentence that is
 * not in here, so a test can import the copy instead of scraping HTML.
 *
 * Every number is interpolated from the module that enforces it (`MIN_STAKE`,
 * `TAKEOVER_MARGIN`) and every mailbox from `lib/legal.ts`, so copy cannot
 * quote a price the pricing engine does not charge. The definitions of "own"
 * and "stake" are the corpus's own sentences: the FAQ may summarise the rules,
 * but it may not paraphrase them into something slightly different. The service
 * term is the corpus's constant too (`SERVICE_TERM`), for the same reason
 * (R20-14/R20-15) — an answer about what happens if the site stops cannot name a
 * date the rules page does not.
 *
 * Dependency-free apart from those imports — the page is a server component,
 * and `lib/legalDocs.ts` is already in the client bundle through checkout.
 */

import { MIN_STAKE, TAKEOVER_MARGIN, TIE_CLEARANCE } from "./pricing";
import { NO_STAKES_YET } from "./activityFace";
import { OWNERSHIP_SENTENCE, STAKE_SENTENCE } from "./legalDocs";
import { SUPPORT_EMAIL, SERVICE_TERM, SERVICE_TERM_SENTENCE } from "./legal";

export type FaqItem = { q: string; a: string[] };

export const FAQ_META = {
  title: "Questions & answers",
  desc: "What a stake on an element costs, what it buys, how rank is decided when someone outbids you, and who to write to when something is wrong.",
};

export const FAQ_ITEMS: FaqItem[] = [
  {
    q: "What am I actually buying?",
    a: [
      STAKE_SENTENCE,
      OWNERSHIP_SENTENCE,
      `The practical version: a square on the table carries your domain, a title and a one-line pitch, and a link to the page you name. You are buying that slot, ranked against everyone else on the same element — nothing about the element itself, and nothing about the site.`,
    ],
  },
  {
    q: "What does a claim cost?",
    a: [
      `The smallest first claim on an element is $${MIN_STAKE}. After that the price is set by whoever holds it: taking an element from its current holder means beating their total by at least $${TAKEOVER_MARGIN} — in practice $1 more than they have on the element.`,
      `A tie is refused rather than silently merged, because two equal totals would be indistinguishable: if your amount matches one already on the board, the board asks you to add $${TIE_CLEARANCE} to stand clear of the tie. If you were outbid and want the top of the element back, you pay the gap between you and the leader plus that same $${TAKEOVER_MARGIN}.`,
      `On a crowded element you can join at any free amount at or above the floor — the amount you choose is what ranks you.`,
    ],
  },
  {
    q: "How is rank decided?",
    a: [
      "Stakes are cumulative, not a single bid: your rank on an element is the total you have staked there over time, so topping up a claim you already own lifts it. Many small stakes can outrank one large one.",
      "Element totals then feed the Table Order on the board, which ranks listings by the total staked across every element. A listing that an operator has hidden still counts toward its element's total — the money was really paid — but the row itself is not shown on the public surfaces. A hidden row is reported through the mailbox on the contact page, since its own page no longer lists it.",
    ],
  },
  {
    q: "What happens when someone outbids me?",
    a: [
      `Nothing you paid for is lost. Your stake stays on the element and keeps counting toward your total rank; the listing drops down the element's list. You can top up later, or take the lead back by covering the gap to the leader plus $${TAKEOVER_MARGIN}.`,
    ],
  },
  {
    q: "Why does an element look empty?",
    a: [
      `An element nobody has staked on has no list to show yet, and says so — "${NO_STAKES_YET}" is the honest empty state, not a broken page. The first claim on that element lands there, and costs $${MIN_STAKE} or more.`,
      `Some elements are held by launch inventory: seats the operator opened before launch, naming real companies and linking to their sites, so a stranger does not meet an empty table. Nothing on those seats was submitted, paid for or approved by the company named on them, and the company may not know the seat exists — a seat is a place on a leaderboard, not ownership, endorsement or sponsorship. Any of them is beatable for $${TAKEOVER_MARGIN} over whatever it holds, and the operator releases any seat nobody has paid for.`,
    ],
  },
  {
    q: "Can I get my money back?",
    a: [
      "No. Every stake is final, and the checkout asks you to acknowledge that before paying. The slot is delivered the moment the payment settles — your listing appears on the table and in the leaderboards immediately — and it is bought for one named element, so there are no refunds, cancellations, withdrawals, credits or transfers: not if you are outbid, not if you change your mind, and not for a listing removed for breaking the rules.",
      `If something went wrong with a charge, write to ${SUPPORT_EMAIL} before disputing it — the receipt carries the reference needed to identify it, and almost every dispute starts as a charge nobody recognised. A dispute opened without writing first is a breach of the rules: the listings can be removed permanently, further stakes can be refused, and the fees and costs a dispute causes may be recovered. Nothing in the rules removes a refund right the law gives you and that cannot be waived, including a stake made by a child, which is reversed and returned on request.`,
    ],
  },
  {
    q: "What is shown about me, and who can see it?",
    a: [
      "The public face of a listing is the domain you named, its title, its pitch, and the rank numbers on its element and on the board. Nothing from your payment details is published, and card details never reach this site at all — they are entered on the payment provider's own page.",
      `To change the title, the pitch or the link on your own listing, write to ${SUPPORT_EMAIL} from the address you staked with: there is no self-serve edit page, so the mailbox is how an edit is asked for and confirmed. An operator can hide a listing that breaks the rules; hiding takes the row off the public surfaces, and the stake stays on the element.`,
    ],
  },
  {
    q: "Do you track me?",
    a: [
      "Only if you say so, and only where analytics is switched on at all, which in production it is not. Where it is on, the visitor counter is a third-party script that is not loaded, and no pageview is recorded, until you press Allow on the banner; if you decline or have not answered, nothing is sent. What is measured, and what is stored for how long, is itemised in Privacy & data.",
    ],
  },
  {
    q: "Something is wrong with a listing — who do I write to?",
    a: [
      `Report it from the listing's own row on the board, or write to ${SUPPORT_EMAIL}, which is also how a row already hidden is reported. Reports are acted on, and a complete rights complaint within 72 hours; a listing that breaks the rules is removed.`,
      `That one mailbox is the only way to reach the site — there is no telephone number, postal address or ticket system. Replying to any mail this site sent you — a receipt, an outbid notice, a confirmation link — arrives in the same inbox.`,
    ],
  },
  {
    q: "What happens to my stake if the site stops?",
    a: [
      "A stake has no expiry date. You stay ahead of an element until someone outbids you, and being outbid burns nothing: what you already staked there stays as a discount on that element and it never expires. Nobody's stake is running down.",
      `${SERVICE_TERM_SENTENCE} That date is written in the rules, repeated here, and printed under the price on every element page; if it is ever extended, the new date is published in those same three places.`,
      `If the site ever does stop, the rules say how: notice on the rules page and by email to every current holder at least ${SERVICE_TERM.noticeDays} days in advance, no further stakes taken from that day, and the stakes already taken are not refunded (except where the law requires it) — the same all-stakes-final rule as the refund answer above, applied to the worst case. Nothing here promises the board runs forever: the site is provided "as is" and "as available", and a stake is advertising, not a share of anything.`,
    ],
  },
];
