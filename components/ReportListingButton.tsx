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
  const pending = state === "pending";

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
      {/* The visible text is the accessible name in every state — no aria-label.
          A static "Report …" label would override "reported ✓" / "failed —
          retry?", so AT would announce the wrong state and voice control could
          not match the name it can see (WCAG 2.5.3).

          aria-disabled rather than disabled: send() closes the modal and flips
          this in the same render, so Modal's focus-restore would land on a
          genuinely disabled button, silently dropping focus to <body> for the
          whole round-trip. The click guard keeps double-submits impossible. */}
      <button
        title="Report listing"
        aria-disabled={pending}
        onClick={() => {
          if (pending) return;
          setConfirm(true);
        }}
        className={`text-xs text-mutedink hover:text-ink underline ${pending ? "no-underline" : ""}`}
      >
        {pending
          ? "reporting…"
          : state === "done"
            ? "reported ✓"
            : state === "error"
              ? "failed — retry?"
              : "Report listing"}
      </button>
      {/* The name change alone is not announced, so the result also goes out as
          a polite status — same pattern as the checkout modal. */}
      <div role="status" aria-live="polite" className="sr-only">
        {pending
          ? `Reporting ${domain}…`
          : state === "done"
            ? `Report submitted for ${domain}. An operator will review it.`
            : state === "error"
              ? `Report failed for ${domain}. Please try again.`
              : ""}
      </div>
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
