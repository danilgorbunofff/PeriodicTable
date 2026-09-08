"use client";
import { useState } from "react";
import { Modal } from "./Modal";

/** Report affordance for surfaces without their own report flow (profile
 * page). Same confirm-before-send contract as the bidder rows: clicking
 * only arms the modal; Confirm sends exactly one POST; Cancel/Escape sends
 * nothing. */
export function ReportListingButton({
  stakeId,
  domain,
}: {
  stakeId: string;
  domain: string;
}) {
  const [confirm, setConfirm] = useState(false);
  const [state, setState] = useState<"idle" | "pending" | "done" | "error">("idle");

  async function send() {
    setState("pending");
    setConfirm(false);
    try {
      const res = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stakeId, reason: "reported from profile" }),
      });
      const json = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      setState(res.ok && json?.ok ? "done" : "error");
    } catch {
      setState("error");
    }
  }

  return (
    <>
      <button
        aria-label={`Report ${domain}`}
        title="Report listing"
        disabled={state === "pending"}
        onClick={() => {
          if (state === "pending") return;
          setConfirm(true);
        }}
        className="text-xs text-mutedink hover:text-ink underline disabled:no-underline"
      >
        {state === "pending"
          ? "reporting…"
          : state === "done"
            ? "reported ✓"
            : state === "error"
              ? "failed — retry?"
              : "Report listing"}
      </button>
      <Modal open={confirm} onClose={() => setConfirm(false)} label="Confirm report" size="md">
        <h2 className="font-display text-xl font-bold pr-10">Report {domain}?</h2>
        <p className="text-sm text-mutedink mt-2">
          This flags the listing for operator review (phishing, trademark, malware).
          Stakes and payments are never touched — only visibility is reviewed.
        </p>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            onClick={() => setConfirm(false)}
            className="h-11 px-5 rounded-full bg-icy text-sm font-bold text-ink hover:bg-hairline [@media(pointer:coarse)]:min-h-[44px]"
          >
            Cancel
          </button>
          <button
            onClick={send}
            className="h-11 px-5 rounded-full bg-ink text-sm font-bold text-white [@media(pointer:coarse)]:min-h-[44px]"
          >
            Report listing
          </button>
        </div>
      </Modal>
    </>
  );
}
