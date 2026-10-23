import { useCallback, useEffect, useMemo, useState } from "react";
import MapView, { type FlyToRequest, type ZoomRequest } from "./components/MapView.js";
import CompanySearch from "./components/CompanySearch.js";
import CompanyPanel from "./components/CompanyPanel.js";
import RemotePanel from "./components/RemotePanel.js";
import ChangesPanel from "./components/ChangesPanel.js";
import FilterBar from "./components/FilterBar.js";
import VoicePanel from "./components/VoicePanel.js";
import { useVoiceAgent } from "./voice/useVoiceAgent.js";
import RolePage, { type RoleLoadedInfo } from "./components/RolePage.js";
import JobBoard, { type JobSort } from "./components/JobBoard.js";
import { replaceJobsQuery, useRoute } from "./router.js";
import {
  EMPTY_FILTERS,
  countRoles,
  filterPins,
  filterRemoteCompanies,
  filtersFromParams,
  filtersToParams,
  isFiltering,
  type RoleFilters,
} from "./filters.js";
import type { LocationPinData, MapData } from "./types.js";

export default function App() {
  const route = useRoute();
  const [mapData, setMapData] = useState<MapData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedPin, setSelectedPin] = useState<LocationPinData | null>(null);
  const [remotePanelOpen, setRemotePanelOpen] = useState(false);
  const [changesPanelOpen, setChangesPanelOpen] = useState(false);
  // A fresh Set per mount: EMPTY_FILTERS.seniority is shared, and state
  // that aliases it would be a mutation bug waiting to happen.
  // Opening a shared #/jobs?... link starts with the filters it carries.
  const [filters, setFilters] = useState<RoleFilters>(() =>
    route.name === "jobs" ? filtersFromParams(route.params) : { ...EMPTY_FILTERS, seniority: new Set() },
  );
  // Which view sits under the role drawer: the one you opened it from.
  // The map stays mounted either way (MapLibre is slow to rebuild); the job
  // board just covers it.
  const [baseView, setBaseView] = useState<"map" | "jobs">(route.name === "jobs" ? "jobs" : "map");
  const [jobQuery, setJobQuery] = useState(() => (route.name === "jobs" ? (route.params.get("q") ?? "") : ""));
  const [jobSort, setJobSort] = useState<JobSort>(() => {
    const s = route.name === "jobs" ? route.params.get("sort") : null;
    return s === "salary" || s === "company" ? s : "newest";
  });
  const [flyToRequest, setFlyToRequest] = useState<FlyToRequest | null>(null);
  const [crumbs, setCrumbs] = useState<{ company: string; role: string } | null>(null);
  // The pin of the role open in the drawer: the map flies to it and rings it.
  const [rolePinId, setRolePinId] = useState<string | null>(null);
  // Bumped when the agent warms a company's profile, so an open role page
  // re-reads it instead of still offering "Load company intelligence".
  const [intelRefresh, setIntelRefresh] = useState<{ slug: string; nonce: number } | null>(null);
  // How much of the map the voice dock is covering, measured by the panel.
  const [voiceInset, setVoiceInset] = useState(0);
  const [zoomRequest, setZoomRequest] = useState<ZoomRequest | null>(null);

  useEffect(() => {
    fetch("/data/map-data.json")
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load map data (HTTP ${res.status})`);
        return res.json();
      })
      .then((data: MapData) => setMapData(data))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  // Pinned at mount rather than read per render: the date filters only care
  // about day granularity, and a moving `now` would invalidate the memos below
  // on every render.
  const [now] = useState(() => Date.now());

  const filteredPins = useMemo(
    () => (mapData ? filterPins(mapData.pins, filters, now) : []),
    [mapData, filters, now],
  );
  const filteredRemoteCompanies = useMemo(
    () => (mapData ? filterRemoteCompanies(mapData.remoteCompanies, filters, now) : []),
    [mapData, filters, now],
  );
  const matchedRoles = useMemo(
    () => countRoles(filteredPins, filteredRemoteCompanies),
    [filteredPins, filteredRemoteCompanies],
  );
  // The open panel has to show the pin as filtered, not as clicked -- and
  // close itself if the filters removed every role it was listing.
  const visiblePin = useMemo(
    () => (selectedPin ? (filteredPins.find((p) => p.id === selectedPin.id) ?? null) : null),
    [filteredPins, selectedPin],
  );

  useEffect(() => {
    if (route.name === "map") setBaseView("map");
    else if (route.name === "jobs") setBaseView("jobs");
  }, [route.name]);

  // Keep the job board's link current, so it can be bookmarked or shared
  // exactly as filtered.
  useEffect(() => {
    if (route.name !== "jobs") return;
    const params = new URLSearchParams();
    if (jobQuery.trim()) params.set("q", jobQuery.trim());
    filtersToParams(filters, params);
    if (jobSort !== "newest") params.set("sort", jobSort);
    replaceJobsQuery(params);
  }, [route.name, jobQuery, jobSort, filters]);

  const jobsHash = useCallback(() => {
    const params = new URLSearchParams();
    if (jobQuery.trim()) params.set("q", jobQuery.trim());
    filtersToParams(filters, params);
    if (jobSort !== "newest") params.set("sort", jobSort);
    const query = params.toString();
    return `#/jobs${query ? `?${query}` : ""}`;
  }, [jobQuery, jobSort, filters]);

  // Closing a role goes back to wherever it was opened from.
  const closeRole = useCallback(() => {
    setRolePinId(null);
    setCrumbs(null);
    window.location.hash = baseView === "jobs" ? jobsHash() : "#/";
  }, [baseView, jobsHash]);

  /**
   * Opening a company panel closes whatever else was open, the role drawer
   * included. The drawer is 780px and the panel 360px on the same right
   * edge, so leaving both up stacks them -- and asking for one thing plainly
   * means you're done with the other.
   */
  const selectPin = useCallback(
    (pin: LocationPinData) => {
      setRemotePanelOpen(false);
      setChangesPanelOpen(false);
      if (window.location.hash.startsWith("#/company/")) closeRole();
      // A company panel belongs to the map; the job board has none.
      if (window.location.hash.startsWith("#/jobs")) window.location.hash = "#/";
      setSelectedPin(pin);
    },
    [closeRole],
  );
  const flyToPin = useCallback((pin: LocationPinData) => {
    // The copilot moving the map from the job board brings the map back,
    // rather than flying a camera nobody can see.
    if (window.location.hash.startsWith("#/jobs")) window.location.hash = "#/";
    setFlyToRequest({ pin, nonce: Date.now() });
  }, []);

  const onRolePage = route.name === "role";
  const onJobs = baseView === "jobs";
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

  // The drawer is min(780px, viewport - 32px) wide plus its 16px margin; the
  // map centers flights in whatever is left visible beside it.
  const drawerInset = Math.min(780, window.innerWidth - 32) + 16;
  const rightInset = onRolePage
    ? window.innerWidth > 720
      ? drawerInset
      : 0
    : visiblePin && window.innerWidth > 720
      ? 360
      : 0;

  const voice = useVoiceAgent({
    mapData,
    // The office of the role in the drawer, so the agent opens THAT panel
    // rather than the company's biggest office.
    currentPinId: onRolePage ? rolePinId : (visiblePin?.id ?? null),
    loadIntelligence: useCallback((slug: string) => setIntelRefresh({ slug, nonce: Date.now() }), []),
    filters,
    setFilters,
    selectPin,
    flyToPin,
    zoomMap: useCallback(
      (direction: "in" | "out" | "reset", steps: number) => setZoomRequest({ direction, steps, nonce: Date.now() }),
      [],
    ),
    // One teardown for "we're going somewhere else now", so a panel never
    // describes a place the map has already left.
    clearPanels: useCallback(() => {
      setSelectedPin(null);
      setRemotePanelOpen(false);
      setChangesPanelOpen(false);
      if (window.location.hash.startsWith("#/company/")) closeRole();
    }, [closeRole]),
    screen: {
      view: onRolePage ? "role" : "map",
      selectedCompany: visiblePin ? { name: visiblePin.companyName, slug: visiblePin.companySlug } : null,
      openRole:
        route.name === "role" && crumbs
          ? { id: route.roleId, title: crumbs.role, companySlug: route.companySlug }
          : null,
      visibleRoleCount: matchedRoles,
    },
  });

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
        {!onRolePage && (
          <nav className="view-toggle" aria-label="View">
            <a href="#/" className={onJobs ? "" : "is-on"} aria-current={onJobs ? undefined : "page"}>
              Map
            </a>
            <a href={jobsHash()} className={onJobs ? "is-on" : ""} aria-current={onJobs ? "page" : undefined}>
              Jobs
            </a>
          </nav>
        )}
        {onRolePage ? (
          <nav className="breadcrumbs" aria-label="Breadcrumb">
            <a href={onJobs ? jobsHash() : "#/"}>{onJobs ? "Jobs" : "Map"}</a>
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
              {mapData.companyCount} companies ·{" "}
              {isFiltering(filters) ? (
                <strong className="stats-filtered">
                  {matchedRoles.toLocaleString()} of {mapData.roleCount.toLocaleString()}
                </strong>
              ) : (
                mapData.roleCount.toLocaleString()
              )}{" "}
              open Product Manager roles
              {mapData.remoteCompanies.length > 0 && (
                <>
                  {" · "}
                  <button
                    className="remote-panel-toggle"
                    onClick={() => {
                      setSelectedPin(null);
                      setChangesPanelOpen(false);
                      setRemotePanelOpen(true);
                    }}
                  >
                    {filteredRemoteCompanies.reduce((sum, c) => sum + c.roleCount, 0)} more, unmapped
                  </button>
                </>
              )}
              {(mapData.changes.added > 0 || mapData.changes.closed > 0) && (
                <>
                  {" · "}
                  <button
                    className="remote-panel-toggle"
                    onClick={() => {
                      setSelectedPin(null);
                      setRemotePanelOpen(false);
                      setChangesPanelOpen(true);
                    }}
                    title={`What changed in the last ${mapData.changes.windowDays} days`}
                  >
                    +{mapData.changes.added} new · −{mapData.changes.closed} closed
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
            pins={filteredPins}
            onSelectPin={(pin) => {
              setRemotePanelOpen(false);
              setChangesPanelOpen(false);
              setSelectedPin(pin);
            }}
            selectedPinId={onRolePage ? rolePinId : (selectedPin?.id ?? null)}
            flyToRequest={flyToRequest}
            zoomRequest={zoomRequest}
            onCameraSettled={voice.logCamera}
            // Side panels cover the right of the map (.company-panel is 360px,
            // the role drawer wider); on a narrow screen they cover most of
            // it anyway, so there's no visible area to center in.
            rightInset={rightInset}
            bottomInset={voiceInset}
          />
        )}
        {mapData && !onJobs && (
          <CompanySearch
            pins={filteredPins}
            onSelectLocation={(pin) => {
              setRemotePanelOpen(false);
              setChangesPanelOpen(false);
              setSelectedPin(pin);
              setFlyToRequest({ pin, nonce: Date.now() });
            }}
          />
        )}
        {mapData && !onRolePage && !onJobs && (
          <FilterBar filters={filters} onChange={setFilters} matched={matchedRoles} total={mapData.roleCount} />
        )}
        {/* Never both at once: the drawer wins while it's open, and the
            panel comes back when it closes. */}
        <CompanyPanel pin={onRolePage || onJobs ? null : visiblePin} onClose={() => setSelectedPin(null)} />
        {mapData && onJobs && (
          <JobBoard
            pins={filteredPins}
            remoteCompanies={filteredRemoteCompanies}
            logos={mapData.logos ?? {}}
            filters={filters}
            onFiltersChange={setFilters}
            query={jobQuery}
            onQueryChange={setJobQuery}
            sort={jobSort}
            onSortChange={setJobSort}
            total={mapData.roleCount}
          />
        )}
        {mapData && (
          <RemotePanel
            companies={filteredRemoteCompanies}
            open={remotePanelOpen}
            onClose={() => setRemotePanelOpen(false)}
          />
        )}
        {mapData && (
          <ChangesPanel data={mapData} open={changesPanelOpen} onClose={() => setChangesPanelOpen(false)} />
        )}
        <VoicePanel {...voice} onHeightChange={setVoiceInset} />
        {route.name === "role" && (
          <RolePage
            companySlug={route.companySlug}
            roleId={route.roleId}
            onLoaded={onRoleLoaded}
            onClose={closeRole}
            intelRefresh={intelRefresh}
          />
        )}
      </main>
    </div>
  );
}
