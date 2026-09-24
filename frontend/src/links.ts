// Static per-park link directory powering the Links tab. Everything here is a
// public URL captured by hand (verified live), so — unlike hours/queues/tickets
// — there's no poller, no R2 file and no backend involvement: adding a park's
// links is a data-only edit here.
//
// The Merlin parks share four URL shapes off their accesso ticketing origin
// (the same `origin` as src/config.ts), so they're built by helper rather than
// repeated seven times. The independents (Paulton's, Flamingo Land,
// Blackpool) each run their own store and their own accessibility scheme, so
// their entries are spelled out.

export interface ParkLink {
  label: string;
  url: string;
  /** Optional one-liner shown under the label — worth it where the link's
   *  behaviour isn't obvious from its name (perk conditions, what it opens). */
  note?: string;
}

/** An app with its two store listings. `ios` is an apps.apple.com GB URL,
 *  `android` a Play Store package page. */
export interface AppLink {
  name: string;
  ios?: string;
  android?: string;
  note?: string;
}

/** Social profiles, keyed by platform. Only the platforms a park actually
 *  publishes are set — the renderer iterates PLATFORMS and skips the gaps, so a
 *  park missing TikTok simply shows one chip fewer. Of the seven parks only
 *  Paulton's publishes a Pinterest or LinkedIn profile on its own site. */
export interface SocialLinks {
  facebook?: string;
  instagram?: string;
  tiktok?: string;
  x?: string;
  youtube?: string;
  pinterest?: string;
  linkedin?: string;
}

/** Where the park is, and what we hand a map app to get there. */
export interface ParkLocation {
  /** Postal address, as the park's own directions page gives it (postcode
   *  excluded — it's shown on its own line so it can be copied). */
  address: string;
  postcode: string;
  /** Where to drive to: the main visitor car park, as a coordinate. Preferred
   *  over any text search, because a search resolves to the park's POI — which
   *  is the pedestrian entrance for some apps and the middle of the estate for
   *  others, and at Alton Towers that means the farm track the park warns
   *  about. `label` names the pin so the page can say where it's sending you.
   *  Sources are per-park; see each entry. */
  drive?: { lat: number; lon: number; label: string };
  /** Destination for a park with no coordinate: name plus postcode, which each
   *  app then resolves against its own POI. The postcode separates the park
   *  from its namesakes (there's another Thorpe Park, in Peterborough). */
  query: string;
  /** The park's own directions page — the authority on road signs, parking and
   *  public transport. */
  directions: string;
  /** Shown under the postcode, where the park itself says something about
   *  driving in that the map apps won't tell you. */
  note?: string;
}

/** One map app's deep link. */
export interface MapLink {
  name: string;
  url: string;
}

/** The three apps people navigate with here. Each takes the destination as a
 *  `lat,lon` pair where we have one and as text otherwise; all three fall back
 *  to their web map on a desktop browser and hand off to the installed app on a
 *  phone. */
export function mapLinks(loc: ParkLocation): MapLink[] {
  const ll = loc.drive ? `${loc.drive.lat},${loc.drive.lon}` : null;
  const dest = encodeURIComponent(ll ?? loc.query);
  return [
    // dirflg=d asks for driving; with no saddr, Apple Maps starts from wherever
    // the device is.
    { name: "Apple Maps", url: `https://maps.apple.com/?daddr=${dest}&dirflg=d` },
    // Google's documented cross-platform directions URL.
    {
      name: "Google Maps",
      url: `https://www.google.com/maps/dir/?api=1&destination=${dest}`,
    },
    // Waze's universal link: ll for a coordinate, q for a search. navigate=yes
    // starts the route rather than only dropping a pin on it.
    {
      name: "Waze",
      url: ll
        ? `https://waze.com/ul?ll=${dest}&navigate=yes`
        : `https://waze.com/ul?q=${dest}&navigate=yes`,
    },
  ];
}

