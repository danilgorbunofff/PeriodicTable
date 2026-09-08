/** Claimed-exotic tile FX (per-symbol, unique per exotic element).
 *
 * Exotic faces, glyphs and text come from the themed system
 * (lib/exoticThemes.ts + .exotic-tile CSS). This file adds the animated
 * treatment a claimed exotic gets ON TOP of its themed face: a breathing
 * ambient glow plus exactly one signature motion per symbol — shine sweep
 * (Hbar), cyan/magenta border beam (Ps), violet border beam (Uue), twinkle
 * starfield (DM). Unclaimed exotics mount no FX layers.
 *
 * All layers are transparent transform/opacity/filter overlays and are
 * killed by the existing prefers-reduced-motion block.
 */
export type ExoticStyle = {
  /** Ambient border glow color (pulse). */
  glow: string;
  /** Rotating border beam gradient stops [bright, deep]; renders the beam. */
  beam?: [string, string];
  /** Face shine sweep. */
  shine?: boolean;
  /** Twinkle starfield overlay. */
  stars?: boolean;
};

export const EXOTIC_STYLES: Record<string, ExoticStyle> = {
  Hbar: {
    glow: "rgba(255,176,64,0.85)",
    shine: true,
  },
  Ps: {
    glow: "rgba(34,211,238,0.8)",
    beam: ["rgba(103,232,249,0.95)", "rgba(232,121,249,0.8)"],
  },
  Uue: {
    glow: "rgba(139,92,246,0.85)",
    beam: ["rgba(196,181,253,0.9)", "rgba(124,58,237,0.75)"],
  },
  DM: {
    glow: "rgba(140,150,255,0.55)",
    stars: true,
  },
};
