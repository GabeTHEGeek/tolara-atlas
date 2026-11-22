// Map colors live here (not in CSS) because MapLibre paint properties take
// literal colors; keep them in step with the --accent tokens in styles.css.

// The app follows the system's light or dark setting (styles.css), so the
// map does too: CARTO's free Positron basemap in light mode, Dark Matter in
// dark mode, same no-key terms. Read once at load; a theme switch shows on
// the next reload.
const DARK = typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;

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
