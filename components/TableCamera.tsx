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
    pointerId: number;
    px: number;
    py: number;
    x: number;
    y: number;
  } | null>(null);
  // Touch gestures live on native touch events (see the effect below), not on
  // pointer events: on iOS a two-finger gesture that starts on a link or an
  // image fires `pointercancel` on the first pointer, which killed the pinch
  // before it could start. Mouse and pen keep the pointer handlers.
  const touchGesture = useRef<
    | { kind: "pan"; px: number; py: number; x: number; y: number }
    | { kind: "pinch"; dist: number; mx: number; my: number }
    | null
  >(null);

  const apply = useCallback((next: Cam, animate = false) => {
    // Phase 5: reduced motion kills camera transitions, not just tiles.
    const reduced =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // The camera transform math assumes an unscrolled viewport. Native focus
    // scrolling can silently set scrollLeft/scrollTop on the overflow:hidden
    // box (see the overflow:clip note below), which would double-offset the
    // board — heal it at the single choke point every camera move goes through.
    const vp = viewportRef.current;
    if (vp && (vp.scrollTop !== 0 || vp.scrollLeft !== 0)) {
      vp.scrollTop = 0;
      vp.scrollLeft = 0;
    }
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
    const inner = innerRef.current;
    if (!vp) return;
    const onResize = () => {
      if (!dirty.current) fit(false);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(vp);
    if (inner) ro.observe(inner);
    window.addEventListener("resize", onResize);
    // Grid metrics change once fonts swap in — re-fit so the table never
    // lands off-center after the very first layout pass.
    if (typeof document !== "undefined" && (document as Document & { fonts?: FontFaceSet }).fonts) {
      (document as Document & { fonts: FontFaceSet }).fonts.ready.then(() => {
        if (!dirty.current) fit(false);
      });
    }
    // Safety net: if a pointerup is lost (alt-tab mid-drag, capture dropped
    // by the browser, OS gesture), cameraInteract.dragging would otherwise
    // stick true and silently swallow every tile click until reload.
    const hardReset = () => {
      touchGesture.current = null;
      drag.current = null;
      cameraInteract.dragging = false;
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") hardReset();
    };
    window.addEventListener("blur", hardReset);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("blur", hardReset);
      document.removeEventListener("visibilitychange", onVisibility);
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

  /**
   * Touch pan + pinch, on native touch events.
   *
   * `touch-action: none` on the viewport already stops scroll and browser zoom,
   * but it does not stop iOS from claiming a two-finger gesture that begins on
   * a link/image (the tiles): that claim cancels the first pointer and the
   * pointer-based pinch never sees two pointers. Driving the gesture from
   * `touchstart`/`touchmove` directly, and calling `preventDefault()` the moment
   * a second finger lands, keeps the tiles tappable (a single touch is never
   * cancelled) while making the pinch start wherever the fingers land.
   */
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;

    const start = (e: TouchEvent) => {
      if (e.touches.length >= 2) {
        e.preventDefault();
        drag.current = null;
        cameraInteract.dragging = true;
        setAnim(false);
        const a = e.touches[0];
        const b = e.touches[1];
        touchGesture.current = {
          kind: "pinch",
          dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1,
          mx: (a.clientX + b.clientX) / 2,
          my: (a.clientY + b.clientY) / 2,
        };
        return;
      }
      if (e.touches.length === 1 && touchGesture.current == null) {
        const t = e.touches[0];
        touchGesture.current = {
          kind: "pan",
          px: t.clientX,
          py: t.clientY,
          x: camRef.current.x,
          y: camRef.current.y,
        };
      }
    };

    const move = (e: TouchEvent) => {
      const g = touchGesture.current;
      if (!g) return;
      if (g.kind === "pinch" && e.touches.length >= 2) {
        e.preventDefault();
        const a = e.touches[0];
        const b = e.touches[1];
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
        const mx = (a.clientX + b.clientX) / 2;
        const my = (a.clientY + b.clientY) / 2;
        const factor = dist / g.dist;
        dirty.current = true;
        const { x, y, scale } = camRef.current;
        const next = clamp(scale * factor, MIN, MAX);
        const dx = mx - g.mx;
        const dy = my - g.my;
        apply(
          {
            x: mx - ((mx - x) / scale) * next + dx,
            y: my - ((my - y) / scale) * next + dy,
            scale: next,
          },
          false
        );
        touchGesture.current = { kind: "pinch", dist, mx, my };
        return;
      }
      if (g.kind === "pan" && e.touches.length === 1) {
        const t = e.touches[0];
        const dx = t.clientX - g.px;
        const dy = t.clientY - g.py;
        if (!cameraInteract.dragging && Math.hypot(dx, dy) > 5) {
          cameraInteract.dragging = true;
          dirty.current = true;
          setAnim(false);
        }
        if (cameraInteract.dragging) {
          // Once a pan is real, suppress the compatibility mouse events (and
          // with them the trailing tile click) at the source.
          e.preventDefault();
          apply({ ...camRef.current, x: g.x + dx, y: g.y + dy }, false);
        }
      }
    };

    const end = (e: TouchEvent) => {
      if (e.touches.length === 0) {
        touchGesture.current = null;
        window.setTimeout(() => {
          cameraInteract.dragging = false;
        }, 0);
      } else if (e.touches.length === 1 && touchGesture.current?.kind === "pinch") {
        // A finger lifted mid-pinch: the remaining finger pans from the camera
        // as it stands instead of snapping back to a stale origin.
        const t = e.touches[0];
        touchGesture.current = {
          kind: "pan",
          px: t.clientX,
          py: t.clientY,
          x: camRef.current.x,
          y: camRef.current.y,
        };
      }
    };

    vp.addEventListener("touchstart", start, { passive: false });
    vp.addEventListener("touchmove", move, { passive: false });
    vp.addEventListener("touchend", end);
    vp.addEventListener("touchcancel", end);
    return () => {
      vp.removeEventListener("touchstart", start);
      vp.removeEventListener("touchmove", move);
      vp.removeEventListener("touchend", end);
      vp.removeEventListener("touchcancel", end);
    };
  }, [apply]);

  const onPointerDown = (e: React.PointerEvent) => {
    // Touch is owned by the native touch layer above; these handlers exist for
    // mouse and pen, where pointer events are exact and capture is reliable.
    if (e.pointerType === "touch") return;
    if (e.button !== 0) return;
    cameraInteract.dragging = false;
    drag.current = {
      pointerId: e.pointerId,
      px: e.clientX,
      py: e.clientY,
      x: camRef.current.x,
      y: camRef.current.y,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (e.pointerType === "touch") return;
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (!cameraInteract.dragging && Math.hypot(dx, dy) > 5) {
      cameraInteract.dragging = true;
      dirty.current = true;
      setAnim(false);
      const viewport = e.currentTarget as HTMLElement;
      if (!viewport.hasPointerCapture(e.pointerId)) {
        viewport.setPointerCapture(e.pointerId);
      }
    }
    if (!cameraInteract.dragging) return;
    apply({ ...camRef.current, x: d.x + dx, y: d.y + dy }, false);
  };

  const endDrag = (e: React.PointerEvent) => {
    if (e.pointerType === "touch") return;
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
        style={{ overflow: "clip" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest("[data-el-id]")) return;
          fit(true);
        }}
      >
        <div
          ref={innerRef}
          className="absolute left-0 top-0"
          onTransitionEnd={() => setAnim(false)}
          style={{
            transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.scale})`,
            transformOrigin: "0 0",
            willChange: anim ? "transform" : "auto",
            transition: anim
              ? "transform 320ms cubic-bezier(.22, 1, .36, 1)"
              : "none",
          }}
        >
          {children}
        </div>
      </div>

      <div className="absolute bottom-[calc(20px+var(--safe-b))] md:bottom-[56px] left-1/2 -translate-x-1/2 z-[var(--z-cards)] hidden md:flex items-center gap-2 pointer-events-none bg-black/55 backdrop-blur-md rounded-full px-2.5 py-1.5 shadow-lg">
        <IconBtn
          label="Zoom out"
          className="pointer-events-auto !bg-white !text-ink"
          onClick={() => zoomFromCenter(0.82)}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M2.5 7h9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </IconBtn>
        <span className="text-[11px] font-extrabold text-white/90 px-1 whitespace-nowrap">
          drag to pan · scroll to zoom
        </span>
        <IconBtn
          label="Zoom in"
          className="pointer-events-auto !bg-white !text-ink"
          onClick={() => zoomFromCenter(1.22)}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M2.5 7h9M7 2.5v9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </IconBtn>
        <IconBtn
          label="Fit table"
          className="pointer-events-auto !bg-white !text-ink"
          onClick={() => fit(true)}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M8 2.5h3.5V6M6 11.5H2.5V8M11.5 2.5 7.75 6.25M2.5 11.5l3.75-3.75" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </IconBtn>
      </div>
    </>
  );
}
