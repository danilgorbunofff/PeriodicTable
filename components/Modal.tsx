"use client";
import { useEffect } from "react";

export function Modal({
  open,
  onClose,
  children,
  label,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  label: string;
}) {
  useEffect(() => {
    if (!open) return;
    const fn = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", fn);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", fn);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[var(--z-modal)] grid place-items-center p-4">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label={label} className="relative bg-white rounded-card shadow-card max-w-md w-full p-6 max-h-[85vh] overflow-auto">
        <button aria-label="Close" onClick={onClose} className="absolute top-4 right-4 text-muted hover:text-ink">✕</button>
        {children}
      </div>
    </div>
  );
}
