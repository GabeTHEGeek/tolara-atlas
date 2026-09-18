import { useEffect, useRef } from "react";
import maplibregl, { type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { LocationPinData } from "../types.js";

// CARTO's free, no-API-key-required basemap tiles (Positron: clean, light,
// good contrast for data points on top of it). Fine for this traffic level
// under CARTO's free-tier terms; swap for a paid provider if this ever
// becomes a real production SaaS with heavy traffic.
const BASEMAP_STYLE = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

// Fallback view (whole contiguous US) used only until real pin data loads
// and the map can fit itself to where the data actually is.
const FALLBACK_VIEW = { center: [-98.5, 39.5] as [number, number], zoom: 3.4 };

// Below this zoom, the view spans too much ground for per-pin company
// names to be legible (or numerous) enough to show; above it, labels
// fade in above each pin.
const PIN_LABEL_MIN_ZOOM = 7;

// The classic MapLibre/Mapbox "marching ants" dash sequence: each entry is
// a line-dasharray that's slightly further along than the last, so cycling
// through them on a timer reads as a dash animating along the line rather
// than a static pattern. Half of the sequence is the dash growing from a
// point into a full dash (indices 0-6), the other half is that same dash
// sliding along the line (7-19) -- stepping through both halves in order
// gives one full, seamless loop.
const DASH_SEQUENCE: number[][] = [
  [0, 4, 3],
  [0.5, 4, 2.5],
  [1, 4, 2],
  [1.5, 4, 1.5],
  [2, 4, 1],
  [2.5, 4, 0.5],
  [3, 4, 0],
  [0, 0.3, 3, 3.7],
  [0, 0.6, 3, 3.4],
  [0, 0.9, 3, 3.1],
  [0, 1.2, 3, 2.8],
  [0, 1.5, 3, 2.5],
  [0, 1.8, 3, 2.2],
  [0, 2.1, 3, 1.9],
  [0, 2.4, 3, 1.6],
  [0, 2.7, 3, 1.3],
  [0, 3, 3, 1],
  [0, 3.3, 3, 0.7],
  [0, 3.6, 3, 0.4],
  [0, 3.9, 3, 0.1],
];
const DASH_STEP_MS = 40; // ~25fps -- smooth enough for a slow "marching" read, cheap enough to run indefinitely

interface MapViewProps {
  pins: LocationPinData[];
  onSelectPin: (pin: LocationPinData) => void;
}

function pinsToGeoJSON(pins: LocationPinData[]): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: "FeatureCollection",
    features: pins.map((p) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p.longitude, p.latitude] },
      properties: { id: p.id, name: p.companyName, roleCount: p.roleCount },
    })),
  };
}

const EMPTY_LINES: GeoJSON.FeatureCollection<GeoJSON.LineString> = { type: "FeatureCollection", features: [] };

/**
 * One line per OTHER office of the same company, radiating out from
 * `originId`'s pin -- not a fully-connected mesh between every pair, which
 * would double-draw edges and get messy past 3 offices. A company with
 * only one pin (no other office to connect to) produces no lines.
 */
function officeLinksFromPin(
  allPins: LocationPinData[],
  originId: string,
): GeoJSON.FeatureCollection<GeoJSON.LineString> {
  const origin = allPins.find((p) => p.id === originId);
  if (!origin) return EMPTY_LINES;
  const siblings = allPins.filter((p) => p.companyId === origin.companyId && p.id !== origin.id);
  if (siblings.length === 0) return EMPTY_LINES;

  return {
    type: "FeatureCollection",
    features: siblings.map((s) => ({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [
          [origin.longitude, origin.latitude],
          [s.longitude, s.latitude],
        ],
      },
      properties: {},
    })),
  };
}

