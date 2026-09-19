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

// Below this zoom, every city with more than one company's pin collapses
// into a single city bubble (see cityClustersToGeoJSON); at or above it the
// bubbles disappear and the individual pins show. This is our own grouping
// by city name, not MapLibre's `cluster: true` -- see the note on the
// "pins" source below for why that's off the table.
const CITY_CLUSTER_MAX_ZOOM = 9;

// How long clicking a city bubble takes to fly into that city. Deliberately
// slow so the move reads as "zooming into this area" rather than a jump.
// Marked `essential` below: without it MapLibre skips the animation entirely
// whenever the OS has Reduce Motion on (prefers-reduced-motion), and the
// click just teleports -- which reads as the feature being broken.
const CITY_FLY_DURATION_MS = 2500;

// Same-place spellings the geocoder currently emits under different names,
// folded together so one city doesn't show up as two bubbles on top of
// each other.
const CITY_NAME_ALIASES: Record<string, string> = {
  "new york city": "new york",
};

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

function cityKey(pin: LocationPinData): string {
  const city = (pin.city ?? "").trim().toLowerCase();
  return `${CITY_NAME_ALIASES[city] ?? city}|${(pin.state ?? "").trim().toLowerCase()}`;
}

/** Pins grouped by cityKey, keeping only cities with 2+ pins -- a lone company's city just shows its pin. */
function groupPinsByCity(pins: LocationPinData[]): Map<string, LocationPinData[]> {
  const groups = new Map<string, LocationPinData[]>();
  for (const pin of pins) {
    const key = cityKey(pin);
    const list = groups.get(key) ?? [];
    list.push(pin);
    groups.set(key, list);
  }
  for (const [key, list] of groups) {
    if (list.length < 2) groups.delete(key);
  }
  return groups;
}

function pinsToGeoJSON(pins: LocationPinData[]): GeoJSON.FeatureCollection<GeoJSON.Point> {
  const clustered = groupPinsByCity(pins);
  return {
    type: "FeatureCollection",
    features: pins.map((p) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p.longitude, p.latitude] },
      properties: { id: p.id, name: p.companyName, roleCount: p.roleCount, inCluster: clustered.has(cityKey(p)) },
    })),
  };
}

/**
 * One bubble per city with 2+ companies, placed at the average of that
 * city's pins (they're all within the export's ~1.5km jitter ring of the
 * city's geocoded point anyway). Labeled with the first pin's own spelling
 * of the city, which after CITY_NAME_ALIASES is the same place for all.
 */
function cityClustersToGeoJSON(pins: LocationPinData[]): GeoJSON.FeatureCollection<GeoJSON.Point> {
  const features: GeoJSON.Feature<GeoJSON.Point>[] = [];
  for (const [key, cityPins] of groupPinsByCity(pins)) {
    const lng = cityPins.reduce((sum, p) => sum + p.longitude, 0) / cityPins.length;
    const lat = cityPins.reduce((sum, p) => sum + p.latitude, 0) / cityPins.length;
    const { city, state } = cityPins[0];
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lng, lat] },
      properties: {
        key,
        label: state ? `${city}, ${state}` : String(city),
        companyCount: cityPins.length,
        roleCount: cityPins.reduce((sum, p) => sum + p.roleCount, 0),
      },
    });
  }
  return { type: "FeatureCollection", features };
}