export interface ParkLinks {
  /** The park's own marketing site. */
  website: string;
  location: ParkLocation;
  /** Tickets, prebooking and queue-skip products. */
  booking: ParkLink[];
  /** Getting an order back after you've bought it — the lookup or account page
   *  that resends tickets and passes. Empty where the park runs neither. */
  orders: ParkLink[];
  /** The park's own closure list: which rides are out for maintenance. These
   *  pages carry PLANNED and long-term closures, not live status (the park apps
   *  do that) — Flamingo Land is the exception, its page is today's list.
   *  A named field rather than a row in a list because the Queues tab links it
   *  directly, under the ride it explains the absence of. */
  rideAvailability: ParkLink;
  /** The park's own opening-times calendar — the source our hours poller reads,
   *  and the authority when the two disagree. */
  openingTimes: ParkLink;
  /** Which lifts are out, for the four Merlin parks. Unset elsewhere: no
   *  independent publishes a lift closure list. */
  liftAvailability?: ParkLink;
  /** Accessibility: the park's ride-access scheme (RAP and its equivalents). */
  access: ParkLink[];
  /** On-ride photos: the park's own page for the product, and wherever the
   *  photos are then viewed and downloaded. Empty where the park sells none. */
  photos: ParkLink[];
  apps: AppLink[];
  social: SocialLinks;
}

/** Display order + labels for the social chips. `key` also selects the brand
 *  glyph in SOCIAL_GLYPHS. X keeps "Twitter" in its label — the rename never
 *  took in common use, and the bird is what people scan for. */
export const PLATFORMS: { key: keyof SocialLinks; label: string }[] = [
  { key: "facebook", label: "Facebook" },
  { key: "instagram", label: "Instagram" },
  { key: "tiktok", label: "TikTok" },
  { key: "x", label: "X (Twitter)" },
  { key: "youtube", label: "YouTube" },
  { key: "pinterest", label: "Pinterest" },
  { key: "linkedin", label: "LinkedIn" },
];

const appStore = (slug: string, id: string) =>
  `https://apps.apple.com/gb/app/${slug}/id${id}`;
const playStore = (pkg: string) =>
  `https://play.google.com/store/apps/details?id=${pkg}`;

/** Merlin annual-pass trip prebooking — one shared booking system for all four
 *  Merlin parks, so the same URL appears on each. */
const MAP_PREBOOK = "https://www.merlinannualpass.co.uk/prebook/manage-trips/";

/** Straight into the accesso date-picker for standard park admission — skips
 *  the marketing site's ticket funnel entirely. `origin` is the park's accesso
 *  ticketing host (same value as ParkConfig.origin in src/config.ts). */
const bookTickets = (origin: string): ParkLink => ({
  label: "Book tickets",
  url: `${origin}/snap-calendar-wizard/SnapWizard/SnapWizardAdmission`,
  note: "Direct to the date picker on the park's ticketing site",
});

/** The pass-holder 10%-off-Fastrack perk. The promo code differs per park (and
 *  Chessington's is genuinely lowercase); the marketing-site links from the
 *  passholder hub just bounce to this same accesso package list with the code
 *  pre-applied, so we link the destination directly. */
const fastrackPerk = (origin: string, promocode: string): ParkLink => ({
  label: "10% off Fastrack",
  url: `${origin}/packageList/promocode/${promocode}?promocode=${promocode}`,
  note: "Merlin Annual Pass perk - discount applied via promocode",
});

/** accesso's order lookup: the one route on a ticketing store that finds an
 *  order without an account. You give the email address and the phone number
 *  used at purchase, it emails a verification code, and the order comes back
 *  with its tickets — which is also where the wallet buttons live, so it's how
 *  you get a booking onto a phone after the confirmation email has gone
 *  missing. `wallet` differs by merchant: every Merlin store generates Apple
 *  Wallet passes (SETTINGS.passbook_path), but "Save to Google Wallet"
 *  (SETTINGS.enable_google_wallet) is off at Chessington. Neither the parks nor
 *  the pass site links this page from anywhere obvious. */
const findOrder = (origin: string, wallet: string): ParkLink => ({
  label: "Find my tickets",
  url: `${origin}/orderLookup`,
  note: `Look up an order with the email address and phone number you booked with - no account needed, and adds to ${wallet}`,
});

/** The same lookup on the Merlin Annual Pass store, which is a separate accesso
 *  merchant (ME-ANNUALPASS) from the four park stores — so a pass bought there
 *  will not show up in a park's own lookup, and vice versa. */
const MAP_FIND_PASS: ParkLink = {
  label: "Find my annual pass",
  url: "https://me-annualpass.tickets.merlinannualpass.co.uk/orderLookup",
  note: "Passes are a separate order from park tickets - same email and phone lookup, adds to Apple or Google Wallet",
};

