import type { ReactNode } from "react";
import { takenLong, takenOf, TAKEN_NOTE } from "./api";

type Allocation = { capacity: number; available: number; used: number };

/** A column-aligned stack of AllocMeter rows: label, bar, percentage, count. */
export function AllocList({ children }: { children: ReactNode }) {
  return <div className="alloc-list">{children}</div>;
}

/** How full one allocation is: a fill bar, the percentage taken and the taken
 *  count against capacity, with unsold in the tooltip. Leads on taken rather
 *  than on `used` (see takenOf). Capacity 0 with bookings is the private-event
 *  shape: no total to show a fraction against, so it reports the count alone.
 *  `note` sits under the row, full width. */
export function AllocMeter({
  label,
  o,
  icon,
  note,
}: {
  label: string;
  o: Allocation;
  icon?: string;
  note?: ReactNode;
}) {
  const t = takenOf(o);
  if (!t && o.used <= 0) return null;
  return (
    <div className="alloc-row">
      <span className="alloc-label">
        {icon && `${icon} `}
        {label}
      </span>
      {t ? (
        <>
          <span className="alloc-bar" aria-hidden="true">
            <span style={{ width: `${t.pct}%` }} />
          </span>
          <strong className="alloc-pct" title={TAKEN_NOTE}>
            {t.pct}%
          </strong>
          <span className="alloc-count" title={`${takenLong(t, o.capacity)}.`}>
            {t.taken.toLocaleString()} / {o.capacity.toLocaleString()}
          </span>
        </>
      ) : (
        <span className="alloc-count alloc-booked" title="Booked against no published allocation.">
          <strong>{o.used.toLocaleString()}</strong> booked
        </span>
      )}
      {note && <div className="alloc-note">{note}</div>}
    </div>
  );
}