// Filter for the per-pin layers: below CITY_CLUSTER_MAX_ZOOM, only pins
// whose city ISN'T drawn as a bubble; from there up, every pin.
const PIN_VISIBILITY_FILTER: maplibregl.FilterSpecification = [
  "step",
  ["zoom"],
  ["==", ["get", "inCluster"], false],
  CITY_CLUSTER_MAX_ZOOM,
  true,
];

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
      const initialPins = [...pinsByIdRef.current.values()];
      map.addSource("pins", { type: "geojson", data: pinsToGeoJSON(initialPins) });
      map.addSource("city-clusters", { type: "geojson", data: cityClustersToGeoJSON(initialPins) });

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
        filter: PIN_VISIBILITY_FILTER,
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
        filter: PIN_VISIBILITY_FILTER,
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

      // City bubbles, drawn above the pins. Sized by how many PM roles the
      // city has; larger cities sort on top where bubbles overlap (e.g. the
      // Bay Area at the national view).
      map.addLayer({
        id: "city-clusters-layer",
        type: "circle",
        source: "city-clusters",
        maxzoom: CITY_CLUSTER_MAX_ZOOM,
        layout: { "circle-sort-key": ["get", "roleCount"] },
        paint: {
          "circle-color": "#E8543E",
          "circle-opacity": 0.9,
          "circle-radius": ["step", ["get", "roleCount"], 13, 10, 16, 40, 20, 150, 25],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
        },
      });
      map.addLayer({
        id: "city-clusters-count",
        type: "symbol",
        source: "city-clusters",
        maxzoom: CITY_CLUSTER_MAX_ZOOM,
        layout: {
          "text-field": ["to-string", ["get", "companyCount"]],
          "text-font": ["Noto Sans Regular"],
          "text-size": 12,
          // Where neighboring cities' bubbles overlap (Bay Area, Seattle/
          // Bellevue), let collision detection keep only the biggest city's
          // number instead of printing several on top of each other. Lower
          // sort keys are placed first, so negate roleCount.
          "symbol-sort-key": ["-", 0, ["get", "roleCount"]],
        },
        paint: { "text-color": "#ffffff" },
      });
      // City names under the bubbles; collision detection drops the ones
      // that would overlap at the national view, same as the pin labels.
      map.addLayer({
        id: "city-clusters-labels",
        type: "symbol",
        source: "city-clusters",
        maxzoom: CITY_CLUSTER_MAX_ZOOM,
        layout: {
          "text-field": ["get", "label"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 11,
          "text-anchor": "top",
          "text-offset": [0, 1.9],
          "text-optional": true,
          "symbol-sort-key": ["-", 0, ["get", "roleCount"]],
        },
        paint: {
          "text-color": "#1A2233",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.4,
        },
      });

      map.on("click", "city-clusters-layer", (e) => {
        const key = e.features?.[0]?.properties?.key;
        if (key == null) return;
        const cityPins = [...pinsByIdRef.current.values()].filter((p) => cityKey(p) === key);
        if (cityPins.length === 0) return;
        const bounds = new maplibregl.LngLatBounds();
        for (const p of cityPins) bounds.extend([p.longitude, p.latitude]);
        const camera = map.cameraForBounds(bounds, { padding: 80, maxZoom: 13 });
        hoverPopupRef.current?.remove();
        map.flyTo({
          center: camera?.center ?? bounds.getCenter(),
          // Always land past CITY_CLUSTER_MAX_ZOOM, so the bubble actually
          // opens up into its pins instead of reappearing at the same spot.
          zoom: Math.max(camera?.zoom ?? 0, CITY_CLUSTER_MAX_ZOOM + 1),
          duration: CITY_FLY_DURATION_MS,
          essential: true,
        });
      });
      map.on("mouseenter", "city-clusters-layer", (e) => {
        map.getCanvas().style.cursor = "pointer";
        const feature = e.features?.[0];
        if (!feature) return;
        const coords = (feature.geometry as GeoJSON.Point).coordinates as [number, number];
        const label = String(feature.properties?.label ?? "");
        const companyCount = Number(feature.properties?.companyCount ?? 0);
        const roleCount = Number(feature.properties?.roleCount ?? 0);
        hoverPopupRef.current
          ?.setLngLat(coords)
          .setHTML(
            `<strong>${escapeHtml(label)}</strong><br/>${companyCount} companies · ${roleCount} open PM role${roleCount === 1 ? "" : "s"}<br/><span class="pin-tooltip-hint">Click to zoom in</span>`,
          )
          .addTo(map);
      });
      map.on("mouseleave", "city-clusters-layer", () => {
        map.getCanvas().style.cursor = "";
        hoverPopupRef.current?.remove();
      });

      // A lone-company city's pin can sit underneath a neighboring city's
      // bubble (e.g. Berkeley under San Francisco at the national view).
      // The bubble is drawn on top, so it owns the click/hover there --
      // otherwise one click both flies into the city AND opens that pin's
      // company panel.
      const isUnderCityBubble = (point: maplibregl.PointLike) =>
        map.queryRenderedFeatures(point, { layers: ["city-clusters-layer"] }).length > 0;

      map.on("click", "pins-layer", (e) => {
        if (isUnderCityBubble(e.point)) return;
        const feature = e.features?.[0];
        const id = feature?.properties?.id;
        if (id == null) return;
        const pin = pinsByIdRef.current.get(id);
        if (pin) onSelectPin(pin);
      });

      map.on("mouseenter", "pins-layer", (e) => {
        if (isUnderCityBubble(e.point)) return;
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
      map.on("mouseleave", "pins-layer", (e) => {
        // Still over a city bubble: leave its cursor and tooltip alone.
        if (!isUnderCityBubble(e.point)) {
          map.getCanvas().style.cursor = "";
          hoverPopupRef.current?.remove();
        }
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
      const clusterSource = map.getSource("city-clusters") as GeoJSONSource | undefined;
      if (clusterSource) clusterSource.setData(cityClustersToGeoJSON(pins));

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
