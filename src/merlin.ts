import { HOST, type ParkConfig, type ProductConfig } from "./config";
import type { DayObs, Snapshot } from "./types";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

export interface FetchResult {
  ok: boolean;
  httpStatus: number;
  apiStatus: string;
  snapshot: Snapshot;
  datesSeen: number;
}

function buildPayload(
  park: ParkConfig,
  product: ProductConfig,
  startDate: string,
  endDate: string,
) {
  return {
    P: product.P,
    extra_movie: product.extra_movie,
    identify_customer_types: 1,
    min_capacity: 0, // capture sold-out dates too — that's where releases show
    version: "2",
    start_date: startDate,
    end_date: endDate,
    display_zero_capacity: "1",
    include_times: product.include_times,
    request_type: "GetMerchantPackageEventDates",
    _version: "6.31.6",
    application_id: "1500",
    merchant_id: park.merchantId,
    machine_id: "500",
    agent_id: "5",
    user_id: "5",
    device: "desktop",
    language: "en-gb",
  };
}

function headers(park: ParkConfig) {
  return {
    accept: "application/json, text/plain, */*",
    "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
    "com-accessopassport-app-id": "1500",
    "com-accessopassport-client": "accesso26",
    "com-accessopassport-language": "en-gb",
    "com-accessopassport-merchant-id": park.merchantId,
    "content-type": "application/json;charset=UTF-8",
    origin: park.origin,
    referer: `${park.origin}/`,
    "user-agent": USER_AGENT,
  };
}

interface ApiDay {
  date: string;
  package_id?: string;
  T?: { available?: string; capacity?: string; used?: string };
}

/**
 * One stateless read of a product's availability across the whole date window.
 * The server returns at most one entry per date (it merges packages itself),
 * but we defensively sum should it ever return several.
 */
export async function fetchProduct(
  park: ParkConfig,
  product: ProductConfig,
  startDate: string,
  endDate: string,
): Promise<FetchResult> {
  const resp = await fetch(HOST, {
    method: "POST",
    headers: headers(park),
    body: JSON.stringify(buildPayload(park, product, startDate, endDate)),
  });

  const empty = (apiStatus: string): FetchResult => ({
    ok: false,
    httpStatus: resp.status,
    apiStatus,
    snapshot: {},
    datesSeen: 0,
  });

  if (!resp.ok) return empty(`HTTP_${resp.status}`);

  const data = (await resp.json()) as { SERVICE?: Record<string, unknown> };
  const svc = data.SERVICE ?? {};
  const apiStatus = String(svc.status ?? "UNKNOWN");
  if (apiStatus !== "OK") return empty(apiStatus);

  const days = (svc.D as ApiDay[] | undefined) ?? [];
  const snapshot: Snapshot = {};
  const pkgIds: Record<string, Set<string>> = {};

  for (const d of days) {
    const t = d.T ?? {};
    const date = d.date;
    if (!date) continue;
    const cur: DayObs =
      snapshot[date] ?? { capacity: 0, available: 0, used: 0, packageIds: "" };
    cur.capacity += Number(t.capacity ?? 0);
    cur.available += Number(t.available ?? 0);
    cur.used += Number(t.used ?? 0);
    snapshot[date] = cur;
    (pkgIds[date] ??= new Set()).add(d.package_id ?? "");
  }
  for (const date of Object.keys(snapshot)) {
    snapshot[date].packageIds = [...pkgIds[date]]
      .filter(Boolean)
      .sort()
      .join(",");
  }

  return {
    ok: true,
    httpStatus: resp.status,
    apiStatus,
    snapshot,
    datesSeen: Object.keys(snapshot).length,
  };
}

/** Dates whose capacity/available/used changed vs the previous snapshot. */
export function diffSnapshots(prev: Snapshot, next: Snapshot) {
  const deltas = [];
  for (const [date, n] of Object.entries(next)) {
    const p = prev[date];
    if (
      !p ||
      p.capacity !== n.capacity ||
      p.available !== n.available ||
      p.used !== n.used
    ) {
      deltas.push({ date, ...n });
    }
  }
  return deltas;
}
