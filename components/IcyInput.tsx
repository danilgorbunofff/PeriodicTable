import { InputHTMLAttributes } from "react";

/** Icy #F2F7FC input — no hard borders (worldmap checkout/search). */
export function IcyInput({
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full bg-icy rounded-2xl px-4 h-12 text-ink placeholder:text-mutedink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink focus:ring-2 focus:ring-cta ${className}`}
    />
  );
}
