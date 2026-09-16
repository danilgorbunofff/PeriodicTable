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
 * but it may not paraphrase them into something slightly different.
 *
 * Dependency-free apart from those imports — the page is a server component,
 * and `lib/legalDocs.ts` is already in the client bundle through checkout.
 */

import { MIN_STAKE, TAKEOVER_MARGIN, TIE_CLEARANCE } from "./pricing";
import { NO_STAKES_YET } from "./activityFace";
import { OWNERSHIP_SENTENCE, STAKE_SENTENCE } from "./legalDocs";
import { SUPPORT } from "./legal";

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
      "Element totals then feed the Table Order on the board, which ranks listings by the total staked across every element. A listing that an operator has hidden still counts toward its element's total — the money was really paid — but the row itself is not shown on the public surfaces.",
    ],
  },
  {
    q: "What happens when someone outbids me?",
    a: [
      "Nothing you paid for is lost. Your stake stays on the element and keeps counting toward your total rank; the listing drops down the element's list. You can top up later, or take the lead back by covering the gap to the leader plus $1.",
    ],
  },
  {
    q: "Why does an element look empty?",
    a: [
      `An element nobody has staked on has no list to show yet, and says so — "${NO_STAKES_YET}" is the honest empty state, not a broken page. The first claim on that element lands there, and costs $${MIN_STAKE} or more.`,
      `Listings marked "demo" are different: the operator seeded those before launch so the table is not empty on day one. They were not paid for, they are labelled as such wherever they appear, and they are removed before any visitor could mistake one for a customer.`,
    ],
  },
  {
    q: "Can I get my money back?",
    a: [
      "A stake is final. The checkout asks you to acknowledge that before paying, and the reason is in the rules: the slot is delivered the moment the payment settles — your listing appears on the table and in the leaderboards immediately — and it is bought for one named element, so there are no discretionary refunds, cancellations or withdrawals, including if you are outbid or change your mind.",
      `If something went wrong with a payment, write to ${SUPPORT.hi} before disputing it — the receipt carries the reference needed to sort it out. If a payment is refunded, the stake behind it is reversed with it: the listing falls back to the previous holder and any position it bought is lost. Nothing on this page removes a refund right the law gives you and that cannot be waived.`,
    ],
  },
  {
    q: "What is shown about me, and who can see it?",
    a: [
      "The public face of a listing is the domain you named, its title, its pitch, and the rank numbers on its element and on the board. Nothing from your payment details is published, and card details never reach this site at all — they are entered on the payment provider's own page.",
      "You can edit the title, the pitch and the link from your own listing at any time. An operator can hide a listing that breaks the rules; hiding takes the row off the public surfaces, and the stake stays on the element.",
    ],
  },
  {
    q: "Do you track me?",
    a: [
      "Only if you say so. The visitor counter is a third-party script that is not loaded, and no pageview is recorded, until you press Allow on the banner; if you decline or have not answered, nothing is sent. What is measured, and what is stored for how long, is itemised in Privacy & data.",
    ],
  },
  {
    q: "Something is wrong with a listing — who do I write to?",
    a: [
      `Report it from the listing's own row on the board, or write to ${SUPPORT.abuse}. Reports are acted on; a listing that breaks the rules is removed.`,
      `${SUPPORT.hi} reaches a person for everything else, and replying to any mail this site sent you — a receipt, an outbid notice, a confirmation link — arrives in the same inbox.`,
    ],
  },
  {
    q: "What happens to my stake if the site stops?",
    a: [
      "Nothing here promises that the board stays up forever, and the documents say so: the site is provided \"as is\" and \"as available\", with no warranty of availability. A stake buys its slot when the payment settles, which is why a later shutdown does not refund it — that is the same rule as the refund answer above, applied to the worst case.",
    ],
  },
];
