// Map colors live here (not in CSS) because MapLibre paint properties take
// literal colors; keep them in step with the --accent tokens in styles.css.

// CARTO's free Dark Matter basemap -- the dark counterpart of the Positron
// style used before the restyle; same no-key terms.
export const BASEMAP_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

export const PIN_COLOR = "#6fe0c4"; // --accent
export const PIN_STROKE = "#0b0e12"; // --bg, so pins read as cut-outs on the dark map
export const CLUSTER_TEXT = "#07201a"; // dark ink on teal bubbles
export const LABEL_TEXT = "#d7dde5";
export const LABEL_HALO = "#0b0e12";
