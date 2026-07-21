import type { GroupDim } from "./rides";

/**
 * Paulton's ride grouping — thrill level and themed area — keyed by the queue
 * feed's `rideId` (== the app's POI `orms_id`). The queue API carries only ids +
 * names, so this mapping is EMBEDDED, extracted from the app's bundled
 * `points_of_interest.json` (`category_tags` = themed areas, `filter_tags` =
 * thrill level; see docs/paultons-api.md). It changes only when Paulton's adds/
 * re-tags a ride; refresh by re-reading the POI DB from a fresh APK (a new ride
 * simply falls to "Other" until then).
 *
 * The two dimensions cover different subsets — 37/42 rides have a thrill tag,
 * 27/42 a themed area — so a ride may appear under a real section in one view and
 * "Other" in the other. That's faithful to the app's own tagging.
 */
export const PAULTONS_GROUP_DIMS: GroupDim[] = [
  { key: "thrill", label: "Thrill", by: "thrill" },
  { key: "area", label: "Area", by: "land" },
];

export const PAULTONS_GROUPS: Record<number, { thrill?: string; area?: string }> = {
  2: { thrill: "Thrill Rides" }, // Cobra
  3: { thrill: "Thrill Rides" }, // EDGE
  4: { thrill: "Thrill Rides" }, // Magma
  7: { thrill: "Family Rides" }, // The Sky Swinger
  8: { thrill: "Little Ones" }, // Digger Ride
  9: { thrill: "Little Ones" }, // Seal Falls
  11: { thrill: "Thrill Rides", area: "Lost Kingdom" }, // The Flight of the Pterosaur
  12: { thrill: "Thrill Rides", area: "Lost Kingdom" }, // Velociraptor
  13: { thrill: "Little Ones", area: "Lost Kingdom" }, // The Dinosaur Tour Co.
  14: { thrill: "Family Rides", area: "Lost Kingdom" }, // Boulder Dash
  15: { thrill: "Little Ones", area: "Lost Kingdom" }, // Dino Chase
  16: { area: "Lost Kingdom" }, // Temple Heights
  18: { thrill: "Family Rides", area: "Critter Creek" }, // Cat-O-Pillar Coaster
  19: { thrill: "Little Ones", area: "Critter Creek" }, // Prof. Blast's Expedition Express
  20: { thrill: "Family Rides" }, // The Victorian Carousel
  21: { thrill: "Little Ones" }, // Viking Boats
  22: { thrill: "Family Rides" }, // Kontiki
  23: { thrill: "Family Rides" }, // Tea Cup Ride
  24: { thrill: "Family Rides" }, // Pirate Ship
  25: { thrill: "Little Ones", area: "Peppa Pig World" }, // Miss Rabbit's Helicopter Flight
  26: { thrill: "Little Ones", area: "Peppa Pig World" }, // Windy Castle
  27: { thrill: "Little Ones", area: "Peppa Pig World" }, // Peppa's Big Balloon Ride
  28: { thrill: "Little Ones", area: "Peppa Pig World" }, // Daddy Pig's Car Ride
  29: { thrill: "Little Ones", area: "Peppa Pig World" }, // George's Dinosaur Adventure
  30: { thrill: "Little Ones", area: "Peppa Pig World" }, // Grandpa Pig's Little Train
  31: { thrill: "Little Ones", area: "Peppa Pig World" }, // Grandpa Pig's Boat Trip
  32: { thrill: "Little Ones", area: "Peppa Pig World" }, // The Queen's Flying Coach Ride
  33: { thrill: "Little Ones", area: "Peppa Pig World" }, // Grampy Rabbit's Sailing Club
  37: { thrill: "Little Ones", area: "Peppa Pig World" }, // George's Spaceship Playzone
  38: { thrill: "Family Rides", area: "Tornado Springs" }, // Buffalo Falls
  39: { thrill: "Thrill Rides", area: "Tornado Springs" }, // Cyclonator
  40: { thrill: "Thrill Rides", area: "Tornado Springs" }, // Storm Chaser
  41: { thrill: "Family Rides", area: "Tornado Springs" }, // Al's Auto Academy
  42: { thrill: "Family Rides", area: "Tornado Springs" }, // Windmill Towers
  43: { thrill: "Little Ones", area: "Tornado Springs" }, // Trekking Tractors
  44: { thrill: "Family Rides", area: "Tornado Springs" }, // Rio Grande Train
  45: { thrill: "Family Rides", area: "Tornado Springs" }, // Farmyard Flyer
  48: { thrill: "Family Rides", area: "Lost Kingdom" }, // Splash Lagoon
};

/** The {dim → group} map for one ride, or undefined if it has no tags at all. */
export function paultonsGroups(rideId: number): Record<string, string> | undefined {
  const g = PAULTONS_GROUPS[rideId];
  if (!g) return undefined;
  const out: Record<string, string> = {};
  if (g.thrill) out.thrill = g.thrill;
  if (g.area) out.area = g.area;
  return Object.keys(out).length ? out : undefined;
}
