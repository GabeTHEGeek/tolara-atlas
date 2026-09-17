import { useEffect, useRef } from "react";
import maplibregl, { type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { CompanyData } from "../types.js";

// CARTO's free, no-API-key-required basemap tiles (Positron: clean, light,
// good contrast for data points on top of it). Fine for this traffic level
// under CARTO's free-tier terms; swap for a paid provider if this ever
// becomes a real production SaaS with heavy traffic.
const BASEMAP_STYLE = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

// Roughly centers the contiguous US at a zoom that shows the whole country.
const INITIAL_VIEW = { center: [-98.5, 39.5] as [number, number], zoom: 3.4 };

interface MapViewProps {
  companies: CompanyData[];
  onSelectCompany: (company: CompanyData) => void;
}

function companiesToGeoJSON(companies: CompanyData[]): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: "FeatureCollection",
    features: companies.map((c) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [c.longitude, c.latitude] },
      properties: { id: c.id, name: c.name, roleCount: c.roleCount },
    })),
  };
}

export default function MapView({ companies, onSelectCompany }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  // Kept alongside the map instance so click handlers (registered once,
  // when the map loads) can look up the current company list without
  // re-registering every time `companies` changes identity.
  const companiesByIdRef = useRef<Map<number, CompanyData>>(new Map());

  useEffect(() => {
    companiesByIdRef.current = new Map(companies.map((c) => [c.id, c]));
  }, [companies]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BASEMAP_STYLE,
      center: INITIAL_VIEW.center,
      zoom: INITIAL_VIEW.zoom,
      minZoom: 2,
      maxZoom: 14,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    map.on("load", () => {
      map.addSource("companies", {
        type: "geojson",
        data: companiesToGeoJSON(companiesByIdRef.current.size ? [...companiesByIdRef.current.values()] : []),
        cluster: true,
        clusterMaxZoom: 12,
        clusterRadius: 45,
      });

      map.addLayer({
        id: "clusters",
        type: "circle",
        source: "companies",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": ["step", ["get", "point_count"], "#5B8DEF", 10, "#3D6FD1", 30, "#274B94"],
          "circle-radius": ["step", ["get", "point_count"], 16, 10, 22, 30, 28],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
        },
      });

      map.addLayer({
        id: "cluster-count",
        type: "symbol",
        source: "companies",
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-font": ["Noto Sans Bold"],
          "text-size": 12,
        },
        paint: { "text-color": "#ffffff" },
      });

      map.addLayer({
        id: "unclustered-point",
        type: "circle",
        source: "companies",
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
        const source = map.getSource("companies") as GeoJSONSource;
        const zoom = await source.getClusterExpansionZoom(clusterId);
        const coords = (features[0].geometry as GeoJSON.Point).coordinates as [number, number];
        map.easeTo({ center: coords, zoom });
      });

      map.on("click", "unclustered-point", (e) => {
        const feature = e.features?.[0];
        const id = feature?.properties?.id;
        if (id == null) return;
        const company = companiesByIdRef.current.get(id);
        if (company) onSelectCompany(company);
      });

      map.on("mouseenter", "clusters", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "clusters", () => (map.getCanvas().style.cursor = ""));
      map.on("mouseenter", "unclustered-point", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "unclustered-point", () => (map.getCanvas().style.cursor = ""));
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the map's data source in sync whenever the company list changes
  // after the map has already loaded (e.g. once the fetch resolves).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const source = map.getSource("companies") as GeoJSONSource | undefined;
    if (source) source.setData(companiesToGeoJSON(companies));
  }, [companies]);

  return <div ref={containerRef} className="map-container" />;
}
