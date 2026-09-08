"use client";
import useSWR from "swr";
import { Card } from "./Card";
import { Avatar } from "./Avatar";
import { fetchJson, isActivityRows, type ActivityRow } from "../lib/api";
import { relTime } from "../lib/relTime";

function kindLabel(kind: string): string {
  if (kind === "join") return "planted flag";
  if (kind === "reclaim") return "reclaimed";
  return "topped up";
}

export function ActivityCard({
  onOpen,
  rows,
}: {
  onOpen: (symbol: string) => void;
  /** Pre-fetched rows (from page-level SWR); if omitted the card fetches itself. */
  rows?: ActivityRow[];
}) {
  const own = useSWR<ActivityRow[]>(rows ? null : "/api/activity?limit=6", (url: string) => fetchJson(url, isActivityRows), {
    refreshInterval: 30000,
  });
  const data = rows ?? own.data;
  const error = rows ? null : own.error;
  const s0 = data?.[0];

  return (
    <Card className="w-[300px] max-w-[calc(100vw-36px)] rounded-2xl px-3 py-2.5 shadow-float">
      <div className="font-display text-[12.5px] font-bold text-mutedink flex items-center gap-2">
        <span className="block h-2 w-2 rounded-full bg-green-500 shadow-[0_0_8px_#22c55e]" />
        Live activity
      </div>
      <div className="mt-1.5 border-b border-hairline pb-2 text-xs font-extrabold text-mutedink">
        {error ? (
          <span>Couldn&apos;t load activity — retrying…</span>
        ) : !s0 ? (
          <span className="animate-pulse">loading…</span>
        ) : (
          <>
            <span className="text-ink">{s0.elementSymbol.toUpperCase()}</span>{" "}
            {s0.kind === "join" ? "New flag planted" : s0.kind === "reclaim" ? "Crown reclaimed" : "Stake bumped"} ·{" "}
            <span className="text-ink">{s0.city ?? "somewhere"}</span>
          </>
        )}
      </div>
      <div className="mt-1 flex flex-col">
        {!data && !error
          ? [0, 1, 2, 3, 4].map((i) => <div key={i} className="h-[38px] rounded-lg bg-icy animate-pulse my-[2px]" />)
          : (data ?? []).slice(0, 5).map((s) => (
              <button
                key={s.id}
                onClick={() => onOpen(s.elementSymbol)}
                className="rounded-lg p-[5px] text-left transition-colors hover:bg-icy"
              >
                <div className="flex items-center gap-[9px]">
                  <Avatar src={`https://www.google.com/s2/favicons?domain=${s.domain}&sz=64`} domain={s.domain} size={20} rounded="rounded-[5px]" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-extrabold text-ink">{s.domain}</div>
                    <div className="truncate text-[11px] font-bold text-mutedink">
                      {kindLabel(s.kind)} in {s.elementSymbol} {s.elementName}
                      {s.total !== s.delta ? ` · total $${s.total}` : ""}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end">
                    <span className="text-[13px] font-black text-moneyink">+${s.delta}</span>
                    <span className="text-[10px] font-bold text-mutedink">{relTime(Date.parse(s.createdAt))}</span>
                  </div>
                </div>
              </button>
            ))}
        {error && !data && (
          <button onClick={() => own.mutate()} className="mt-1 rounded-xl bg-icy px-3 py-2 text-xs font-extrabold text-ink">
            Retry
          </button>
        )}
      </div>
      <div className="mt-1 flex justify-between border-t border-hairline pt-2 text-[11.5px] font-bold text-mutedink">
        <span><b className="text-ink">live</b> · updates every 30s</span>
        <span><b className="text-ink">{data?.length ?? 0}</b> recent</span>
      </div>
    </Card>
  );
}
