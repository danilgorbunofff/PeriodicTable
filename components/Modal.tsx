"use client";
import { useEffect, useRef } from "react";
import { IconBtn } from "./IconBtn";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  onClose,
  children,
  label,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  label: string;
  /** "lg" is a taller, non-scrolling shell for content (e.g. the rail) that manages its own internal scroll region. */
  size?: "md" | "lg";
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const lastFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    lastFocused.current = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const firstFocusable = dialog?.querySelector<HTMLElement>(FOCUSABLE);
    (firstFocusable ?? dialog)?.focus();

    const fn = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
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
    window.addEventListener("keydown", fn);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", fn);
      document.body.style.overflow = "";
      lastFocused.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;
  const sizeClass =
    size === "lg"
      ? "max-w-[460px] h-[min(720px,85vh)] flex flex-col overflow-hidden"
      : "max-w-md max-h-[85vh] overflow-auto";
  return (
    <div className="fixed inset-0 z-[var(--z-modal)] grid place-items-center p-4">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm animate-modal-backdrop" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={`relative bg-white rounded-card shadow-card w-full p-6 outline-none animate-modal-in ${sizeClass}`}
      >
        <IconBtn label="Close" onClick={onClose} className="absolute top-4 right-4">✕</IconBtn>
        {children}
      </div>
    </div>
  );
}
