"use client";
import { useState } from "react";
import { Card } from "./Card";
import { ChunkyButton } from "./ChunkyButton";
import { IconBtn } from "./IconBtn";

/** Centered chevron (an SVG, not a text glyph — ‹/› glyphs carry uneven
 * side bearings and never sit truly centered in the 32px circle). */
function FoldChevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
      className={`transition-transform duration-200 ${open ? "" : "rotate-180"}`}
    >
      <path
        d="M7.5 2.5 4 6l3.5 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function HeroCard({
  onBoard,
  onHow,
  onSearchToggle,
  searchOpen,
  onClaim,
}: {
  onBoard: () => void;
  onHow: () => void;
  onSearchToggle: () => void;
  searchOpen: boolean;
  onClaim: () => void;
}) {
  const [folded, setFolded] = useState(false);

  if (folded) {
    return (
      <Card className="w-[179px] max-w-[calc(100vw-36px)] rounded-[18px] px-3 py-3 shadow-float overflow-hidden transition-[width] duration-200 ease-out">
        <div className="flex items-center gap-[9px] flex-nowrap animate-hero-in" id="hero-pill-body">
          <IconBtn label="Board" onClick={onBoard}>🏆</IconBtn>
          <IconBtn label="How it works" onClick={onHow}>i</IconBtn>
          <IconBtn label="Search" active={searchOpen} onClick={onSearchToggle} id="chrome-search-toggle">🔍</IconBtn>
          <IconBtn
            label="Unfold panel"
            aria-expanded={false}
            aria-controls="hero-pill-body"
            onClick={() => setFolded(false)}
          >
            <FoldChevron open={false} />
          </IconBtn>
        </div>
      </Card>
    );
  }

  return (
    <Card className="w-[398px] max-w-[calc(100vw-36px)] rounded-[18px] px-4 pt-4 pb-[15px] shadow-float overflow-hidden transition-[width] duration-200 ease-out">
      <div id="hero-pill-body" className="animate-hero-in">
        <h1 className="font-display text-base leading-[1.15] font-bold whitespace-nowrap max-[440px]:whitespace-normal">
          Put your startup on the table. Literally.
        </h1>
        <div className="mt-[13px] flex items-center gap-[9px] flex-nowrap">
          <ChunkyButton className="text-sm px-[18px] h-10 whitespace-nowrap shrink-0 !rounded-full !border-b-[3px]" onClick={onClaim}>
            Claim an element · from $5
          </ChunkyButton>
          <IconBtn label="Board" onClick={onBoard}>🏆</IconBtn>
          <IconBtn label="How it works" onClick={onHow}>i</IconBtn>
          <IconBtn label="Search" active={searchOpen} onClick={onSearchToggle} id="chrome-search-toggle">🔍</IconBtn>
          <IconBtn
            label="Fold panel"
            aria-expanded={true}
            aria-controls="hero-pill-body"
            onClick={() => setFolded(true)}
          >
            <FoldChevron open={true} />
          </IconBtn>
        </div>
      </div>
    </Card>
  );
}
