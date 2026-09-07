import { ButtonHTMLAttributes } from "react";

/** Chunky CTA: #FFC93C fill + #E8AC12 lip. Yellow = claim/stake only.
 *  Sizing comes from the call site (no h-/px-/text- defaults here — avoids
 *  conflicting Tailwind utilities where stylesheet order, not class order, wins). */
export function ChunkyButton({
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`bg-cta text-ink font-display font-semibold rounded-[14px]
        border-b-4 border-ctalip hover:bg-ctahover
        active:translate-y-[2px] active:border-b-2
        transition-all ${className}`}
    />
  );
}