/** Lift closures across all four Merlin resort theme parks — one shared page on
 *  Merlin's accessibility site, not a per-park one, so the same URL appears on
 *  each. It lists the lift by ride (currently Alton's Smiler and Get Set Go
 *  Octonauts, Chessington's Blue Barnacle, Legoland's Deep Sea Adventure), and
 *  only Alton's own site links it — from the foot of its ride availability page.
 *  No independent publishes an equivalent. */
const MERLIN_LIFTS: ParkLink = {
  label: "Lift availability",
  url: "https://www.accessibility.merlinentertainments.biz/ride-access-pass/uk-resort-theme-park-lift-availability/",
  note: "Lifts out for maintenance across all four Merlin parks, and the step-free alternatives",
};

/** A park's closure list. The default note fits the six parks whose page is a
 *  schedule of planned maintenance; Flamingo Land overrides it. */
const rideAvailability = (url: string, note?: string): ParkLink => ({
  label: "Ride availability",
  url,
  note: note ?? "Planned and long-term ride closures, from the park itself",
});

/** The park's own opening-times page. Worth linking next to our calendar feed:
 *  it's what the hours poller reads, so it's the authority when they differ. */
const openingTimes = (url: string): ParkLink => ({
  label: "Opening times",
  url,
  note: "The park's own calendar - what our hours are read from",
});

/** The Merlin Ride Access Pass app — one app covering all four Merlin parks
 *  (RAP applications and ride bookings moved into it), so it's listed alongside
 *  each park's own app. */
const RAP_APP: AppLink = {
  name: "Merlin Ride Access Pass",
  ios: appStore("merlin-ride-access-pass", "6755305025"),
  android: playStore("org.merlin.rideaccesspass"),
  note: "Apply for and manage your RAP across all Merlin parks",
};

const rapInfo = (url: string): ParkLink => ({
  label: "Ride Access Pass",
  url,
  note: "Eligibility, evidence required and how to apply",
});

/** Merlin ride photos, mid-migration between two photo systems, so both are
 *  linked. The older is Pomvom's imagic (formerly Picsolve), one web app for
 *  every park keyed by a site code: `at`, `tp`, `ch` and `ll`, from the
 *  attraction enum in its bundle. alton.photos and thorpe.photos 301 to the
 *  first two. The newer is Venu+ (NXT Capture), whose park picker routes to a
 *  `page_route` per park, again from its bundle. Chessington's is `cwoa`. It
 *  lives on the Amplify app's default `main` branch URL, which looks
 *  temporary but is the address printed, as text and as a QR code, on the
 *  in-park photo receipts. `info` is the park's own product page (prices and
 *  the rides covered). */
const merlinPhotos = (info: string, pomvom: string, venu: string): ParkLink[] => [
  {
    label: "Unlimited Digital Photos",
    url: info,
    note: "Price and which rides have photos, from the park itself",
  },
  {
    label: "Venu+ photos",
    url: `https://main.d27xeg78h8take.amplifyapp.com/${venu}`,
    note: "Newer photo system - gallery tied to your phone number or email",
  },
  {
    label: "imagic photos",
    url: `https://photos-uk.pomvom.com/${pomvom}`,
    note: "Older Pomvom photo system",
  },
];

