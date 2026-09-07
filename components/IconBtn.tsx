import { ButtonHTMLAttributes } from "react";

/** Compact icy HUD control, matching worldmap.lol's corner chrome. */
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
      className={`w-8 h-8 rounded-full bg-icy text-muted grid place-items-center
        shadow-[inset_0_0_0_2px_#E4EBF3] hover:text-ink shrink-0
        font-display font-bold transition-colors
        ${active ? "ring-2 ring-cta text-ink" : ""} ${className}`}
    />
  );
}
