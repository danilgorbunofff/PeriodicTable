"use client";
import useSWR from "swr";
import { Card } from "./Card";
import { Avatar } from "./Avatar";
import { fetchJson, isActivityRows, type ActivityRow } from "../lib/api";
import { relTime } from "../lib/relTime";
import { liveState, type LiveState } from "../lib/liveState";
import { activityFace, kindLabel } from "../lib/activityFace";
import { faviconFor } from "../lib/screenshots";
import { track } from "../lib/analytics";

/** First negative delta in the system: a reversal must read as a debit, not a gain. */
function deltaText(delta: number): string {
  return delta < 0 ? `-$${Math.abs(delta)}` : `+$${delta}`;
}

export function ActivityCard({
  rows,
  state: pageState,
  onMinimize,
  onClose,
  onRetry,
  fluid,
}: {
  /** Pre-fetched rows (from page-level SWR); if omitted the card fetches itself. */
  rows?: ActivityRow[];
  /** The page's feed state when it pre-fetches. Retained rows look identical to
   *  fresh ones, so only the page knows whether the last request succeeded. */
  state?: LiveState;
  /** Desktop placement: collapse the card into its round FAB. */
  onMinimize?: () => void;
  /** Bottom-sheet placement: explicit close button in the header. */
  onClose?: () => void;
  /** Called by the retry button when the page owns the feed. */
  onRetry?: () => void;
  /** Bottom-sheet placement: fill the sheet width instead of the 340px card. */
  fluid?: boolean;
}) {
  const own = useSWR<ActivityRow[]>(rows ? null : "/api/activity?limit=6", (url: string) => fetchJson(url, isActivityRows), {
    refreshInterval: 30000,
  });
  const data = rows ?? own.data;
  const state = pageState ?? liveState(!!own.data, own.error);
  const face = activityFace(state, data);

  return (
    <Card className={`${fluid ? "w-full max-w-none" : "w-[340px] max-w-[calc(100vw-36px)]"} rounded-2xl px-3.5 py-3 shadow-float animate-panel-in`}>
      <div className="font-display text-sm font-bold text-mutedink flex items-center gap-2">
        <span className="relative flex h-2 w-2">
          {face.dot.ping ? (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-500 opacity-75" />
          ) : null}
          <span className={`relative inline-flex h-2 w-2 rounded-full ${face.dot.className}`} />
        </span>
        Live activity
        {onMinimize && (
          <button
            aria-label="Minimize live activity"
            title="Minimize"
            onClick={onMinimize}
            className="ml-auto grid h-7 w-7 place-items-center rounded-full bg-icy text-mutedink hover:text-ink"
          >
            ✕
          </button>
        )}
        {onClose && (
          <button
            aria-label="Close live activity"
            title="Close"
            onClick={onClose}
            className="ml-auto grid h-7 w-7 place-items-center rounded-full bg-icy text-mutedink hover:text-ink [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:min-h-[44px]"
          >
            ✕
          </button>
        )}
      </div>
      <div className="mt-1.5 border-b border-hairline pb-2 text-[13px] font-extrabold text-mutedink">
        {face.header.kind === "lead" ? (
          <>
            <span className="text-ink">{face.header.symbol}</span> {face.header.verb} ·{" "}
            <span className="text-ink">{face.header.city}</span>
          </>
        ) : (
          <span className={face.header.kind === "loading" ? "animate-pulse" : undefined}>{face.header.text}</span>
        )}
      </div>
      <div className="mt-1 flex flex-col">
        {face.header.kind === "loading"
          ? [0, 1, 2, 3, 4].map((i) => <div key={i} className="h-[42px] rounded-lg bg-icy animate-pulse my-[2px]" />)
          : (data ?? []).slice(0, 5).map((s) => (
              <a
                key={s.id}
                href={s.stakeId ? `/go/${s.stakeId}` : `/s/${encodeURIComponent(s.domain)}`}
                target="_blank"
                rel="sponsored nofollow noopener"
                onClick={() => {
                  if (s.stakeId) track("go_click", { element: s.elementSymbol, domain: s.domain });
                }}
                className="block rounded-lg p-[6px] text-left no-underline transition-colors hover:bg-icy"
              >
                <div className="flex items-center gap-[9px]">
                  <Avatar src={faviconFor(s.domain, 64)} domain={s.domain} size={22} rounded="rounded-[5px]" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-extrabold text-ink">{s.domain}</div>
                    <div className="truncate text-[11.5px] font-bold text-mutedink">
                      {kindLabel(s.kind)} in {s.elementSymbol} {s.elementName}
                      {s.total !== s.delta ? ` · total $${s.total}` : ""}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end">
                    <span className={`text-sm font-black ${s.delta < 0 ? "text-mutedink" : "text-moneyink"}`}>{deltaText(s.delta)}</span>
                    <span className="text-[11px] font-bold text-mutedink">{relTime(Date.parse(s.createdAt))}</span>
                  </div>
                </div>
              </a>
            ))}
        {state === "unavailable" && (
          <button
            onClick={() => (onRetry ? onRetry() : void own.mutate())}
            className="mt-1 rounded-xl bg-icy px-3 py-2 text-xs font-extrabold text-ink"
          >
            Retry
          </button>
        )}
      </div>
      <div className="mt-1 flex justify-between border-t border-hairline pt-2 text-xs font-bold text-mutedink">
        <span><b className="text-ink">{face.status}</b> · {face.detail}</span>
        <span><b className="text-ink">{data?.length ?? 0}</b> recent</span>
      </div>
    </Card>
  );
}
