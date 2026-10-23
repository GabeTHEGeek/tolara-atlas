import { useEffect, useState } from "react";

/**
 * Hash-based routes, so a role link works on any static host with no
 * server-side rewrite rules:
 *   #/                                  the map
 *   #/jobs?q=...&sen=...                the job board, its search and
 *                                       filters in the query so a filtered
 *                                       list can be bookmarked or shared
 *   #/company/<slug>/role/<roleId>      a role page
 */
export type Route =
  | { name: "map" }
  | { name: "jobs"; params: URLSearchParams }
  | { name: "role"; companySlug: string; roleId: number };

function parse(hash: string): Route {
  const m = hash.match(/^#\/company\/([a-z0-9-]+)\/role\/(\d+)\/?$/);
  if (m) return { name: "role", companySlug: m[1], roleId: Number(m[2]) };
  const jobs = hash.match(/^#\/jobs\/?(?:\?(.*))?$/);
  if (jobs) return { name: "jobs", params: new URLSearchParams(jobs[1] ?? "") };
  return { name: "map" };
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
