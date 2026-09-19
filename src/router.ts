import { useEffect, useState } from "react";

/**
 * Hash-based routes, so a role link works on any static host with no
 * server-side rewrite rules:
 *   #/                                  the map
 *   #/company/<slug>/role/<roleId>      a role page
 */
export type Route = { name: "map" } | { name: "role"; companySlug: string; roleId: number };

function parse(hash: string): Route {
  const m = hash.match(/^#\/company\/([a-z0-9-]+)\/role\/(\d+)\/?$/);
  return m ? { name: "role", companySlug: m[1], roleId: Number(m[2]) } : { name: "map" };
}

export function roleHref(companySlug: string, roleId: number): string {
  return `#/company/${companySlug}/role/${roleId}`;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parse(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
