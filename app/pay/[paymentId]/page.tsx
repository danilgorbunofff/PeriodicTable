"use client";

import { useParams, useRouter } from "next/navigation";
import { useState } from "react";

export default function DevPayPage() {
  const params = useParams<{ paymentId: string }>();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function run(outcome: "pay" | "fail") {
    setBusy(true);
    const res = await fetch("/api/dev/pay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentId: params.paymentId, outcome }),
    });
    const json = (await res.json().catch(() => ({}))) as { elementSymbol?: string };
    if (outcome === "pay") router.push(json.elementSymbol ? `/?paid=${json.elementSymbol}` : "/?paid=1");
    else setBusy(false);
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#F4F4F0",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: 24,
          padding: "36px 32px",
          width: 420,
          border: "1px solid #ECECE6",
          boxShadow: "0 20px 60px rgba(0,0,0,0.08)",
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 1.5, color: "#999" }}>DEV SIMULATOR</div>
        <h1 style={{ fontSize: 24, fontWeight: 800, margin: "10px 0 6px" }}>Complete your stake</h1>
        <p style={{ color: "#666", fontSize: 14, lineHeight: 1.5 }}>
          No Whop keys configured — this simulator stands in for the real checkout. On Pay, the stake applies
          instantly.
        </p>
        <div style={{ background: "#F4F4F0", borderRadius: 16, padding: 16, margin: "18px 0" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}>
            <span style={{ color: "#666" }}>Payment</span>
            <span style={{ fontWeight: 700, fontFamily: "monospace", fontSize: 12 }}>{params.paymentId}</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={() => run("pay")}
            disabled={busy}
            style={{
              flex: 1,
              background: "#FFCE4B",
              border: "none",
              borderRadius: 999,
              padding: "14px 0",
              fontWeight: 800,
              cursor: "pointer",
            }}
          >
            Pay now
          </button>
          <button
            onClick={() => run("fail")}
            disabled={busy}
            style={{
              flex: 1,
              background: "#fff",
              border: "1px solid #ECECE6",
              borderRadius: 999,
              padding: "14px 0",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Simulate failure
          </button>
        </div>
        <p style={{ fontSize: 12, color: "#999", marginTop: 14, textAlign: "center" }}>
          Failure keeps the payment pending — you can retry.
        </p>
      </div>
    </main>
  );
}
