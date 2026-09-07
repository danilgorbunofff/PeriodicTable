"use client";
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
  return (
    <Card className="w-[400px] max-w-[calc(100vw-36px)] rounded-[18px] p-4 shadow-float">
      <h1 className="font-display text-base leading-[1.15] font-bold whitespace-nowrap max-[440px]:whitespace-normal">
        Put your startup on the table. Literally.
      </h1>
      <div className="mt-[13px] flex items-center gap-[9px] flex-nowrap">
        <ChunkyButton className="text-sm px-[18px] h-10 whitespace-nowrap shrink-0 !rounded-full !border-b-[3px]" onClick={onClaim}>
          Claim an element · from $5
        </ChunkyButton>
        <IconBtn label="Board" onClick={onBoard}>🏆</IconBtn>
        <IconBtn label="How it works" onClick={onHow}>i</IconBtn>
        <IconBtn label="Search" active={searchOpen} onClick={onSearchToggle}>🔍</IconBtn>
      </div>
    </Card>
  );
}
