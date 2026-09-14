import { NextResponse } from "next/server";
import { renderOgCardSvg } from "@/lib/ogCard";
import { OG_HOME_CARD, renderCardPng } from "@/lib/ogCardImage";

/**
 * Home card (R01-1): the image `/` advertises as its og:image. Fixed copy and no
 * database read. Deliberately dynamic — a satori failure then falls back to the
 * SVG card at request time instead of baking a broken image into the build.
 */
export async function GET() {
  const png = await renderCardPng(OG_HOME_CARD);
  if (png) {
    return new NextResponse(png, {
      headers: { "Content-Type": "image/png", "Cache-Control": "s-maxage=86400, stale-while-revalidate=604800" },
    });
  }
  return new NextResponse(renderOgCardSvg(OG_HOME_CARD), {
    headers: { "Content-Type": "image/svg+xml", "Cache-Control": "s-maxage=3600, stale-while-revalidate=86400" },
  });
}
