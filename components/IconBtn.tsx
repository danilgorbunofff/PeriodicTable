import { ButtonHTMLAttributes } from "react";

/** Compact icy HUD control, matching worldmap.lol's corner chrome.
 * Phase 5: 44px minimum on coarse-pointer (touch) layouts. */
export function IconBtn({
  active = false,
  className = "",
  label,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  label: string;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      {...props}
      className={`w-8 h-8 rounded-full bg-icy text-mutedink grid place-items-center
        shadow-[inset_0_0_0_2px_#E4EBF3] hover:text-ink shrink-0
        font-display font-bold transition-colors
        [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:min-h-[44px]
        ${active ? "ring-2 ring-cta text-ink" : ""} ${className}`}
    />
  );
}
