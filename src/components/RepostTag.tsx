/** ↻ Reposted -- the company took this posting down and put the same job back up. */
export default function RepostTag({ repostedFrom }: { repostedFrom?: string | null }) {
  if (!repostedFrom) return null;
  const first = new Date(repostedFrom);
  const firstLabel = Number.isNaN(first.getTime())
    ? null
    : first.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return (
    <span
      className="fresh-tag is-repost"
      title={`Taken down and posted again${firstLabel ? `. First posted around ${firstLabel}` : ""}; the job may be hard to fill.`}
    >
      <span aria-hidden="true">↻</span> Reposted
    </span>
  );
}
