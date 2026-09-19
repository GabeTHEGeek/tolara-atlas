import { useEffect, useMemo, useRef, useState } from "react";
import type { LocationPinData } from "../types.js";

interface CompanySearchProps {
  pins: LocationPinData[];
  onSelectLocation: (pin: LocationPinData) => void;
}

interface CompanyEntry {
  companyId: number;
  name: string;
  roleCount: number;
  // One per city the company has a pin in, busiest first.
  locations: LocationPinData[];
}

const MAX_RESULTS = 8;

function locationLabel(pin: LocationPinData): string {
  return [pin.city, pin.state].filter(Boolean).join(", ") || "Location unknown";
}

/**
 * Floating company search over the map. Two steps: type to find a company,
 * pick it to see every city it's hiring in, then pick a city to fly there
 * (the flight itself lives in MapView, driven by onSelectLocation).
 */
export default function CompanySearch({ pins, onSelectLocation }: CompanySearchProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeCompanyId, setActiveCompanyId] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const companies = useMemo(() => {
    const byId = new Map<number, CompanyEntry>();
    for (const pin of pins) {
      const entry = byId.get(pin.companyId) ?? {
        companyId: pin.companyId,
        name: pin.companyName,
        roleCount: 0,
        locations: [],
      };
      entry.roleCount += pin.roleCount;
      entry.locations.push(pin);
      byId.set(pin.companyId, entry);
    }
    for (const entry of byId.values()) entry.locations.sort((a, b) => b.roleCount - a.roleCount);
    return [...byId.values()];
  }, [pins]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return companies
      .filter((c) => c.name.toLowerCase().includes(q))
      .sort((a, b) => {
        // Names that START with the query first ("box" -> Box before Dropbox),
        // then the companies with the most open roles.
        const aStarts = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bStarts = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        return aStarts - bStarts || b.roleCount - a.roleCount || a.name.localeCompare(b.name);
      })
      .slice(0, MAX_RESULTS);
  }, [companies, query]);

  const activeCompany = activeCompanyId == null ? null : companies.find((c) => c.companyId === activeCompanyId) ?? null;

  // Close the dropdown on a click anywhere outside the search box.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  const showDropdown = open && (activeCompany !== null || query.trim() !== "");

  return (
    <div
      className="company-search"
      ref={rootRef}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        if (activeCompany) setActiveCompanyId(null);
        else setOpen(false);
        inputRef.current?.focus();
      }}
    >
      <input
        ref={inputRef}
        type="search"
        className="company-search-input"
        placeholder="Search companies…"
        aria-label="Search companies"
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setActiveCompanyId(null);
          setOpen(true);
        }}
      />

      {showDropdown && (
        <div className="company-search-dropdown">
          {activeCompany ? (
            <>
              <div className="company-search-heading">
                <button
                  className="company-search-back"
                  onClick={() => setActiveCompanyId(null)}
                  aria-label="Back to results"
                >
                  ←
                </button>
                <span>
                  <strong>{activeCompany.name}</strong>
                  <span className="company-search-sub">
                    {activeCompany.locations.length} {activeCompany.locations.length === 1 ? "location" : "locations"}
                  </span>
                </span>
              </div>
              <ul className="company-search-list">
                {activeCompany.locations.map((pin) => (
                  <li key={pin.id}>
                    <button
                      className="company-search-item"
                      onClick={() => {
                        setOpen(false);
                        onSelectLocation(pin);
                      }}
                    >
                      <span>{locationLabel(pin)}</span>
                      <span className="company-search-count">
                        {pin.roleCount} {pin.roleCount === 1 ? "role" : "roles"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : results.length > 0 ? (
            <ul className="company-search-list">
              {results.map((c) => (
                <li key={c.companyId}>
                  <button className="company-search-item" onClick={() => setActiveCompanyId(c.companyId)}>
                    <span>{c.name}</span>
                    <span className="company-search-count">
                      {c.locations.length} {c.locations.length === 1 ? "location" : "locations"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="company-search-empty">No companies on the map match “{query.trim()}”.</p>
          )}
        </div>
      )}
    </div>
  );
}
