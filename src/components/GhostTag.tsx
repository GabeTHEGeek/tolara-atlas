import { ghostReason } from "../ghost.js";
import type { RoleData } from "../types.js";

/** 👻 Possible ghost job -- open far longer than a normal search. See ghost.ts. */
export default function GhostTag({ role, now }: { role: Pick<RoleData, "postedAt" | "firstSeenAt" | "repostedFrom">; now?: number }) {
  const reason = ghostReason(role, now);
  if (!reason) return null;
  return (
    <span className="fresh-tag is-ghost" title={`${reason} Worth checking before you spend time applying.`}>
      <span aria-hidden="true">👻</span> Possible ghost job
    </span>
  );
}
