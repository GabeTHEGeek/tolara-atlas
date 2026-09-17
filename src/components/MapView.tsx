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
      map.addSource("pins", {
        type: "geojson",
        data: pinsToGeoJSON(pinsByIdRef.current.size ? [...pinsByIdRef.current.values()] : []),
        cluster: true,
        // Kept high (close to the map's own maxZoom) so clustering keeps
        // merging pins that are still close together on screen instead of
        // forcing everything apart past a fixed zoom threshold — nearby
        // pins only separate once they're genuinely far apart in pixels
        // at the current zoom, which reads as "zooming into a neighborhood"
        // rather than an abrupt reveal of every jittered pin at once.
        clusterMaxZoom: 14,
        clusterRadius: 70,
      });

      map.addLayer({
        id: "clusters",
        type: "circle",
        source: "pins",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": ["step", ["get", "point_count"], "#5B8DEF", 5, "#3D6FD1", 15, "#274B94"],
          "circle-radius": ["step", ["get", "point_count"], 20, 5, 28, 15, 36, 40, 46],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
        },
      });

      map.addLayer({
        id: "cluster-count",
        type: "symbol",
        source: "pins",
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-font": ["Noto Sans Bold"],
          "text-size": 13,
        },
        paint: { "text-color": "#ffffff" },
      });

      map.addLayer({
        id: "unclustered-point",
        type: "circle",
        source: "pins",
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-color": "#E8543E",
          "circle-radius": 7,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
        },
      });

      map.on("click", "clusters", async (e) => {
        const features = map.queryRenderedFeatures(e.point, { layers: ["clusters"] });
        const clusterId = features[0]?.properties?.cluster_id;
        if (clusterId == null) return;
        const source = map.getSource("pins") as GeoJSONSource;
        const zoom = await source.getClusterExpansionZoom(clusterId);
        const coords = (features[0].geometry as GeoJSON.Point).coordinates as [number, number];
        map.easeTo({ center: coords, zoom });
      });

      map.on("click", "unclustered-point", (e) => {
        const feature = e.features?.[0];
        const id = feature?.properties?.id;
        if (id == null) return;
        const pin = pinsByIdRef.current.get(id);
        if (pin) onSelectPin(pin);
      });

      map.on("mouseenter", "clusters", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "clusters", () => (map.getCanvas().style.cursor = ""));

      map.on("mouseenter", "unclustered-point", (e) => {
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
      });
      map.on("mouseleave", "unclustered-point", () => {
        map.getCanvas().style.cursor = "";
        hoverPopupRef.current?.remove();
      });
    });

    return () => {
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
