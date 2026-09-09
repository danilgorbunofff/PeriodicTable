"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconBtn } from "./IconBtn";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export const MODAL_OPEN_ATTR = "data-modal-open";

/**
 * Accessible modal (Phase 5 remediation §Modal and focus behavior).
 *
 * - onClose lives in a ref: the effect runs ONLY on open/close, so typing in
 *   a field never tears down focus handling (the checkout amount-jump bug).
 * - Rendered in a body portal; while open the app root is inert (background
 *   hidden from AT and unfocusable) and a body counter marks overlay depth.
 * - Focus enters the first control once, traps with Tab, and restores the
 *   exact trigger on close.
 * - Escape is owned SOLELY by the topmost modal (stopImmediatePropagation);
 *   page-level handlers skip while MODAL_OPEN_ATTR is present.
 */
export function Modal({
  open,
  onClose,
  children,
  label,
  size = "md",
  hideClose = false,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  label: string;
  /** Hide the built-in corner X — content renders its own close affordance. */
  hideClose?: boolean;
  /** "lg" is a taller, non-scrolling shell for content (e.g. the rail) that manages its own internal scroll region. */
  size?: "md" | "lg";
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const lastFocused = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open || !mounted) return;
    lastFocused.current = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    // Enter once: first control (or the dialog itself when empty).
    const firstFocusable = dialog?.querySelector<HTMLElement>(FOCUSABLE);
    (firstFocusable ?? dialog)?.focus();

    // Inert background + overlay depth counter (stacked modals supported).
    const depth = Number(document.body.getAttribute(MODAL_OPEN_ATTR) ?? 0) + 1;
    document.body.setAttribute(MODAL_OPEN_ATTR, String(depth));
    const root = document.getElementById("app-root");
    const hadInert = root?.hasAttribute("inert") ?? false;
    root?.setAttribute("inert", "");

    const fn = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Sole Esc owner while open — page/camera handlers must not double-fire.
        e.stopImmediatePropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !dialog) return;
      const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    // Capture phase beats page-level bubble handlers registered earlier.
    window.addEventListener("keydown", fn, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", fn, true);
      document.body.style.overflow = prevOverflow;
      const next = Number(document.body.getAttribute(MODAL_OPEN_ATTR) ?? 1) - 1;
      if (next <= 0) document.body.removeAttribute(MODAL_OPEN_ATTR);
      else document.body.setAttribute(MODAL_OPEN_ATTR, String(next));
      if (!hadInert) root?.removeAttribute("inert");
      lastFocused.current?.focus();
    };
  }, [open, mounted]);

  if (!open || !mounted) return null;
  const sizeClass =
    size === "md"
      ? "max-w-md max-h-[85vh] overflow-auto"
      : "max-w-[460px] h-[min(720px,85vh)] flex flex-col overflow-hidden";
  return createPortal(
    <div className="fixed inset-0 z-[var(--z-modal)] grid place-items-center p-4">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm animate-modal-backdrop" onClick={() => onCloseRef.current()} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={`relative bg-white rounded-card w-full p-6 outline-none animate-modal-in shadow-[0_10px_26px_rgba(0,0,0,0.35)] ${sizeClass}`}
      >
        {!hideClose && (
          <IconBtn label="Close" onClick={() => onCloseRef.current()} className="absolute top-4 right-4">✕</IconBtn>
        )}
        {children}
      </div>
    </div>,
    document.body
  );
}
