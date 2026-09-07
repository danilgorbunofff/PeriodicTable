"use client";
import { useState } from "react";

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

  if (!src || failed) {
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
      src={src}
      alt=""
      style={dims}
      onError={() => setFailed(true)}
      className={`shrink-0 ${rounded} ${className}`}
    />
  );
}
