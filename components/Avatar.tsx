"use client";
import { useState } from "react";
import { faviconFor, isUpstreamFaviconUrl } from "../lib/screenshots";

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

  // R16-3: rows written before the icon proxy existed hold the icon service's
  // own URL, and rendering one would send the visitor's IP to Google from a page
  // the privacy policy says does not. They are served through our proxy instead,
  // so both generations of data behave the same way.
  const href = isUpstreamFaviconUrl(src) ? faviconFor(domain, size) : src;

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
