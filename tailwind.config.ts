import type { Config } from "tailwindcss";

// DESIGN-SYSTEM §2 — locked tokens (twin of worldmap.lol)
const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        stage: "#05070A",
        stagemid: "#0A1720",
        cardbg: "#FFFFFF",
        ink: "#1F2B3E",
        muted: "#8494AB",
        // Phase 5 AA text variants (plan remediation §Visual accessibility):
        // base hues are decorative-safe, but fail as small-text foregrounds.
        // *-ink keep the hue family and pass 4.5:1 on white/icy/goldwash AND
        // all 11 family pastel fills (tiles render 6-8px text on pastels).
        mutedink: "#33475F", // 9.03 white / min 5.21 worst pastel (NOBLE_GAS)
        moneyink: "#5F4700", // 8.13 white / min 4.81 worst pastel (NOBLE_GAS)
        liveink: "#16573A", // 7.66 white / min 4.67 worst pastel (NOBLE_GAS)
        hairline: "#E4EBF3",
        icy: "#F2F7FC",
        cta: "#FFC93C",
        ctalip: "#E8AC12",
        ctahover: "#FFD45C",
        money: "#B8860B",
        goldwash: "#FFF5DB",
        goldwashedge: "#F5D480",
        sale: "#F18B42", // bg only — pill text uses ink (5.78) for AA
        live: "#59C794",
        visit: "#0F172A",
        profilebg: "#EFF5FC",
        board: "#E9F0F8",
      },
      fontFamily: {
        sans: ["var(--font-body)", "Nunito", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "Fredoka", "system-ui", "sans-serif"],
      },
      borderRadius: {
        card: "24px",
        btn: "18px",
      },
      boxShadow: {
        card: "0 18px 50px rgba(0,0,0,.28)",
        float: "0 8px 24px rgba(0,0,0,.24)",
      },
    },
  },
  plugins: [],
};
export default config;
