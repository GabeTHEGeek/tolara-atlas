import { useEffect, useState } from "react";

/**
 * Hash-based routes, so a role link works on any static host with no
 * server-side rewrite rules:
 *   (no hash)  or  #/                   the job board: what the app opens on
 *   #/jobs?q=...&sen=...                the job board, its search and
 *                                       filters in the query so a filtered
 *                                       list can be bookmarked or shared
 *   #/map  or  #/map?sen=...            the map, its filters in the query
 *                                       so a filtered map can be shared.
 *                                       #/?sen=... (a filtered map link from
 *                                       before the job board was the default)
 *                                       still opens the map.
 *   #/jobs?co=<slug>                    the job board showing one company's roles
 *   #/company/<slug>/role/<roleId>      a role page
 *   #/welcome                           the landing page (LandingPage.tsx)
 */
export type Route =
  | { name: "map"; params: URLSearchParams }
  | { name: "jobs"; params: URLSearchParams }
  | { name: "role"; companySlug: string; roleId: number }
  | { name: "welcome" };

function parse(hash: string): Route {
  const m = hash.match(/^#\/company\/([a-z0-9-]+)\/role\/(\d+)\/?$/);
  if (m) return { name: "role", companySlug: m[1], roleId: Number(m[2]) };
  if (/^#\/welcome\/?$/.test(hash)) return { name: "welcome" };
  const jobs = hash.match(/^#\/jobs\/?(?:\?(.*))?$/);
  if (jobs) return { name: "jobs", params: new URLSearchParams(jobs[1] ?? "") };
  const map = hash.match(/^#\/map\/?(?:\?(.*))?$/);
  if (map) return { name: "map", params: new URLSearchParams(map[1] ?? "") };
  const legacyMap = hash.match(/^#\/?\?(.+)$/);
  if (legacyMap) return { name: "map", params: new URLSearchParams(legacyMap[1]) };
  return { name: "jobs", params: new URLSearchParams() };
}

/**
 * Rewrites the job board's query in place -- replaceState, not a hash
 * assignment, so typing in the search box doesn't add a history entry per
 * keystroke or fire hashchange back at the router.
 */
export function replaceJobsQuery(params: URLSearchParams): void {
  const query = params.toString();
  const next = `#/jobs${query ? `?${query}` : ""}`;
  if (window.location.hash !== next) window.history.replaceState(null, "", next);
}

/** Same as replaceJobsQuery, for the map's own filter query. */
export function replaceMapQuery(params: URLSearchParams): void {
  const query = params.toString();
  const next = `#/map${query ? `?${query}` : ""}`;
  if (window.location.hash !== next) window.history.replaceState(null, "", next);
}

/** True when the address shows the job board, the default view included. */
export function onJobsBoard(hash: string = window.location.hash): boolean {
  return parse(hash).name === "jobs";
}

export function roleHref(companySlug: string, roleId: number): string {
  return `#/company/${companySlug}/role/${roleId}`;
}

/** The job board narrowed to one company: every role it has open. */
export function companyJobsHref(companySlug: string): string {
  return `#/jobs?co=${companySlug}`;
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
