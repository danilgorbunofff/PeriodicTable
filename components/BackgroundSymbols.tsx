"use client";

import { useEffect, useMemo, useRef } from "react";
import { ELEMENTS } from "../lib/elements";

type LayerCfg = {
  key: string;
  count: number;
  sizeMin: number;
  sizeMax: number;
  opMin: number;
  opMax: number;
  blur: number; // px, 0 = crisp
  amp: number; // px of mouse parallax
  durMul: number;
  amberEvery: number; // every Nth symbol amber; 0 = none
};

// Far = tiny + dim + slowest; near = large "hero" symbols with a soft blur.
const LAYERS: LayerCfg[] = [
  { key: "far", count: 22, sizeMin: 12, sizeMax: 20, opMin: 0.07, opMax: 0.13, blur: 0, amp: 6, durMul: 1.2, amberEvery: 0 },
  { key: "mid", count: 12, sizeMin: 20, sizeMax: 34, opMin: 0.1, opMax: 0.17, blur: 0, amp: 14, durMul: 1, amberEvery: 6 },
  { key: "near", count: 6, sizeMin: 44, sizeMax: 64, opMin: 0.13, opMax: 0.2, blur: 2, amp: 26, durMul: 0.9, amberEvery: 3 },
];

// Deterministic PRNG so server render and hydration produce identical fields.
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Ambient stage dressing: element symbols on three parallax depth layers,
// each gently twinkling while it drifts upward. Pure transform/opacity CSS
// animation (see .bg-sym in globals.css) — GPU-composited, no JS loop; the
// only JS is a rAF-throttled pointermove that sets two CSS vars for parallax.
export function BackgroundSymbols() {
  const rootRef = useRef<HTMLDivElement>(null);

  const layers = useMemo(() => {
    const rand = mulberry32(20260914);
    const syms = ELEMENTS.map((e) => e.symbol);
    return LAYERS.map((cfg) => ({
      cfg,
      drifts: Array.from({ length: cfg.count }, (_, i) => ({
        sym: syms[Math.floor(rand() * syms.length)],
        left: 2 + rand() * 94,
        top: -10 + rand() * 103,
        size: Math.round(cfg.sizeMin + rand() * (cfg.sizeMax - cfg.sizeMin)),
        dur: (30 + rand() * 34) * cfg.durMul,
        delay: -(rand() * 40),
        sway: Math.round(14 + rand() * 30),
        op: cfg.opMin + rand() * (cfg.opMax - cfg.opMin),
        amber: cfg.amberEvery > 0 && i % cfg.amberEvery === 0,
        twDur: 4 + rand() * 5,
        twDelay: -(rand() * 9),
      })),
    }));
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    // Parallax is fine-pointer eye candy; skip it for touch and reduced motion.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (window.matchMedia("(pointer: coarse)").matches) return;
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        root.style.setProperty("--mx", (e.clientX / window.innerWidth - 0.5).toFixed(4));
        root.style.setProperty("--my", (e.clientY / window.innerHeight - 0.5).toFixed(4));
      });
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div ref={rootRef} aria-hidden className="bg-sym-root pointer-events-none fixed inset-0 z-0 select-none overflow-hidden">
      {layers.map(({ cfg, drifts }) => (
        <div key={cfg.key} className="bg-layer" style={{ "--amp": `${cfg.amp}px` } as React.CSSProperties}>
          {drifts.map((it, i) => (
            <span
              key={i}
              className="bg-sym font-display font-bold"
              style={
                {
                  left: `${it.left}%`,
                  top: `${it.top}vh`,
                  fontSize: it.size,
                  color: it.amber ? "#ffc93c" : "#ffffff",
                  filter: cfg.blur ? `blur(${cfg.blur}px)` : undefined,
                  animationDuration: `${it.dur}s`,
                  animationDelay: `${it.delay}s`,
                  "--sway": `${it.sway}px`,
                  "--op": (it.amber ? it.op * 0.8 : it.op).toFixed(3),
                } as React.CSSProperties
              }
            >
              <span
                className="bg-sym-tw"
                style={{ animationDuration: `${it.twDur}s`, animationDelay: `${it.twDelay}s` }}
              >
                {it.sym}
              </span>
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
