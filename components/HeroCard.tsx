"use client";
import { useState } from "react";
import { Card } from "./Card";
import { ChunkyButton } from "./ChunkyButton";
import { IconBtn } from "./IconBtn";

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
      <Card className="w-fit rounded-[18px] px-3 py-3 shadow-float">
        <div className="flex items-center gap-[9px] flex-nowrap" id="hero-pill-body">
          <IconBtn label="Board" onClick={onBoard}>🏆</IconBtn>
          <IconBtn label="How it works" onClick={onHow}>i</IconBtn>
          <IconBtn label="Search" active={searchOpen} onClick={onSearchToggle} id="chrome-search-toggle">🔍</IconBtn>
          <IconBtn
            label="Unfold panel"
            aria-expanded={false}
            aria-controls="hero-pill-body"
            onClick={() => setFolded(false)}
          >
            ›
          </IconBtn>
        </div>
      </Card>
    );
  }

  return (
    <Card className="w-[360px] max-w-[calc(100vw-36px)] rounded-[18px] px-4 pt-4 pb-[15px] shadow-float">
      <div id="hero-pill-body">
        <h1 className="pr-10 font-display text-base leading-[1.15] font-bold whitespace-nowrap max-[440px]:whitespace-normal">
          Put your startup on the table. Literally.
        </h1>
        <div className="mt-[13px] flex items-center justify-between gap-[9px]">
          <ChunkyButton className="text-sm px-[18px] h-10 whitespace-nowrap shrink-0 !rounded-full !border-b-[3px]" onClick={onClaim}>
            Claim an element · from $5
          </ChunkyButton>
          <div className="flex items-center gap-[9px] flex-nowrap">
            <IconBtn label="Board" onClick={onBoard}>🏆</IconBtn>
            <IconBtn label="How it works" onClick={onHow}>i</IconBtn>
            <div className="relative shrink-0">
              <IconBtn label="Search" active={searchOpen} onClick={onSearchToggle} id="chrome-search-toggle">🔍</IconBtn>
              <IconBtn
                label="Fold panel"
                aria-expanded={true}
                aria-controls="hero-pill-body"
                onClick={() => setFolded(true)}
                className="absolute bottom-[calc(100%+3px)] left-0"
              >
                ‹
              </IconBtn>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}
