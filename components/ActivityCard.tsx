"use client";
import useSWR from "swr";
import { Card } from "./Card";
import { Avatar } from "./Avatar";
import { fetchJson, isActivityRows, type ActivityRow } from "../lib/api";
import { relTime } from "../lib/relTime";

function kindLabel(kind: string): string {
  if (kind === "join") return "bid on";
  if (kind === "reclaim") return "reclaimed";
  return "topped up";
}

export function ActivityCard({
  rows,
  onMinimize,
  onClose,
  fluid,
}: {
  /** Pre-fetched rows (from page-level SWR); if omitted the card fetches itself. */
  rows?: ActivityRow[];
  /** Desktop placement: collapse the card into its round FAB. */
  onMinimize?: () => void;
  /** Bottom-sheet placement: explicit close button in the header. */
  onClose?: () => void;
  /** Bottom-sheet placement: fill the sheet width instead of the 340px card. */
  fluid?: boolean;
}) {
  const own = useSWR<ActivityRow[]>(rows ? null : "/api/activity?limit=6", (url: string) => fetchJson(url, isActivityRows), {
    refreshInterval: 30000,
  });
  const data = rows ?? own.data;
  const error = rows ? null : own.error;
  const s0 = data?.[0];

  return (
    <Card className={`${fluid ? "w-full max-w-none" : "w-[340px] max-w-[calc(100vw-36px)]"} rounded-2xl px-3.5 py-3 shadow-float animate-panel-in`}>
      <div className="font-display text-sm font-bold text-mutedink flex items-center gap-2">
        <span className="block h-2 w-2 rounded-full bg-green-500 shadow-[0_0_8px_#22c55e]" />
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
        {error ? (
          <span>Couldn&apos;t load activity — retrying…</span>
        ) : !s0 ? (
          <span className="animate-pulse">loading…</span>
        ) : (
          <>
            <span className="text-ink">{s0.elementSymbol.toUpperCase()}</span>{" "}
            {s0.kind === "join" ? "New bid" : s0.kind === "reclaim" ? "Crown reclaimed" : "Stake bumped"} ·{" "}
            <span className="text-ink">{s0.city ?? "somewhere"}</span>
          </>
        )}
      </div>
      <div className="mt-1 flex flex-col">
        {!data && !error
          ? [0, 1, 2, 3, 4].map((i) => <div key={i} className="h-[42px] rounded-lg bg-icy animate-pulse my-[2px]" />)
          : (data ?? []).slice(0, 5).map((s) => (
              <a
                key={s.id}
                href={s.stakeId ? `/go/${s.stakeId}` : `/s/${encodeURIComponent(s.domain)}`}
                target="_blank"
                rel="sponsored nofollow noopener"
                className="block rounded-lg p-[6px] text-left no-underline transition-colors hover:bg-icy"
              >
                <div className="flex items-center gap-[9px]">
                  <Avatar src={`https://www.google.com/s2/favicons?domain=${s.domain}&sz=64`} domain={s.domain} size={22} rounded="rounded-[5px]" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-extrabold text-ink">{s.domain}</div>
                    <div className="truncate text-[11.5px] font-bold text-mutedink">
                      {kindLabel(s.kind)} in {s.elementSymbol} {s.elementName}
                      {s.total !== s.delta ? ` · total $${s.total}` : ""}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end">
                    <span className="text-sm font-black text-moneyink">+${s.delta}</span>
                    <span className="text-[11px] font-bold text-mutedink">{relTime(Date.parse(s.createdAt))}</span>
                  </div>
                </div>
              </a>
            ))}
        {error && !data && (
          <button onClick={() => own.mutate()} className="mt-1 rounded-xl bg-icy px-3 py-2 text-xs font-extrabold text-ink">
            Retry
          </button>
        )}
      </div>
      <div className="mt-1 flex justify-between border-t border-hairline pt-2 text-xs font-bold text-mutedink">
        <span><b className="text-ink">live</b> · updates every 30s</span>
        <span><b className="text-ink">{data?.length ?? 0}</b> recent</span>
      </div>
    </Card>
  );
}
