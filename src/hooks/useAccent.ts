import { useEffect } from "react";

export type AccentPreset = {
  color: string;
  vibrant: string;
  shadow: string;
  fg: string;
};

export const ACCENT_PRESETS: Record<string, AccentPreset> = {
  "Brand Blue":      { color: "#0e84c4", vibrant: "#1a96d4", shadow: "rgba(14,132,196,0.45)", fg: "#fff" },
  "Deep Teal":       { color: "oklch(0.95 0.05 160)", vibrant: "oklch(0.92 0.07 160)", shadow: "oklch(0.85 0.08 160 / 0.5)", fg: "oklch(0.2 0.15 180)" },
  "Electric Indigo": { color: "#5E5CE6", vibrant: "#6E6CE6", shadow: "rgba(94,92,230,0.45)", fg: "#fff" },
  "Crisp Blue":      { color: "#0A84FF", vibrant: "#3B9BFF", shadow: "rgba(10,132,255,0.45)", fg: "#fff" },
  "Royal Purple":    { color: "#BF5AF2", vibrant: "#D08CFF", shadow: "rgba(191,90,242,0.45)", fg: "#fff" },
  "Hot Pink":        { color: "#FF375F", vibrant: "#FF6B8A", shadow: "rgba(255,55,95,0.45)", fg: "#fff" },
};

export function useAccent(name: keyof typeof ACCENT_PRESETS | string) {
  useEffect(() => {
    const a = ACCENT_PRESETS[name] ?? ACCENT_PRESETS["Brand Blue"];
    const root = document.documentElement.style;
    root.setProperty("--accent", a.color);
    root.setProperty("--accent-vibrant", a.vibrant);
    root.setProperty("--accent-shadow", a.shadow);
    root.setProperty("--accent-foreground", a.fg);
  }, [name]);
}
