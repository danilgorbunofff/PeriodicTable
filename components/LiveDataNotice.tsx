"use client";
import { Card } from "./Card";
import { liveMessage, type LiveState } from "../lib/liveState";

/** The board's honesty surface: shown only when the live data cannot be trusted.
 *  A healthy board says nothing at all — there is no "all good" badge here,
 *  because a status marker that is normally present stops being read.
 *
 *  `unavailable` is a full panel, because there is nothing true to draw on the
 *  table behind it. `stale` is a compact marker, because those values are real
 *  and worth reading — only their freshness is in question. Both offer a retry,
 *  since both are caused by the same thing and both clear the same way.
 *
 *  The live-region wrapper is here because `Card` deliberately takes only
 *  children and className, and one caller should not widen a shared component's
 *  API. */
export function LiveDataNotice({ state, onRetry }: { state: LiveState; onRetry: () => void }) {
  const message = liveMessage(state);
  if (!message) return null;
  const blocking = state === "unavailable";

  return (
    <div role="status" aria-live="polite">
      <Card
        className={
          blocking
            ? "mx-auto flex w-[min(420px,90vw)] flex-col items-center gap-4 rounded-2xl px-6 py-7 text-center shadow-float"
            : "flex items-center gap-3 rounded-full px-4 py-2 shadow-float"
        }
      >
        <span className={blocking ? "font-bold text-ink" : "text-sm font-bold text-mutedink"}>
          {blocking ? "⚠️ " : ""}
          {message}
        </span>
        <button
          type="button"
          onClick={onRetry}
          className={`rounded-full bg-cta font-display font-bold text-ink hover:brightness-95 [@media(pointer:coarse)]:min-h-[44px] ${
            blocking ? "h-11 px-6 text-sm" : "h-8 px-4 text-xs"
          }`}
        >
          Retry
        </button>
      </Card>
    </div>
  );
}
