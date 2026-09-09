"use client";
import Link from "next/link";

/**
 * Legal links (Phase 5): always rendered — desktop bottom-center pill; mobile
 * above the rail FAB (bottom-right), clear of the wordmark, hero, table, and
 * zoom controls. The open bottom-sheet covers it (lower z-order) by design.
 */
export function FooterBar() {
  return (
    <div className="absolute z-[var(--z-cards)] bottom-[18px] left-1/2 -translate-x-1/2 max-md:bottom-5">
      <nav aria-label="Legal" className="bg-white/90 backdrop-blur rounded-full shadow-float px-4 py-1.5 text-[11px] font-bold text-mutedink flex items-center gap-3 whitespace-nowrap max-md:px-3 max-md:gap-2">
        <Link href="/legal/about" className="hover:text-ink">About & disclaimer</Link>
        <span aria-hidden="true">·</span>
        <Link href="/legal/rules" className="hover:text-ink">Rules & payments</Link>
        <span aria-hidden="true">·</span>
        <Link href="/legal/contact" className="hover:text-ink">Contact</Link>
      </nav>
    </div>
  );
}
