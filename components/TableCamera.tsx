"use client";

import {
  ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { IconBtn } from "./IconBtn";
import { cameraInteract } from "../lib/cameraInteract";

const MIN = 0.45;
const MAX = 2.8;

type Cam = { x: number; y: number; scale: number };

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

export function TableCamera({
  children,
  focusId,
}: {
  children: ReactNode;
  focusId?: number | null;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const camRef = useRef<Cam>({ x: 0, y: 0, scale: 1 });
  const [cam, setCam] = useState<Cam>(camRef.current);
  const [anim, setAnim] = useState(false);
  const dirty = useRef(false);
  const drag = useRef<{
    px: number;
    py: number;
    x: number;
    y: number;
  } | null>(null);
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinch = useRef<{ dist: number; mx: number; my: number } | null>(null);

  const apply = useCallback((next: Cam, animate = false) => {
    // Phase 5: reduced motion kills camera transitions, not just tiles.
    const reduced =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    camRef.current = next;
    setAnim(reduced ? false : animate);
    setCam(next);
  }, []);

  const fit = useCallback(
    (animate = true) => {
      const vp = viewportRef.current;
      const inner = innerRef.current;
      if (!vp || !inner) return;
      const vw = vp.clientWidth;
      const vh = vp.clientHeight;
      const cw = inner.offsetWidth || 966;
      const ch = inner.offsetHeight || 540;
      const scale = clamp(
        Math.min((vw * 0.86) / cw, (vh * 0.82) / ch, 1.3),
        MIN,
        MAX
      );
      const x = (vw - cw * scale) / 2;
      const y = (vh - ch * scale) / 2 - 48;
      dirty.current = false;
      apply({ x, y, scale }, animate);
    },
    [apply]
  );

  const zoomAt = useCallback(
    (clientX: number, clientY: number, factor: number, animate = false) => {
      const vp = viewportRef.current;
      if (!vp) return;
      const r = vp.getBoundingClientRect();
      const mx = clientX - r.left;
      const my = clientY - r.top;
      const { x, y, scale } = camRef.current;
      const next = clamp(scale * factor, MIN, MAX);
      if (next === scale) return;
      dirty.current = true;
      apply(
        {
          x: mx - ((mx - x) / scale) * next,
          y: my - ((my - y) / scale) * next,
          scale: next,
        },
        animate
      );
    },
    [apply]
  );

  useLayoutEffect(() => {
    fit(false);
  }, [fit]);

  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onResize = () => {
      if (!dirty.current) fit(false);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(vp);
    window.addEventListener("resize", onResize);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [fit]);

  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0016);
      zoomAt(e.clientX, e.clientY, factor);
    };
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => vp.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  useEffect(() => {
    if (focusId == null) return;
    const vp = viewportRef.current;
    const tile = vp?.querySelector(
      `[data-el-id="${focusId}"]`
    ) as HTMLElement | null;
    if (!vp || !tile) return;
    const v = vp.getBoundingClientRect();
    const t = tile.getBoundingClientRect();
    const safe = {
      left: Math.min(400, v.width * 0.26),
      right: v.width - Math.min(410, v.width * 0.3),
      top: 100,
      bottom: v.height - 210,
    };
    const cx = (t.left + t.right) / 2;
    const cy = (t.top + t.bottom) / 2;
    const covered =
      cx < safe.left + 20 ||
      cx > safe.right - 20 ||
      cy < safe.top + 16 ||
      cy > safe.bottom - 16;
    if (!covered) return;
    const tx = (safe.left + safe.right) / 2;
    const ty = (safe.top + safe.bottom) / 2;
    dirty.current = true;
    apply(
      {
        ...camRef.current,
        x: camRef.current.x + (tx - cx),
        y: camRef.current.y + (ty - cy),
      },
      true
    );
  }, [focusId, apply]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Phase 5 (P2-11): camera shortcuts yield to overlays, to any focused
      // interactive control, and to handlers that already consumed the key
      // (e.g. grid arrow navigation stopPropagation).
      if (e.defaultPrevented) return;
      if (document.body.hasAttribute("data-modal-open")) return;
      const t = e.target as HTMLElement;
      if (
        t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.tagName === "SELECT" ||
        t.isContentEditable ||
        !!t.closest?.('button, a, [role="button"], [role="option"], [role="gridcell"], select, input, textarea')
      )
        return;
      const vp = viewportRef.current;
      if (!vp) return;
      const r = vp.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoomAt(cx, cy, 1.22, true);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomAt(cx, cy, 0.82, true);
      } else if (e.key === "0") {
        e.preventDefault();
        fit(true);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        dirty.current = true;
        apply({ ...camRef.current, x: camRef.current.x + 56 }, true);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        dirty.current = true;
        apply({ ...camRef.current, x: camRef.current.x - 56 }, true);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        dirty.current = true;
        apply({ ...camRef.current, y: camRef.current.y + 56 }, true);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        dirty.current = true;
        apply({ ...camRef.current, y: camRef.current.y - 56 }, true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomAt, fit, apply]);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      drag.current = null;
      cameraInteract.dragging = true;
      setAnim(false);
      const pts = Array.from(pointers.current.values());
      pinch.current = {
        dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
        mx: (pts[0].x + pts[1].x) / 2,
        my: (pts[0].y + pts[1].y) / 2,
      };
      return;
    }
    if (e.button !== 0) return;
    cameraInteract.dragging = false;
    drag.current = {
      px: e.clientX,
      py: e.clientY,
      x: camRef.current.x,
      y: camRef.current.y,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (pointers.current.has(e.pointerId)) {
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    if (pointers.current.size === 2 && pinch.current) {
      const pts = Array.from(pointers.current.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const mx = (pts[0].x + pts[1].x) / 2;
      const my = (pts[0].y + pts[1].y) / 2;
      const factor = dist / pinch.current.dist;
      dirty.current = true;
      const { x, y, scale } = camRef.current;
      const next = clamp(scale * factor, MIN, MAX);
      const dx = mx - pinch.current.mx;
      const dy = my - pinch.current.my;
      apply(
        {
          x: mx - ((mx - x) / scale) * next + dx,
          y: my - ((my - y) / scale) * next + dy,
          scale: next,
        },
        false
      );
      pinch.current = { dist, mx, my };
      return;
    }
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (!cameraInteract.dragging && Math.hypot(dx, dy) > 5) {
      cameraInteract.dragging = true;
      dirty.current = true;
      setAnim(false);
    }
    if (!cameraInteract.dragging) return;
    apply({ ...camRef.current, x: d.x + dx, y: d.y + dy }, false);
  };

  const endDrag = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    drag.current = null;
    window.setTimeout(() => {
      cameraInteract.dragging = false;
    }, 0);
  };

  const zoomFromCenter = (factor: number) => {
    const vp = viewportRef.current;
    if (!vp) return;
    const r = vp.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor, true);
  };

  return (
    <>
      <div
        ref={viewportRef}
        className="absolute inset-0 z-[var(--z-table)] overflow-hidden touch-none select-none cursor-grab active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest("[data-el-id]")) return;
          fit(true);
        }}
      >
        <div
          ref={innerRef}
          className="absolute left-0 top-0 will-change-transform"
          style={{
            transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.scale})`,
            transformOrigin: "0 0",
            transition: anim
              ? "transform 320ms cubic-bezier(.22, 1, .36, 1)"
              : "none",
          }}
        >
          {children}
        </div>
      </div>

      <div className="absolute bottom-[70px] left-1/2 -translate-x-1/2 z-[var(--z-cards)] hidden sm:flex items-center gap-3 rounded-full bg-white/95 backdrop-blur px-3.5 py-1.5 text-[11px] font-bold text-mutedink shadow-float pointer-events-none">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-[3px] bg-white shadow-[inset_0_0_0_1px_#E4EBF3]" /> unclaimed
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: "#FDE68A" }} /> claimed
        </span>
        <span className="flex items-center gap-1.5">👑 contested</span>
      </div>

      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-[var(--z-cards)] flex items-center gap-2 pointer-events-none">
        <IconBtn
          label="Zoom out"
          className="pointer-events-auto text-lg leading-none"
          onClick={() => zoomFromCenter(0.82)}
        >
          −
        </IconBtn>
        <span className="text-[11px] font-extrabold text-mutedink px-1 whitespace-nowrap drop-shadow-[0_1px_8px_rgba(0,0,0,.8)]">
          drag to pan · scroll to zoom
        </span>
        <IconBtn
          label="Zoom in"
          className="pointer-events-auto text-lg leading-none"
          onClick={() => zoomFromCenter(1.22)}
        >
          +
        </IconBtn>
        <IconBtn
          label="Fit table"
          className="pointer-events-auto"
          onClick={() => fit(true)}
        >
          ⤢
        </IconBtn>
      </div>
    </>
  );
}
