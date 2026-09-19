import { useEffect, useState } from "react";
import MapView, { type FlyToRequest } from "./components/MapView.js";
import CompanySearch from "./components/CompanySearch.js";
import CompanyPanel from "./components/CompanyPanel.js";
import RemotePanel from "./components/RemotePanel.js";
import type { LocationPinData, MapData } from "./types.js";

export default function App() {
  const [mapData, setMapData] = useState<MapData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedPin, setSelectedPin] = useState<LocationPinData | null>(null);
  const [remotePanelOpen, setRemotePanelOpen] = useState(false);
  const [flyToRequest, setFlyToRequest] = useState<FlyToRequest | null>(null);

  useEffect(() => {
    fetch("/data/map-data.json")
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load map data (HTTP ${res.status})`);
        return res.json();
      })
      .then((data: MapData) => setMapData(data))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <span className="app-logo">TOLARA SCOUT</span>
        {mapData && (
          <span className="app-stats">
            {mapData.companyCount} companies · {mapData.roleCount} open Product Manager roles
            {mapData.remoteCompanies.length > 0 && (
              <>
                {" · "}
                <button
                  className="remote-panel-toggle"
                  onClick={() => {
                    setSelectedPin(null);
                    setRemotePanelOpen(true);
                  }}
                >
                  {mapData.remoteCompanies.reduce((sum, c) => sum + c.roleCount, 0)} more, unmapped
                </button>
              </>
            )}
          </span>
        )}
      </header>

      <main className="app-main">
        {error && (
          <div className="app-error">
            Couldn't load map data: {error}. Run <code>npm run export</code> first to generate{" "}
            <code>public/data/map-data.json</code>.
          </div>
        )}
        {mapData && (
          <MapView
            pins={mapData.pins}
            onSelectPin={(pin) => {
              setRemotePanelOpen(false);
              setSelectedPin(pin);
            }}
            selectedPinId={selectedPin?.id ?? null}
            flyToRequest={flyToRequest}
            // .company-panel is 360px wide; on a narrow screen it covers most
            // of the map anyway, so there's no visible area to center in.
            rightInset={selectedPin && window.innerWidth > 720 ? 360 : 0}
          />
        )}
        {mapData && (
          <CompanySearch
            pins={mapData.pins}
            onSelectLocation={(pin) => {
              setRemotePanelOpen(false);
              setSelectedPin(pin);
              setFlyToRequest({ pin, nonce: Date.now() });
            }}
          />
        )}
        <CompanyPanel pin={selectedPin} onClose={() => setSelectedPin(null)} />
        {mapData && (
          <RemotePanel
            companies={mapData.remoteCompanies}
            open={remotePanelOpen}
            onClose={() => setRemotePanelOpen(false)}
          />
        )}
      </main>
    </div>
  );
}
