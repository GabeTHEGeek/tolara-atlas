import { useCallback, useEffect, useState } from "react";
import MapView, { type FlyToRequest } from "./components/MapView.js";
import CompanySearch from "./components/CompanySearch.js";
import CompanyPanel from "./components/CompanyPanel.js";
import RemotePanel from "./components/RemotePanel.js";
import RolePage, { type RoleLoadedInfo } from "./components/RolePage.js";
import { useRoute } from "./router.js";
import type { LocationPinData, MapData } from "./types.js";

export default function App() {
  const route = useRoute();
  const [mapData, setMapData] = useState<MapData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedPin, setSelectedPin] = useState<LocationPinData | null>(null);
  const [remotePanelOpen, setRemotePanelOpen] = useState(false);
  const [flyToRequest, setFlyToRequest] = useState<FlyToRequest | null>(null);
  const [crumbs, setCrumbs] = useState<{ company: string; role: string } | null>(null);
  // The pin of the role open in the drawer: the map flies to it and rings it.
  const [rolePinId, setRolePinId] = useState<string | null>(null);

  useEffect(() => {
    fetch("/data/map-data.json")
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load map data (HTTP ${res.status})`);
        return res.json();
      })
      .then((data: MapData) => setMapData(data))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const onRolePage = route.name === "role";
  const routeCompany = route.name === "role" ? route.companySlug : null;

  const onRoleLoaded = useCallback(
    (info: RoleLoadedInfo | null) => {
      setCrumbs(info ? { company: info.company, role: info.role } : null);
      if (!info || !mapData || !routeCompany) return;
      // Fly to the role's first real office (or its remote pin) on the map.
      const office = info.offices.find((o) => !o.isRemote) ?? info.offices[0];
      const pin = office
        ? mapData.pins.find((p) => p.companySlug === routeCompany && p.city === office.city && p.state === office.state)
        : undefined;
      setRolePinId(pin?.id ?? null);
      if (pin) setFlyToRequest({ pin, nonce: Date.now() });
    },
    [mapData, routeCompany],
  );

  const closeRole = useCallback(() => {
    setRolePinId(null);
    setCrumbs(null);
    window.location.hash = "#/";
  }, []);

  // The drawer is min(780px, viewport - 32px) wide plus its 16px margin; the
  // map centers flights in whatever is left visible beside it.
  const drawerInset = Math.min(780, window.innerWidth - 32) + 16;
  const rightInset = onRolePage
    ? window.innerWidth > 720
      ? drawerInset
      : 0
    : selectedPin && window.innerWidth > 720
      ? 360
      : 0;

  return (
    <div className="app">
      <header className="app-header">
        <a className="brand" href="#/" aria-label="Tolara Scout — back to the map">
          <span className="brand-mark" aria-hidden="true">
            T
          </span>
          <span className="brand-name">
            TOLARA <span className="brand-accent">SCOUT</span>
          </span>
        </a>
        <span className="header-divider" aria-hidden="true" />
        {onRolePage ? (
          <nav className="breadcrumbs" aria-label="Breadcrumb">
            <a href="#/">Map</a>
            {crumbs && (
              <>
                <span aria-hidden="true">›</span>
                <span>{crumbs.company}</span>
                <span aria-hidden="true">›</span>
                <span className="breadcrumb-current" aria-current="page">
                  {crumbs.role}
                </span>
              </>
            )}
          </nav>
        ) : (
          mapData && (
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
          )
        )}
      </header>

      <main className="app-main">
        {error && (
          <div className="app-error">
            Couldn't load map data: {error}. Run <code>npm run export</code> first to generate{" "}
            <code>public/data/map-data.json</code>.
          </div>
        )}
        {/* The role drawer floats over the map, which stays live underneath. */}
        {mapData && (
          <MapView
            pins={mapData.pins}
            onSelectPin={(pin) => {
              setRemotePanelOpen(false);
              setSelectedPin(pin);
            }}
            selectedPinId={onRolePage ? rolePinId : (selectedPin?.id ?? null)}
            flyToRequest={flyToRequest}
            // Side panels cover the right of the map (.company-panel is 360px,
            // the role drawer wider); on a narrow screen they cover most of
            // it anyway, so there's no visible area to center in.
            rightInset={rightInset}
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
        {route.name === "role" && (
          <RolePage
            companySlug={route.companySlug}
            roleId={route.roleId}
            onLoaded={onRoleLoaded}
            onClose={closeRole}
          />
        )}
      </main>
    </div>
  );
}
