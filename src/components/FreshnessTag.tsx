import { FRESHNESS_TAGS, freshnessOf } from "../format.js";
import { roleDate } from "../filters.js";
import type { RoleData } from "../types.js";

/** 🔥 Hot / ✨ New / 🧊 Aging / 🥶 Stale -- nothing for a role 8–29 days old. */
export default function FreshnessTag({ role, now = Date.now() }: { role: Pick<RoleData, "postedAt" | "firstSeenAt" | "isNew">; now?: number }) {
  const tier = freshnessOf(roleDate(role), role.isNew, now);
  if (!tier) return null;
  const tag = FRESHNESS_TAGS[tier];
  return (
    <span className={`fresh-tag is-${tier}`} title={tag.title}>
      <span aria-hidden="true">{tag.emoji}</span> {tag.label}
    </span>
  );
}
