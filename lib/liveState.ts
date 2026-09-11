/* Honesty gate for the homepage's live data.

   The homepage renders a default face for every element it holds no claim for,
   and the stats card used to be handed 0 / $0 / 122 when it had nothing. Both
   defaults become *lies* the moment the API is merely unreachable: the table
   would advertise the entire periodic table as unclaimed at $5, and the stats
   card would report a marketplace that has never sold anything. Neither is a
   neutral fallback — each is a specific, confident, false claim about inventory.

   So the question "am I allowed to draw the defaults?" is lifted out of JSX into
   this truth table, where it has four answerable cases instead of one
   unreviewable `?? 0`.

   SWR keeps the last good value when a *refresh* fails. That is why "stale" is a
   state of its own rather than an error: the numbers are real, they are just no
   longer current, and the page must say so rather than presenting them as fresh.
   A visitor who reads a stale tile as unclaimed clicks through to a price the
   tile never advertised — the same surprise the checkout mismatch caused before
   c4fbb45. */

export type LiveState =
  | "loading" // nothing yet, no failure — the defaults are not yet a claim
  | "ok" // fresh data
  | "stale" // real values, failed refresh — show them, marked as last known
  | "unavailable"; // nothing to show and a failure — never substitute defaults

export function liveState(hasData: boolean, error: unknown): LiveState {
  if (hasData) return error ? "stale" : "ok";
  return error ? "unavailable" : "loading";
}

/** Copy for the states that require a visible notice. `ok` and `loading` return
 *  null: a healthy board says nothing, and the initial load is allowed to render
 *  the real table rather than a spinner over it. Kept here beside the states so
 *  the wording cannot drift between the panel and the marker. */
export function liveMessage(state: LiveState): string | null {
  switch (state) {
    case "stale":
      return "Last known data — live updates are paused.";
    case "unavailable":
      return "Couldn't load the live table. Prices shown here are not real.";
    case "ok":
    case "loading":
      return null;
  }
}
