"use client";
import { Fragment } from "react";
import Link from "next/link";
import { LEGAL_LINKS } from "../lib/legal";

/**
 * Legal links (Phase 5, completed in the phase-16 pass): all four documents,
 * always rendered — desktop bottom-center pill; mobile
 * above the rail FAB (bottom-right), clear of the wordmark, hero, table, and
 * zoom controls. The open bottom-sheet covers it (lower z-order) by design.
 */
export function FooterBar() {
  return (
    <div className="absolute z-[var(--z-cards)] bottom-[18px] left-1/2 -translate-x-1/2 max-md:bottom-5">
      <nav aria-label="Legal" className="bg-white/90 backdrop-blur rounded-full shadow-float px-4 py-1.5 text-[11px] font-bold text-mutedink flex items-center gap-3 whitespace-nowrap max-md:px-3 max-md:gap-2 [@media(pointer:coarse)]:py-0">
        {/* The min-h-[44px] targets make the pill 44px tall on touch and no
            taller: the py is dropped under the same media query so the pill's
            top edge lands at 64px from the bottom, still clear of the stale
            marker parked at 72px. The one-word labels keep the four documents
            on one line at 320px, so the pill never grows upward into the board
            the way a wrapped second row would. */}
        {LEGAL_LINKS.map((link, i) => (
          <Fragment key={link.href}>
            {i > 0 && <span aria-hidden="true">·</span>}
            <Link href={link.href} className="hover:text-ink [@media(pointer:coarse)]:inline-flex [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:justify-center">{link.short}</Link>
          </Fragment>
        ))}
      </nav>
    </div>
  );
}