export const PARK_LINKS: Record<string, ParkLinks> = {
  alton_towers: {
    website: "https://www.altontowers.com/",
    location: {
      address: "Alton Towers Resort, Alton, Staffordshire",
      postcode: "ST10 4DB",
      query: "Alton Towers Resort, ST10 4DB",
      // Car park pins come from the park's own app bundle (the same
      // Attractions.io records the venue sync reads). The lettered car parks
      // all hang off one approach road, so A stands in for the set.
      drive: { lat: 52.987439, lon: -1.880787, label: "Car Park A" },
      directions:
        "https://www.altontowers.com/plan-your-visit/before-you-visit/directions/",
      note: "The park warns that some sat navs take you down a local farm track, especially from the B5417 — follow the road signs for the last few miles.",
    },
    booking: [
      bookTickets("https://me-twalton.tickets.altontowers.com"),
      {
        label: "Passholder prebook",
        url: MAP_PREBOOK,
        note: "Book and manage Merlin Annual Pass trips",
      },
      fastrackPerk(
        "https://me-twalton.tickets.altontowers.com",
        "MAP10Fastrack",
      ),
    ],
    orders: [
      findOrder(
        "https://me-twalton.tickets.altontowers.com",
        "Apple or Google Wallet",
      ),
      MAP_FIND_PASS,
    ],
    rideAvailability: rideAvailability("https://www.altontowers.com/plan-your-visit/resort-information/ride-attraction-availability/"),
    openingTimes: openingTimes("https://www.altontowers.com/plan-your-visit/before-you-visit/opening-times/"),
    liftAvailability: MERLIN_LIFTS,
    access: [
      rapInfo(
        "https://www.altontowers.com/plan-your-visit/before-you-visit/accessibility/accessibility-theme-park/ride-access-pass/",
      ),
    ],
    photos: merlinPhotos(
      "https://www.altontowers.com/tickets-passes/extras/ride-photos/",
      "at",
      "alton-towers",
    ),
    apps: [
      {
        name: "Alton Towers Resort",
        ios: appStore("alton-towers-resort-official", "683491029"),
        android: playStore("com.thrillseeker.altontowers"),
      },
      RAP_APP,
    ],
    social: {
      facebook: "https://www.facebook.com/altontowersresort/",
      instagram: "https://www.instagram.com/altontowers/",
      tiktok: "https://www.tiktok.com/@altontowers",
      x: "https://x.com/altontowers",
      youtube: "https://www.youtube.com/user/officialaltontowers",
    },
  },

  thorpe_park: {
    website: "https://www.thorpepark.com/",
    location: {
      address: "Thorpe Park, Staines Road, Chertsey, Surrey",
      postcode: "KT16 8PN",
      query: "Thorpe Park, KT16 8PN",
      // The park's one visitor car park, from its app bundle.
      drive: { lat: 51.40481, lon: -0.508092, label: "the main car park" },
      directions:
        "https://www.thorpepark.com/plan-your-visit/before-you-visit/directions/",
      note: "The postcode sends some sat navs to Norlands Lane; the entrance is on Staines Road, under the rollercoaster track.",
    },
    booking: [
      bookTickets("https://me-tpr.tickets.thorpepark.com"),
      {
        label: "Passholder prebook",
        url: MAP_PREBOOK,
        note: "Book and manage Merlin Annual Pass trips",
      },
      fastrackPerk("https://me-tpr.tickets.thorpepark.com", "1shot10p"),
    ],
    orders: [
      findOrder(
        "https://me-tpr.tickets.thorpepark.com",
        "Apple or Google Wallet",
      ),
      MAP_FIND_PASS,
    ],
    rideAvailability: rideAvailability("https://www.thorpepark.com/plan-your-visit/resort-information/ride-availability/"),
    openingTimes: openingTimes("https://www.thorpepark.com/plan-your-visit/before-you-visit/opening-times/"),
    liftAvailability: MERLIN_LIFTS,
    access: [
      rapInfo(
        "https://www.thorpepark.com/plan-your-visit/before-you-visit/accessibility-information/theme-park-accessibility/ride-access-pass/",
      ),
    ],
    photos: merlinPhotos(
      "https://www.thorpepark.com/tickets-passes/extras/photos/",
      "tp",
      "thorpe-park",
    ),
    apps: [
      {
        name: "THORPE PARK",
        ios: appStore("thorpe-park-official", "1218401801"),
        android: playStore("io.attractions.thorpepark"),
      },
      RAP_APP,
    ],
    social: {
      facebook: "https://www.facebook.com/thorpepark/",
      instagram: "https://www.instagram.com/thorpeparkofficial/",
      tiktok: "https://www.tiktok.com/@thorpepark",
      x: "https://x.com/THORPEPARK",
      youtube: "https://www.youtube.com/channel/UCKgMp8AuO4hqYOtiXlCwawQ",
    },
  },

  legoland: {
    website: "https://www.legoland.co.uk/",
    location: {
      address: "LEGOLAND Windsor Resort, Winkfield Road, Windsor, Berkshire",
      postcode: "SL4 4AY",
      query: "LEGOLAND Windsor Resort, SL4 4AY",
      // First of the standard car parks off Winkfield Road, from the app
      // bundle (C, D and E follow it down the same road).
      drive: { lat: 51.464872, lon: -0.65747, label: "Standard Parking B" },
      directions:
        "https://www.legoland.co.uk/plan-your-day/before-you-visit/directions/",
      note: "Follow the LEGOLAND signs on the local roads once you're close.",
    },
    booking: [
      bookTickets("https://me-llwindsor.tickets.legoland.co.uk"),
      {
        label: "Passholder prebook",
        url: MAP_PREBOOK,
        note: "Book and manage Merlin Annual Pass trips",
      },
      fastrackPerk("https://me-llwindsor.tickets.legoland.co.uk", "MAPFT10"),
    ],
    orders: [
      findOrder(
        "https://me-llwindsor.tickets.legoland.co.uk",
        "Apple or Google Wallet",
      ),
      MAP_FIND_PASS,
    ],
    rideAvailability: rideAvailability("https://www.legoland.co.uk/plan-your-day/useful-guides/ride-availability/"),
    openingTimes: openingTimes("https://www.legoland.co.uk/plan-your-day/before-you-visit/opening-hours/"),
    liftAvailability: MERLIN_LIFTS,
    access: [
      rapInfo(
        "https://www.legoland.co.uk/plan-your-day/before-you-visit/accessibility/theme-park-accessibility/ride-access-pass/",
      ),
    ],
    photos: merlinPhotos(
      "https://www.legoland.co.uk/tickets-passes/extras/unlimited-digital-photos/",
      "ll",
      "legoland-windsor",
    ),
    apps: [
      {
        name: "LEGOLAND Windsor Resort",
        ios: appStore("legoland-windsor-resort", "610646379"),
        android: playStore("com.merlin.legowi"),
      },
      RAP_APP,
    ],
    social: {
      facebook: "https://www.facebook.com/legolandwindsor",
      instagram: "https://www.instagram.com/legolandwindsor/",
      tiktok: "https://www.tiktok.com/@legolandwindsor",
      x: "https://x.com/LEGOLANDWindsor",
      youtube: "https://www.youtube.com/user/LEGOLANDWindsor",
    },
  },

  chessington: {
    website: "https://www.chessington.com/",
    location: {
      address:
        "Chessington World of Adventures Resort, Leatherhead Road, Chessington, Surrey",
      postcode: "KT9 2NE",
      query: "Chessington World of Adventures, KT9 2NE",
      // A standard car park from the app bundle — Ostrich is for larger
      // vehicles and Express is the paid one nearer the gate.
      drive: { lat: 51.346511, lon: -0.320942, label: "Giraffe Car Park" },
      directions:
        "https://www.chessington.com/plan-your-visit/before-you-visit/directions/",
    },
    booking: [
      bookTickets("https://me-wachessington.tickets.chessington.com"),
      {
        label: "Passholder prebook",
        url: MAP_PREBOOK,
        note: "Book and manage Merlin Annual Pass trips",
      },
      fastrackPerk("https://me-wachessington.tickets.chessington.com", "mapft10"),
    ],
    orders: [
      findOrder(
        "https://me-wachessington.tickets.chessington.com",
        "Apple Wallet",
      ),
      MAP_FIND_PASS,
    ],
    rideAvailability: rideAvailability("https://www.chessington.com/plan-your-visit/resort-information/ride-availability/"),
    openingTimes: openingTimes("https://www.chessington.com/plan-your-visit/before-you-visit/opening-hours/"),
    liftAvailability: MERLIN_LIFTS,
    access: [
      rapInfo(
        "https://www.chessington.com/plan-your-visit/before-you-visit/accessibility-guide/theme-park-accessibility/ride-access-pass/",
      ),
    ],
    photos: merlinPhotos(
      "https://www.chessington.com/tickets-passes/extras/photography/",
      "ch",
      "cwoa",
    ),
    apps: [
      {
        name: "Chessington Resort",
        ios: appStore("chessington-resort", "974983909"),
        android: playStore("thrillseeker.app.chessington"),
      },
      RAP_APP,
    ],
    social: {
      facebook: "https://www.facebook.com/chessington",
      instagram: "https://www.instagram.com/chessingtonworldofadventures",
      tiktok: "https://www.tiktok.com/@cwoar",
      x: "https://x.com/CWOA",
      youtube: "https://www.youtube.com/Chessington",
    },
  },

  // Independent — no accesso store and no Merlin pass, so no prebook/Fastrack
  // rows. Its ride-access scheme is the Queue Assist Pass, with Essential
  // Companion tickets booked separately.
  paultons: {
    website: "https://paultonspark.co.uk/",
    location: {
      address: "Paultons Park, Ower, Romsey, The New Forest, Hampshire",
      postcode: "SO51 6AL",
      query: "Paultons Park, SO51 6AL",
      // The pin Paulton's own directions page navigates to; parking is free
      // and sits alongside the entrance.
      drive: { lat: 50.948297, lon: -1.551914, label: "the park entrance" },
      directions: "https://paultonspark.co.uk/info/directions",
      note: "Parking is free.",
    },
    booking: [
      {
        label: "Book tickets",
        url: "https://paultonspark.co.uk/tickets/",
        note: "Day tickets, annual passes and add-ons",
      },
    ],
    // No email-and-phone lookup here: Paulton's store keeps orders behind a
    // password-protected account, which is also where a confirmation is
    // resent from.
    orders: [
      {
        label: "Your Paultons account",
        url: "https://paultonspark.co.uk/account/",
        note: "Sign in for order history, ticket downloads and confirmation resends",
      },
    ],
    rideAvailability: rideAvailability("https://paultonspark.co.uk/info/ride-availability"),
    openingTimes: openingTimes("https://paultonspark.co.uk/info/opening-times"),
    access: [
      {
        label: "Guests with access requirements",
        url: "https://paultonspark.co.uk/help/guests-with-access-requirements",
        note: "Overview, plus per-ride accessibility details",
      },
      {
        label: "Queue Assist Pass",
        url: "https://paultonspark.co.uk/help/queue-assist-pass",
        note: "Paulton's equivalent of a Ride Access Pass",
      },
      {
        label: "Essential Companion tickets",
        url: "https://paultonspark.co.uk/info/accessibility/essential-companion/",
        note: "Free carer entry - eligibility and how to book",
      },
    ],
    photos: [
      {
        label: "Photo Pass",
        url: "https://paultonspark.co.uk/tickets/photo-passes/",
        note: "5 printed items from the photo kiosks, plus 3 days of unlimited digital downloads",
      },
    ],
    apps: [
      {
        name: "Paultons Park",
        ios: appStore("paultons-park", "500467063"),
        android: playStore("thrillseeker.app.paultons"),
      },
    ],
    social: {
      facebook: "https://www.facebook.com/paultonspark",
      instagram: "https://www.instagram.com/paultonspark/",
      tiktok: "https://www.tiktok.com/@paultonspark",
      x: "https://x.com/paultonspark",
      youtube: "https://www.youtube.com/PaultonsPark",
      // Only Paulton's publishes these two, and only in its interior-page
      // footer — the homepage footer carries a shorter set.
      pinterest: "https://uk.pinterest.com/paultonspark/",
      linkedin: "https://uk.linkedin.com/company/paultonspark",
    },
  },

  // Independent — tickets sit on its own reservations system.
  flamingoland: {
    website: "https://www.flamingoland.co.uk/",
    location: {
      address: "Flamingo Land Resort, Kirby Misperton, Malton, North Yorkshire",
      postcode: "YO17 6UX",
      query: "Flamingo Land, YO17 6UX",
      // No `drive`: neither the park nor OpenStreetMap publishes a pin for the
      // visitor car park, and the postcode centroid is only what the apps would
      // geocode to anyway.
      directions: "https://www.flamingoland.co.uk/plan-your-visit/how-to-find-us/",
    },
    booking: [
      {
        label: "Book tickets",
        url: "https://reservations.flamingoland.co.uk/book",
        note: "Direct to the park's booking system",
      },
      {
        label: "Ticket prices",
        url: "https://www.flamingoland.co.uk/plan-your-visit/ticket-prices/",
      },
    ],
    // Flamingo Land's webshop runs neither an order lookup nor a customer
    // account, so there's nothing to link — a missing confirmation goes
    // through the contact page.
    orders: [],
    rideAvailability: rideAvailability("https://www.flamingoland.co.uk/today/", "Today's maintenance closures and show times"),
    openingTimes: openingTimes("https://www.flamingoland.co.uk/plan-your-visit/whats-on-and-opening-times/"),
    access: [
      {
        label: "Accessibility guide",
        url: "https://www.flamingoland.co.uk/plan-your-visit/accessibility-guide/",
        note: "Access provision and ride restrictions",
      },
    ],
    // No ride photography advertised anywhere on the park's site.
    photos: [],
    apps: [
      {
        name: "Flamingo Land Resort",
        ios: appStore("flamingo-land-resort", "1592510247"),
        android: playStore("com.flamingoLandResort.visitorApp"),
      },
    ],
    social: {
      facebook: "https://www.facebook.com/flamingolandresort",
      instagram: "https://www.instagram.com/flamingolandresort/",
      tiktok: "https://www.tiktok.com/@flamingolandresort",
      x: "https://x.com/flamingolanduk",
      youtube: "https://www.youtube.com/channel/UCtyNVinZ7tfjgWoeApTmlkQ",
    },
  },

  // Independent — Speedy Pass is the Fastrack equivalent (bought in park or via
  // the resort app, so there's no direct booking URL to link, only the info
  // page); Easy Pass is the ride-access scheme, and its applications are handled
  // by Access Card rather than the park itself.
  blackpool: {
    website: "https://www.blackpoolpleasurebeach.com/",
    location: {
      address: "Pleasure Beach Resort, 525 Ocean Boulevard, Blackpool",
      postcode: "FY4 1EZ",
      query: "Blackpool Pleasure Beach, FY4 1EZ",
      // FY4 1HR, the postcode the resort gives for its main car park (ONS
      // postcode centroid — the resort publishes no pin of its own).
      drive: { lat: 53.793848, lon: -3.0544, label: "North Car Park" },
      directions: "https://www.blackpoolpleasurebeach.com/getting-here-parking/",
      note: "Paid parking only, and the resort's own car parks are split three ways — the main one is North Car Park, Balmoral Road, FY4 1HR.",
    },
    booking: [
      {
        label: "Book wristbands",
        url: "https://bookings.blackpoolpleasurebeach.com/wristband/select-date",
        note: "Direct to the date picker for park wristbands",
      },
      {
        label: "Season pass",
        url: "https://bookings.blackpoolpleasurebeach.com/season-pass",
      },
      {
        label: "Speedy Pass",
        url: "https://www.blackpoolpleasurebeach.com/speedy-pass-virtual-queuing/",
        note: "Virtual queuing - bought in park or in the resort app",
      },
    ],
    // Account-only, like Paulton's: /my-account bounces to the sign-in form
    // when you're signed out.
    orders: [
      {
        label: "Your bookings account",
        url: "https://bookings.blackpoolpleasurebeach.com/my-account",
        note: "Sign in to see wristbands and season passes you've bought",
      },
    ],
    rideAvailability: rideAvailability("https://www.blackpoolpleasurebeach.com/ride-availability/"),
    openingTimes: openingTimes("https://www.blackpoolpleasurebeach.com/opening-times-prices/"),
    access: [
      {
        label: "Easy Pass",
        url: "https://www.blackpoolpleasurebeach.com/accessibility/#easypass",
        note: "Blackpool's equivalent of a Ride Access Pass",
      },
      {
        label: "Apply via Access Card",
        url: "https://app.accesscard.online/apply/bpb/",
        note: "Easy Pass applications are handled by Access Card",
      },
    ],
    photos: [
      {
        label: "Ride & character photography",
        url: "https://www.blackpoolpleasurebeach.com/photography/",
        note: "Added as a supplement when booking - ride photos are then collected in the resort app",
      },
      // Same Pomvom web app as the Merlin parks, site code `bp`.
      {
        label: "imagic photos",
        url: "https://photos-uk.pomvom.com/bp",
        note: "Pomvom's photo gallery on the web",
      },
    ],
    apps: [
      {
        name: "Pleasure Beach Resort",
        ios: appStore("pleasure-beach-resort", "1623196648"),
        android: playStore("com.bpb.pleasurebeach"),
        note: "Also where Speedy Pass is bought and managed",
      },
    ],
    social: {
      facebook: "https://www.facebook.com/blackpoolpleasurebeach",
      instagram: "https://www.instagram.com/pleasure_beach/",
      tiktok: "https://www.tiktok.com/@pleasure_beach",
      x: "https://x.com/Pleasure_Beach",
      youtube: "https://www.youtube.com/user/PleasureBeachVideos",
    },
  },
};
