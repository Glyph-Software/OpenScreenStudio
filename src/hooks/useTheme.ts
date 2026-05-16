import { useEffect, useState } from "react";

export type ThemeMode = "light" | "dark" | "system";
export const THEME_KEY = "oss.theme";

export function loadThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* localStorage unavailable — fall back to system */
  }
  return "system";
}

export function saveThemeMode(mode: ThemeMode) {
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    /* localStorage unavailable — selection stays session-only */
  }
}

/**
 * Resolves `mode` to a concrete "light"/"dark" and writes it to
 * <html data-theme>. When `mode` is "system" it follows (and subscribes to)
 * the OS appearance via prefers-color-scheme.
 */
export function useTheme(mode: ThemeMode) {
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = mode === "system" ? (mq.matches ? "dark" : "light") : mode;
      document.documentElement.setAttribute("data-theme", resolved);
    };
    apply();
    if (mode === "system") {
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [mode]);
}

/**
 * Theme state owned at the app root. Persists to localStorage and stays in
 * sync across Tauri windows (same-origin webviews share localStorage and
 * receive the cross-window `storage` event).
 */
export function useThemeMode(): [ThemeMode, (next: ThemeMode) => void] {
  const [mode, setMode] = useState<ThemeMode>(loadThemeMode);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_KEY) setMode(loadThemeMode());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const set = (next: ThemeMode) => {
    setMode(next);
    saveThemeMode(next);
  };

  return [mode, set];
}
