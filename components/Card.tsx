import { ReactNode } from "react";

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`bg-cardbg text-ink rounded-card shadow-card ${className}`}
    >
      {children}
    </div>
  );
}
