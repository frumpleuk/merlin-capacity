import type { PollStatus } from "./api";

/** Time of day for today, full date-time otherwise (en-GB, local). */
function fmt(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString("en-GB")
    : d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

/**
 * The status line shown directly under the header on every page: when we last
 * checked, and when a change was last detected. Consistent placement + content
 * across the calendar, queues, and per-product heatmaps.
 */
export function UpdateMeta({ status }: { status: PollStatus | null | undefined }) {
  if (!status) return null;
  return (
    <div className="page-meta">
      Checked {fmt(status.last_polled)}
      {" · "}
      last change {status.last_changed ? fmt(status.last_changed) : "none yet"}
    </div>
  );
}