export default function MapView({ pins, onSelectPin }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  // Kept alongside the map instance so click/hover handlers (registered
  // once, when the map loads) can look up the current pin list without
  // re-registering every time `pins` changes identity.
  const pinsByIdRef = useRef<Map<string, LocationPinData>>(new Map());
  const hoverPopupRef = useRef<maplibregl.Popup | null>(null);
  // Only auto-fit the view to the data once, the first time real pins
  // arrive — otherwise every re-render (e.g. after a click) would yank
  // the view back to "fit everything."
  const hasFitBoundsRef = useRef(false);
  // Drives the marching-ants animation on the office-links layer. Only
  // running while a multi-office company is actually hovered (started in
  // mouseenter, cancelled in mouseleave below) rather than continuously --
  // no point animating an invisible, empty-data layer.
  const dashAnimFrameRef = useRef<number | null>(null);

  useEffect(() => {
    pinsByIdRef.current = new Map(pins.map((p) => [p.id, p]));
  }, [pins]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BASEMAP_STYLE,
      center: FALLBACK_VIEW.center,
      zoom: FALLBACK_VIEW.zoom,
      minZoom: 2,
      maxZoom: 14,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    hoverPopupRef.current = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 12,
      className: "pin-tooltip",
    });

    map.on("load", () => {
      // NOTE: this source is deliberately NOT clustered (cluster: true).
      // Enabling clustering here reliably breaks rendering entirely — not
      // just the clustered layer, but the basemap's own vector tiles too
      // (maplibre-gl shares one worker pool between GeoJSON and vector-tile
      // parsing, and something about clustering this source wedges it).
      // Confirmed with the exact same result in `vite dev`, a real
      // `vite build` + `vite preview`, and multiple clusterMaxZoom/Radius
      // values — so this isn't a dev-only quirk to work around later, it's
      // a hard incompatibility to avoid. Individual pins (with the jitter
      // spread for same-city companies) plus fitBounds on load are what
      // keep the initial view legible without algorithmic clustering.
      map.addSource("pins", {
        type: "geojson",
        data: pinsToGeoJSON(pinsByIdRef.current.size ? [...pinsByIdRef.current.values()] : []),
      });

      // Connector lines between a hovered pin and its company's OTHER
      // offices -- empty until a multi-office company is hovered (see the
      // mouseenter/mouseleave handlers below). Added, and drawn, before
      // "pins-layer" so the lines sit under the pin circles instead of
      // covering them.
      map.addSource("office-links", { type: "geojson", data: EMPTY_LINES });
      map.addLayer({
        id: "office-links-layer",
        type: "line",
        source: "office-links",
        layout: { "line-cap": "round" },
        paint: {
          "line-color": "#E8543E",
          "line-width": 2,
          "line-opacity": 0.75,
          "line-dasharray": DASH_SEQUENCE[0],
        },
      });

      map.addLayer({
        id: "pins-layer",
        type: "circle",
        source: "pins",
        paint: {
          "circle-color": "#E8543E",
          "circle-radius": 7,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
        },
      });

      // Company-name labels. Hidden below PIN_LABEL_MIN_ZOOM (the initial
      // fitted view is well below this) so the map isn't a wall of text
      // at the zoomed-out overview; once you zoom in past a city/region,
      // names appear above each pin. text-allow-overlap is left false so
      // MapLibre's own collision detection hides labels that would
      // overlap rather than piling them on top of each other — zooming
      // in further naturally reveals the ones that got hidden.
      map.addLayer({
        id: "pins-labels",
        type: "symbol",
        source: "pins",
        minzoom: PIN_LABEL_MIN_ZOOM,
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 12,
          "text-anchor": "top",
          "text-offset": [0, 0.9],
          "text-allow-overlap": false,
          "text-optional": true,
        },
        paint: {
          "text-color": "#1A2233",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.4,
        },
      });

      map.on("click", "pins-layer", (e) => {
        const feature = e.features?.[0];
        const id = feature?.properties?.id;
        if (id == null) return;
        const pin = pinsByIdRef.current.get(id);
        if (pin) onSelectPin(pin);
      });

      map.on("mouseenter", "pins-layer", (e) => {
        map.getCanvas().style.cursor = "pointer";
        const feature = e.features?.[0];
        if (!feature) return;
        const coords = (feature.geometry as GeoJSON.Point).coordinates as [number, number];
        const name = String(feature.properties?.name ?? "");
        const roleCount = Number(feature.properties?.roleCount ?? 0);
        const label = `${roleCount} open PM role${roleCount === 1 ? "" : "s"}`;
        hoverPopupRef.current
          ?.setLngLat(coords)
          .setHTML(`<strong>${escapeHtml(name)}</strong><br/>${label}`)
          .addTo(map);

        const id = feature.properties?.id;
        if (id == null) return;
        const linksSource = map.getSource("office-links") as GeoJSONSource | undefined;
        const links = officeLinksFromPin([...pinsByIdRef.current.values()], String(id));
        linksSource?.setData(links);
        if (links.features.length > 0) startDashAnimation(map);
      });
      map.on("mouseleave", "pins-layer", () => {
        map.getCanvas().style.cursor = "";
        hoverPopupRef.current?.remove();
        stopDashAnimation();
        (map.getSource("office-links") as GeoJSONSource | undefined)?.setData(EMPTY_LINES);
      });

      function startDashAnimation(mapInstance: maplibregl.Map) {
        if (dashAnimFrameRef.current != null) return; // already running
        let step = 0;
        let lastTick = 0;
        const tick = (now: number) => {
          if (now - lastTick >= DASH_STEP_MS) {
            lastTick = now;
            step = (step + 1) % DASH_SEQUENCE.length;
            mapInstance.setPaintProperty("office-links-layer", "line-dasharray", DASH_SEQUENCE[step]);
          }
          dashAnimFrameRef.current = requestAnimationFrame(tick);
        };
        dashAnimFrameRef.current = requestAnimationFrame(tick);
      }
      function stopDashAnimation() {
        if (dashAnimFrameRef.current != null) {
          cancelAnimationFrame(dashAnimFrameRef.current);
          dashAnimFrameRef.current = null;
        }
      }
    });

    return () => {
      if (dashAnimFrameRef.current != null) {
        cancelAnimationFrame(dashAnimFrameRef.current);
        dashAnimFrameRef.current = null;
      }
      hoverPopupRef.current?.remove();
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the map's data source in sync whenever the pin list changes after
  // the map has already loaded (e.g. once the fetch resolves), and fit the
  // view to the real data the first time non-empty pins show up.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const applyData = () => {
      const source = map.getSource("pins") as GeoJSONSource | undefined;
      if (source) source.setData(pinsToGeoJSON(pins));

      if (!hasFitBoundsRef.current && pins.length > 0) {
        hasFitBoundsRef.current = true;
        const bounds = new maplibregl.LngLatBounds();
        for (const p of pins) bounds.extend([p.longitude, p.latitude]);
        map.fitBounds(bounds, { padding: 60, maxZoom: 6, duration: 0 });
      }
    };

    if (map.isStyleLoaded()) applyData();
    else map.once("load", applyData);
  }, [pins]);

  return <div ref={containerRef} className="map-container" />;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
