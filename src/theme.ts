// Map colors live here (not in CSS) because MapLibre paint properties take
// literal colors; keep them in step with the --accent tokens in styles.css.

// The app follows the system's light or dark setting (styles.css) unless
// the header's switch picked one (data-theme on <html>, saved per browser),
// and the map follows the app: CARTO's free Positron basemap in light mode,
// Dark Matter in dark mode, same no-key terms. Read once at load; the switch
// reloads the page so the map picks up the change.
export type ThemeChoice = "light" | "dark";
const THEME_KEY = "tolara.theme";

export function savedTheme(): ThemeChoice | null {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

/** The theme in use: the saved choice, else the system's. */
export function currentTheme(): ThemeChoice {
  const saved = savedTheme();
  if (saved) return saved;
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches === true ? "dark" : "light";
}

/** Put the theme in use on <html> (saved choice, else the system's) so styles.css can key off it. Called before the first render. */
export function applySavedTheme(): void {
  if (typeof document !== "undefined") document.documentElement.dataset.theme = currentTheme();
}

/** Switch theme, remember it in this browser, and reload so the map's colors follow. */
export function setTheme(choice: ThemeChoice): void {
  try {
    localStorage.setItem(THEME_KEY, choice);
  } catch {
    /* private window: applies to this page only */
  }
  document.documentElement.dataset.theme = choice;
  window.location.reload();
}

const DARK = currentTheme() === "dark";

export const BASEMAP_STYLE = DARK
  ? "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
  : "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

// On the pale light basemap a mid teal washed out, so light mode uses a
// deeper teal for pins and solid navy city bubbles (the app's ink colour),
// with white outlines and thicker label halos.
export const PIN_COLOR = DARK ? "#6fe0c4" : "#04725a"; // --accent, deepened for the light map
export const PIN_STROKE = DARK ? "#0b0e12" : "#ffffff"; // --bg, so pins read as cut-outs on the map
export const CLUSTER_COLOR = DARK ? "#6fe0c4" : "#0a2540";
export const CLUSTER_TEXT = DARK ? "#07201a" : "#ffffff";
export const LABEL_TEXT = DARK ? "#d7dde5" : "#0a2540";
export const LABEL_HALO = DARK ? "#0b0e12" : "#ffffff";
export const LABEL_HALO_WIDTH = DARK ? 1.4 : 2;
