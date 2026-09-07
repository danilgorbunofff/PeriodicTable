"use client";
import Link from "next/link";

export function FooterBar() {
  return (
    <div className="absolute bottom-[18px] left-1/2 -translate-x-1/2 z-[var(--z-cards)] hidden md:block">
      <div className="bg-white/90 backdrop-blur rounded-full shadow-float px-4 py-1.5 text-[11px] font-bold text-muted flex gap-3">
        <Link href="/legal/about" className="hover:text-ink">About & disclaimer</Link>
        <span>·</span>
        <Link href="/legal/rules" className="hover:text-ink">Rules & payments</Link>
        <span>·</span>
        <Link href="/legal/contact" className="hover:text-ink">Contact</Link>
      </div>
    </div>
  );
}
