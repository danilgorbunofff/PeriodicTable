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
        card: "#FFFFFF",
        ink: "#1F2B3E",
        muted: "#8494AB",
        hairline: "#E4EBF3",
        icy: "#F2F7FC",
        cta: "#FFC93C",
        ctalip: "#E8AC12",
        ctahover: "#FFD45C",
        money: "#B8860B",
        goldwash: "#FFF5DB",
        goldwashedge: "#F5D480",
        sale: "#F18B42",
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
        card: "0 26px 60px rgba(0,0,0,.30)",
        float: "0 8px 24px rgba(0,0,0,.24)",
      },
    },
  },
  plugins: [],
};
export default config;
