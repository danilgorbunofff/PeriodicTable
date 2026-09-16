"use client";
import { useState } from "react";
import { logoSrc } from "../lib/screenshots";

/** Favicon/logo with graceful fallback — an icy initial chip when the image
 *  is missing or fails to load (flaky favicon services, dead domains). */
export function Avatar({
  src,
  domain,
  size = 20,
  rounded = "rounded-[5px]",
  className = "",
}: {
  src?: string;
  domain: string;
  size?: number;
  rounded?: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const dims = { width: size, height: size };

  // R16-3: both generations of stored icon (the icon service's own URL, and the
  // proxy path) resolve here, so a legacy row behaves like a current one.
  const href = logoSrc(src, domain, size);

  if (!href || failed) {
    return (
      <div
        style={dims}
        className={`shrink-0 ${rounded} bg-icy grid place-items-center font-display font-bold text-ink ${className}`}
      >
        <span style={{ fontSize: Math.max(9, size * 0.44) }}>
          {domain.trim().charAt(0).toUpperCase() || "?"}
        </span>
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={href}
      alt=""
      style={dims}
      onError={() => setFailed(true)}
      className={`shrink-0 ${rounded} ${className}`}
    />
  );
}
