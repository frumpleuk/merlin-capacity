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
 *  park missing TikTok simply shows one chip fewer. Few parks publish a
 *  Pinterest or LinkedIn profile on their own site. */
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
   *  do that) — Flamingo Land and Knoebels are the exceptions, their pages are
   *  today's list.
   *  A named field rather than a row in a list because the Queues tab links it
   *  directly, under the ride it explains the absence of. Unset where the park
   *  publishes no closure list (Billund, Deutschland, Gardaland, Korea,
   *  Pleasurewood Hills). */
  rideAvailability?: ParkLink;
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
const findOrder = (origin: string, wallet: string, lang?: string): ParkLink => ({
  label: "Find my tickets",
  // The non-UK stores default to their own language; `l` asks for English.
  url: `${origin}/orderLookup${lang ? `?l=${lang}` : ""}`,
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

// Disneyland Paris - one resort, one site, one app, so both parks share
// everything except `website` (each park's own destination page).
const DLP_LINKS: Omit<ParkLinks, "website"> = {
  location: {
    // Disney's own address labels (seo.microdata.dlpAddress*), on every en-gb
    // page. The homepage JSON-LD gives "77777 Marne-la-Vallee" instead, a
    // CEDEX postal code that map apps don't geocode.
    address: "Disneyland Paris, Boulevard de Parc, Coupvray, France",
    postcode: "77700",
    query: "Disneyland Paris, 77700 Coupvray",
    // OpenStreetMap way 823369270, "Guest Parking Disneyland Paris"
    // (amenity=parking, operator=Disneyland Paris, fee=yes, last edited
    // 2025-06-04), centre of the outline. The site calls it the Disney Car Park.
    drive: { lat: 48.8757075, lon: 2.7888327, label: "the Disney Car Park" },
    directions: "https://www.disneylandparis.com/en-gb/guest-services/how-to-get-to-disneyland-paris",
    note: "The Disney Car Park is EUR 30 a day for cars, free for Bronze, Silver and Gold Disneyland Pass holders, and opens at 08:00.",
  },
  booking: [
    {
      label: "Book tickets",
      url: "https://tickets.disneylandparis.com/en-gb/tickets",
      note: "Dated and undated park tickets",
    },
    {
      label: "Register a visit",
      url: "https://www.disneylandparis.com/en-gb/register-tickets",
      note: "Undated tickets and Disneyland Passes need a visit date registered in advance",
    },
    {
      label: "Disney Premier Access",
      url: "https://www.disneylandparis.com/en-gb/attractions/disney-premier-access",
      note: "Paid queue skip - Ultimate in advance or on the day, One on the day in the app",
    },
    {
      label: "Disneyland Pass",
      url: "https://www.disneylandparis.com/en-gb/offers/disneyland-pass",
      note: "Disney's annual pass",
    },
  ],
  orders: [
    {
      label: "View my booking",
      url: "https://book.disneylandparis.com/en-gb/booking-portfolio",
      note: "Hotel + Tickets packages",
    },
    {
      label: "My Disneyland account",
      url: "https://guest.disneylandparis.com/en-gb/my-disneyland/",
      note: "Sign in to see linked tickets, passes and visit registrations",
    },
  ],
  rideAvailability: rideAvailability(
    "https://www.disneylandparis.com/en-gb/attractions/",
    "Every attraction in both parks, with those closed marked",
  ),
  openingTimes: openingTimes("https://www.disneylandparis.com/en-gb/calendars/park-hours"),
  access: [
    {
      label: "Accessibility",
      url: "https://www.disneylandparis.com/en-gb/guest-services/accessibility-at-disneylandparis",
      note: "Access in attractions, shows and restaurants, and downloadable accessibility guides",
    },
    {
      label: "Priority Card",
      url: "https://www.disneylandparis.com/en-gb/guest-services/priority-card",
      note: "Disney's access card - apply online up to 1 month ahead, collect on the day with proof of disability",
    },
    {
      label: "Tickets for guests with disabilities",
      url: "https://tickets.disneylandparis.com/en-gb/tickets-guests-with-disabilities",
      note: "Special-rate tickets",
    },
  ],
  photos: [
    {
      label: "Disney PhotoPass",
      url: "https://www.disneylandparis.com/en-gb/guest-services/photopass-service",
      note: "Ride and character photos; PhotoPass+ covers all of them for 10 days",
    },
    {
      label: "Claim photos",
      url: "https://www.disneyphotopass.eu/claim/index",
      note: "View and download photos with the code on the back of a PhotoPass+ card",
    },
  ],
  apps: [
    {
      name: "Disneyland Paris",
      ios: appStore("disneyland-paris", "396908589"),
      android: playStore("fr.disneylandparis.android"),
      note: "Also where Disney Premier Access is bought and its QR codes kept",
    },
  ],
  social: {
    facebook: "https://www.facebook.com/disneylandparis/",
    instagram: "https://www.instagram.com/disneylandparis/",
    x: "https://x.com/disneyparis_en",
    youtube: "https://www.youtube.com/user/disneylandparis",
  },
};

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

  // Disneyland Paris - one resort, one site, one app, so both parks share
  // everything except `website` (DLP_LINKS, above).
  disneyland_park: {
    ...DLP_LINKS,
    website: "https://www.disneylandparis.com/en-gb/destinations/disneyland-park/",
  },
  disney_adventure_world: {
    ...DLP_LINKS,
    website: "https://www.disneylandparis.com/en-gb/destinations/disney-adventure-world/",
  },

  // accesso store (ME-LLBILLUND). Its access scheme is the Show Consideration
  // wristband, issued on the day at Information.
  legoland_billund: {
    website: "https://www.legoland.dk/en/",
    location: {
      address: "LEGOLAND Billund Resort, Nordmarksvej 9, Billund, Denmark",
      postcode: "7190",
      query: "LEGOLAND Billund Resort, Nordmarksvej 9, 7190 Billund",
      // OSM way 81898191, amenity=parking "Legoland P1" (fee=yes): the P1
      // polygon north of the entrance.
      drive: { lat: 55.737205, lon: 9.126992, label: "Car park P1" },
      directions: "https://www.legoland.dk/en/plan-your-day/pre-visit/directions/",
      note: "Parking is paid at P1, P2, P3, P5 and P6 and charged by number plate - pay online, at the kiosks, or within 48 hours of leaving.",
    },
    booking: [
      {
        label: "Book tickets",
        url: "https://me-llbillund.tickets.legoland.dk/snap-calendar-wizard/SnapWizardEN/SnapWizardAdmissionEN?l=en-dk",
        note: "Direct to the date picker on the park's ticketing site",
      },
      { label: "Day tickets", url: "https://www.legoland.dk/en/tickets-passes/tickets/" },
      {
        label: "Fastrack",
        url: "https://www.legoland.dk/en/tickets-passes/extras/fastrack/",
        note: "Gold, Silver and Bronze - valid on the chosen date only",
      },
      { label: "Season passes", url: "https://www.legoland.dk/en/tickets-passes/season-passes/" },
    ],
    orders: [findOrder("https://me-llbillund.tickets.legoland.dk", "Apple Wallet", "en-dk")],
    openingTimes: openingTimes("https://www.legoland.dk/en/plan-your-day/pre-visit/opening-hours/"),
    access: [
      {
        label: "Guests with special needs",
        url: "https://www.legoland.dk/en/plan-your-day/information/guests-with-special-needs/",
        note: "Overview - wristband, companion scheme, wheelchair booking",
      },
      {
        label: "Show Consideration wristband",
        url: "https://www.legoland.dk/en/plan-your-day/information/show-consideration-wristband/",
        note: "Billund's equivalent of a Ride Access Pass - issued at Information on the day, with documentation",
      },
      {
        label: "Companion scheme",
        url: "https://www.legoland.dk/en/plan-your-day/information/companion-scheme/",
        note: "One free companion with a valid companion card",
      },
      {
        label: "Accessibility guide",
        url: "https://www.legoland.dk/en/plan-your-day/information/accessibility-at-legoland/",
        note: "Ride access, wheelchairs, toilets, parking and assistance dogs",
      },
    ],
    photos: [
      {
        label: "Photo Pass",
        url: "https://www.legoland.dk/en/tickets-passes/extras/",
        note: "A day of park photos to download, plus 4 vouchers for printed products - listed on the extras page",
      },
    ],
    apps: [
      {
        name: "LEGOLAND Billund Resort",
        ios: appStore("legoland-billund-resort", "528921749"),
        android: playStore("com.merlin.llb"),
      },
    ],
    social: {
      facebook: "https://www.facebook.com/LEGOLANDBillund/",
      instagram: "https://www.instagram.com/legolandbillund/",
      youtube: "https://www.youtube.com/channel/UCpeYoADJY5uwoy2WQFiKHKg",
      linkedin: "https://www.linkedin.com/company/legoland-billund-resort/",
    },
  },

  // accesso store (ME-LLGERMANY). Access is a wristband issued at the entrance
  // on a severely disabled pass.
  legoland_deutschland: {
    website: "https://www.legoland.de/en/",
    location: {
      address: "LEGOLAND Deutschland Resort, LEGOLAND Allee 1, Günzburg, Bavaria, Germany",
      postcode: "89312",
      query: "LEGOLAND Deutschland Resort, LEGOLAND Allee 1, 89312 Günzburg",
      // OSM way 163415314, amenity=parking name=Legoland, fee=yes,
      // access=customers.
      drive: { lat: 48.422812, lon: 10.297619, label: "the main car park" },
      directions: "https://www.legoland.de/en/plan-your-visit/plan-your-visit/getting-here/",
      note: "Leave the A8 at Günzburg and follow the signs. Parking is paid - the ticket is scanned at the barrier on the way out.",
    },
    booking: [
      {
        label: "Book tickets",
        url: "https://me-llgermany.tickets.legoland.de/snap-calendar-wizard/SnapWizardEN/SnapAdmissionEN?l=en-de",
        note: "Direct to the date picker on the park's ticketing site",
      },
      { label: "Day tickets", url: "https://www.legoland.de/en/tickets/most-popular-tickets/day-tickets/" },
      { label: "Fastrack", url: "https://www.legoland.de/en/tickets/most-popular-tickets/fastrack/" },
      { label: "Parking ticket", url: "https://www.legoland.de/en/tickets/most-popular-tickets/parking-ticket/" },
    ],
    orders: [findOrder("https://me-llgermany.tickets.legoland.de", "Apple Wallet", "en-de")],
    openingTimes: openingTimes("https://www.legoland.de/en/plan-your-visit/plan-your-visit/opening-hours/"),
    access: [
      {
        label: "Disabled visitors",
        url: "https://www.legoland.de/en/plan-your-visit/plan-your-visit/disabled-visitors/",
        note: "Wristband for quicker ride access, issued at the entrance on a severely disabled pass; companions with B or H enter free",
      },
      {
        label: "Wristband form",
        url: "https://www.legoland.de/media/jwtcwni1/nimm-ruecksicht-armband_en.pdf",
        note: "PDF form for the access wristband",
      },
    ],
    photos: [
      {
        label: "Photo Pass",
        url: "https://www.legoland.de/en/tickets/most-popular-tickets/photo-pass/",
        note: "Six printed on-ride photos - vouchers collected at the entrance, valid all season",
      },
    ],
    apps: [
      {
        name: "LEGOLAND Deutschland Resort",
        ios: appStore("legoland-deutschland-resort", "1389753425"),
        android: playStore("biz.merlinentertainments.legoland.deutschland"),
      },
    ],
    social: {
      facebook: "https://www.facebook.com/LEGOLANDDeutschlandResort/",
      instagram: "https://www.instagram.com/legolanddeutschlandresort/",
      tiktok: "https://www.tiktok.com/@legolanddeutschland",
      youtube: "https://www.youtube.com/legolanddeutschlandresort",
    },
  },

  // Vivaticket store, not accesso. Access scheme is the Special Guest pass;
  // Gardaland Express fast-track runs through its own app.
  gardaland: {
    website: "https://www.gardaland.it/en/",
    location: {
      address: "Gardaland Resort, Via Derna 4, Castelnuovo del Garda (VR), Italy",
      postcode: "37014",
      query: "Gardaland, Via Derna 4, 37014 Castelnuovo del Garda",
      // No `drive`: OSM has no named main car park, and the park's only
      // published coordinate is for the motorhome and bus park.
      directions: "https://www.gardaland.it/en/useful-information/plan-your-visit/directions/",
      note: "Parking is free; covered spaces can be bought online. Motorhomes use the bus park on Via Ronchi.",
    },
    booking: [
      {
        label: "Book tickets",
        url: "https://tickets.gardaland.it/b2c/ticketSale/tickets?category=GPARK&locale=en-GB",
        note: "Direct to the park's ticket shop",
      },
      { label: "Gardaland Park tickets", url: "https://www.gardaland.it/en/tickets-season-passes/tickets/gardaland-park/" },
      {
        label: "Gardaland Express",
        url: "https://www.gardaland.it/en/tickets-season-passes/extra/gardaland-express/",
        note: "Fast-track bundles of 5, 17 or unlimited rides - used through the Gardaland Express app",
      },
      { label: "Covered parking", url: "https://www.gardaland.it/en/tickets-season-passes/extra/car-park-entrance/" },
    ],
    // The site's "Manage my bookings" covers hotel stays only; nothing on the
    // site links a ticket order lookup.
    orders: [],
    openingTimes: openingTimes("https://www.gardaland.it/en/useful-information/plan-your-visit/opening-times/"),
    access: [
      {
        label: "Accessibility",
        url: "https://www.gardaland.it/en/useful-information/plan-your-visit/accessibility/",
        note: "Overview and the accessibility guide",
      },
      {
        label: "Special Guest pass",
        url: "https://www.gardaland.it/en/useful-information/plan-your-visit/accessibility/before-your-visit/",
        note: "Gardaland's equivalent of a Ride Access Pass - priority access for the guest and up to 3 companions, issued on the day at the Welcome Desk",
      },
      {
        label: "Accessibility in the park",
        url: "https://www.gardaland.it/en/useful-information/plan-your-visit/accessibility/gardaland-park/",
        note: "Ride admission rules, wheelchairs and services",
      },
    ],
    photos: [
      {
        label: "Photo Pass",
        url: "https://www.gardaland.it/en/tickets-season-passes/extra/photo-passes/",
        note: "Unlimited digital downloads for 1 or 2 days, and which rides have photos",
      },
    ],
    apps: [
      {
        name: "Gardaland Resort",
        ios: appStore("gardaland-resort-app-ufficiale", "442647354"),
        android: playStore("com.merlin.gardaland"),
      },
      {
        name: "Gardaland Express",
        ios: appStore("gardaland-express", "6445852859"),
        android: playStore("com.merlin.gardalandexpress"),
        note: "Required to use Gardaland Express fast-track - joins the ride queue for you",
      },
    ],
    social: {
      facebook: "https://www.facebook.com/gardaland",
      instagram: "https://www.instagram.com/gardaland/",
      tiktok: "https://www.tiktok.com/@gardaland_official",
      // X is linked only in the footer of some pages (e.g. Manage my bookings).
      x: "https://x.com/gardaland",
      youtube: "https://www.youtube.com/user/gardaland",
    },
  },

  // accesso store (ME-HPGERMANY). Access scheme is the Schwer-in-Ordnung Pass.
  heide_park: {
    website: "https://www.heide-park.de/en/",
    location: {
      address: "Heide Park Resort, Heide Park 1, Soltau, Germany",
      postcode: "29614",
      query: "Heide Park Resort, Heide Park 1, 29614 Soltau",
      // OSM way 28865941, amenity=parking operator="Heide-Park Resort",
      // fee=yes, access=customers. The resort has two large car parks; the
      // other is unnamed (way 28865939, to the north).
      drive: { lat: 53.02572, lon: 9.872308, label: "the resort car park" },
      directions: "https://www.heide-park.de/en/plan-your-visit/before-you-visit/directions/",
      note: "Take the A7 to the Soltau-Ost exit, then follow the signs. Parking is paid and costs more on site than online.",
    },
    booking: [
      {
        label: "Book tickets",
        url: "https://me-hpgermany.tickets.heide-park.de/snap-calendar-wizard/SnapWizardEN/SnapWizardAdmissionEN?l=en-de",
        note: "Direct to the date picker on the park's ticketing site",
      },
      { label: "Tickets", url: "https://www.heide-park.de/en/tickets-passes/tickets/" },
      {
        label: "Express Ticket",
        url: "https://www.heide-park.de/en/tickets-passes/extras/express-ticket/",
        note: "Heide Park's Fastrack - time slots booked in the app",
      },
      { label: "Parking", url: "https://www.heide-park.de/en/tickets-passes/extras/parking/" },
    ],
    orders: [findOrder("https://me-hpgermany.tickets.heide-park.de", "Apple Wallet", "en-de")],
    rideAvailability: rideAvailability("https://www.heide-park.de/en/plan-your-visit/infos/ride-availability/"),
    openingTimes: openingTimes("https://www.heide-park.de/en/plan-your-visit/before-you-visit/opening-hours/"),
    access: [
      {
        label: "Schwer-in-Ordnung Pass",
        url: "https://www.heide-park.de/en/plan-your-visit/before-you-visit/accessibility/",
        note: "Heide Park's equivalent of a Ride Access Pass - six rides via the express entrance or exit",
      },
      {
        label: "Accessibility details",
        url: "https://www.heide-park.de/en/plan-your-visit/before-you-visit/accessibility/accessibility/",
        note: "Ride access, toilets, car parks and assistance dogs",
      },
      {
        label: "Tickets for visitors with disabilities",
        url: "https://www.heide-park.de/en/tickets-passes/tickets/visitors-with-disabilities/",
        note: "Reduced entry with a disability card, free for permanent wheelchair users, one reduced companion ticket",
      },
    ],
    photos: [
      {
        label: "Digital Photo Pass",
        url: "https://www.heide-park.de/en/tickets-passes/extras/unlimited-digital-photos/",
        note: "Sold on site only for now - online booking is suspended",
      },
    ],
    apps: [
      {
        name: "Heide Park Resort",
        ios: appStore("heide-park-resort", "439867160"),
        android: playStore("de.heide_park.heidepark"),
      },
    ],
    social: {
      facebook: "https://www.facebook.com/heideparkresort",
      instagram: "https://www.instagram.com/heideparkresort/",
      tiktok: "https://www.tiktok.com/@heideparkresort",
      youtube: "https://www.youtube.com/HeideParkResort",
    },
  },

  // accesso merchant ME-LLJAPAN on accesso's Asia stack. The park has no car
  // park of its own and sends drivers to the city-run Kinjo Futo Parking.
  legoland_japan: {
    website: "https://www.legoland.jp/en/",
    location: {
      address: "LEGOLAND Japan Resort, 2-2-1 Kinjoufutou, Minato-ku, Nagoya-shi",
      postcode: "455-8605",
      query: "LEGOLAND Japan Resort, 455-8605",
      // OpenStreetMap way 516644480, Nagoya City Kinjo Futo Parking (operator
      // Nagoya City, multi-storey, capacity 5010): the lot the park's access
      // page names.
      drive: { lat: 35.051164, lon: 136.849811, label: "Kinjo Futo Parking" },
      directions: "https://www.legoland.jp/en/operation/info/access/",
      note: "The park has no car park of its own - drivers use the paid city-run Kinjo Futo Parking, and the park asks visitors to come by public transport where possible.",
    },
    booking: [
      {
        label: "Book tickets",
        url: "https://me-lljapan.tickets.legoland.jp/packageList/keyword/LEGOLANDDailyTicketsEN?l=en-jp",
        note: "Direct to the date picker for LEGOLAND-only 1 Day Passes",
      },
      {
        label: "1 Day Pass",
        url: "https://www.legoland.jp/en/tickets/1daypass/",
        note: "LEGOLAND, SEA LIFE Nagoya and combined tickets",
      },
      { label: "Annual Pass", url: "https://www.legoland.jp/en/tickets/annual-pass/" },
      { label: "Skip Pass 3-Pack", url: "https://www.legoland.jp/en/tickets/optional/skip-pass-3/" },
      { label: "Skip Pass UNLIMITED", url: "https://www.legoland.jp/en/tickets/optional/skip-pass-unlimited/" },
    ],
    orders: [findOrder("https://me-lljapan.tickets.legoland.jp", "Apple Wallet", "en-jp")],
    rideAvailability: rideAvailability("https://www.legoland.jp/en/operation/info/closed/"),
    openingTimes: openingTimes("https://www.legoland.jp/en/operation/info/opening-hours/opening-hours/"),
    access: [
      {
        label: "Guests with disabilities",
        url: "https://www.legoland.jp/en/resort-guide/service/guests-with-disabilities/",
        note: "Assisted Access Pass, free escort entry and wheelchair-accessible rides",
      },
      {
        label: "Sensory Guide",
        url: "https://www.legoland.jp/media/mrbb3oyi/202406_kankakuguide_eng-1.pdf",
        note: "Stimulation level of every attraction on an 11-point scale (PDF)",
      },
    ],
    photos: [],
    apps: [
      {
        name: "LEGOLAND Japan Resort",
        ios: appStore("legoland-japan-resort", "1385607830"),
        android: playStore("biz.merlinentertainments.legoland.japan"),
      },
    ],
    // Linked from the Japanese homepage footer; the English one has none.
    social: {
      facebook: "https://www.facebook.com/LEGOLANDJAPAN/",
      instagram: "https://www.instagram.com/legolandjapanresort/",
      x: "https://x.com/LEGOLAND_Japan",
      youtube: "https://www.youtube.com/channel/UC7L5nJk5ORCvxfI6C2HJd2A",
    },
  },

  // accesso merchant ME-LLKOREA on accesso's Asia stack. The ride-access scheme
  // is the Hero Pass.
  legoland_korea: {
    website: "https://www.legoland.kr/en/",
    location: {
      address: "LEGOLAND Korea Resort, 128 Hajungdo-gil, Chuncheon-si, Gangwon-do",
      postcode: "24240",
      query: "LEGOLAND Korea Resort, 24240",
      // No `drive`: the OpenStreetMap lots on Hajungdo are unnamed.
      directions: "https://www.legoland.kr/en/plan-your-day/plan-your-visit/parking-directions/",
      note: "Paid parking (first hour free, 12,000 KRW daily maximum), with a shuttle bus from the car park to the park entrance.",
    },
    booking: [
      {
        label: "Book tickets",
        url: "https://me-llkorea.tickets.legoland.kr/packageList/keyword/MainOneDayEntryEN?l=en-kr",
        note: "Direct to the 1-Day Ticket on the park's ticketing site",
      },
      {
        label: "1-Day Admission Ticket",
        url: "https://www.legoland.kr/en/tickets-passes/1-day-admission-ticket/buy-1-day-admission-ticket/",
      },
      {
        label: "Fastrack",
        url: "https://www.legoland.kr/en/tickets-passes/1-day-admission-ticket/fastrack/",
        note: "Gold, Silver and Bronze queue-skip add-ons",
      },
    ],
    orders: [
      findOrder("https://me-llkorea.tickets.legoland.kr", "Apple Wallet", "en-kr"),
      {
        label: "Refund & re-send request",
        url: "https://www.legoland.kr/en/plan-your-day/before-your-visit/online-ticket-refund-re-send-request/",
        note: "Form for refunds and for re-sending online tickets",
      },
    ],
    openingTimes: openingTimes("https://www.legoland.kr/en/plan-your-day/plan-your-visit/opening-hours/"),
    access: [
      {
        label: "Accessibility",
        url: "https://www.legoland.kr/en/plan-your-day/during-your-visit/accessibility/",
        note: "Hero Pass - Korea's equivalent of a Ride Access Pass - and accessible attraction details",
      },
      {
        label: "Caregiver discount",
        url: "https://www.legoland.kr/en/tickets-passes/gate-discount/benefits-for-caregivers-of-guests-with-disabilities/",
        note: "Discounted entry for caregivers of guests with registered disabilities",
      },
    ],
    photos: [],
    apps: [
      {
        name: "LEGOLAND Korea Resort",
        ios: appStore("legoland-korea-resort", "1592076860"),
        android: playStore("kr.legoland.www"),
      },
    ],
    social: {
      facebook: "https://www.facebook.com/LEGOLANDKoreaResort",
      instagram: "https://www.instagram.com/legolandkorearesort/",
      tiktok: "https://www.tiktok.com/@legolandkorearesort",
      youtube: "https://www.youtube.com/@LEGOLANDKoreaResort",
    },
  },

  // accesso on the North American stack (ME-LLFLORIDA). The UK stores' generic
  // SnapWizardAdmission keyword isn't in the NA catalogs, so booking points at
  // the park's own tickets page.
  legoland_florida: {
    website: "https://www.legoland.com/florida/",
    location: {
      address: "LEGOLAND Florida Resort, One LEGOLAND Way, Winter Haven, FL",
      postcode: "33884",
      query: "LEGOLAND Florida Resort, Winter Haven, FL 33884",
      directions: "https://www.legoland.com/florida/plan-your-visit/planning-tools/directions-parking/",
      note: "The park says some GPS systems don't list it yet - use 6000 Cypress Gardens Boulevard, Winter Haven FL 33884 instead.",
    },
    booking: [
      {
        label: "Book tickets",
        url: "https://www.legoland.com/florida/tickets-passes/tickets/",
        note: "Day tickets - Buy Now opens the accesso checkout on the page",
      },
      { label: "Annual passes", url: "https://www.legoland.com/florida/tickets-passes/annual-passes/" },
      { label: "Fastrack", url: "https://www.legoland.com/florida/tickets-passes/extras-experiences/fastrack/" },
    ],
    orders: [
      {
        label: "Find my order",
        url: "https://accountportal.meg-na.accessoticketing.com/accesso90/1000/en-US/recover",
        note: "Look up an order with the email address and phone number you booked with",
      },
      {
        label: "Ticket booking portal",
        url: "https://accountportal.meg-na.accessoticketing.com/accesso90/1000/en-US/login",
        note: "Sign in to change the date or time of your tickets",
      },
    ],
    rideAvailability: rideAvailability(
      "https://www.legoland.com/florida/plan-your-visit/know-before-you-go/temporary-closures/",
      "Planned closures across the resort - LEGOLAND Park, Water Park, Peppa Pig Theme Park and hotels",
    ),
    openingTimes: openingTimes("https://www.legoland.com/florida/plan-your-visit/planning-tools/opening-hours/"),
    access: [
      {
        label: "Accessibility information",
        url: "https://www.legoland.com/florida/plan-your-visit/know-before-you-go/accessibility-information/",
        note: "HERO Access Pass, issued at Guest Services, plus the accessibility and sensory guides",
      },
      {
        label: "Resort accessibility and ADA",
        url: "https://www.legoland.com/florida/plan-your-visit/know-before-you-go/accessibility-information/resort-accessibility-ada-information/",
      },
      {
        label: "Guide for guests with disabilities",
        url: "https://www.legoland.com/florida/media/wlvnclob/disabilities-guide-nov-2024.pdf",
        note: "PDF",
      },
    ],
    photos: [
      {
        label: "Unlimited Digital Photos",
        url: "https://www.legoland.com/florida/tickets-passes/extras-experiences/#product-photos",
        note: "Pre-bought photo pass for the ride cameras",
      },
    ],
    apps: [
      {
        name: "LEGOLAND Florida Resort",
        ios: appStore("legoland-florida-resort", "1383780299"),
        android: playStore("biz.merlinentertainments.legoland.florida"),
      },
    ],
    social: {
      facebook: "https://www.facebook.com/LEGOLANDFlorida",
      instagram: "https://www.instagram.com/legolandflorida/",
      tiktok: "https://www.tiktok.com/@legolandflorida",
      youtube: "https://www.youtube.com/user/LEGOLANDFl",
      pinterest: "https://www.pinterest.com/legolandflorida/",
    },
  },

  // accesso on the North American stack (ME-PEPPAPARKFLORIDA). Shares Legoland
  // Florida's entrance road and closure list.
  peppa_pig_florida: {
    website: "https://www.peppapigthemepark.com/florida/",
    location: {
      address: "Peppa Pig Theme Park Florida, One LEGOLAND Way, Winter Haven, FL",
      postcode: "33884",
      query: "Peppa Pig Theme Park Florida, Winter Haven, FL 33884",
      directions: "https://www.peppapigthemepark.com/florida/plan-your-visit/planning-tools/directions-parking/",
      note: "Shares the LEGOLAND Florida Resort entrance road. The park gives 6000 Cypress Gardens Boulevard, Winter Haven FL 33884 as a second address for GPS.",
    },
    booking: [
      {
        label: "Book tickets",
        url: "https://www.peppapigthemepark.com/florida/tickets-passes/tickets/",
        note: "Day tickets - Buy Now opens the accesso checkout on the page",
      },
      { label: "Annual passes", url: "https://www.peppapigthemepark.com/florida/tickets-passes/annual-passes/" },
    ],
    // No order lookup or manage-booking page on the Peppa Pig site.
    orders: [],
    rideAvailability: rideAvailability(
      "https://www.peppapigthemepark.com/florida/plan-your-visit/know-before-you-go/temporary-closures/",
      "The resort-wide closure list, same as LEGOLAND Florida's - Peppa Pig Theme Park has its own section",
    ),
    openingTimes: openingTimes("https://www.peppapigthemepark.com/florida/plan-your-visit/planning-tools/opening-hours/"),
    access: [
      {
        label: "Accessibility and sensory guide",
        url: "https://www.peppapigthemepark.com/florida/plan-your-visit/know-before-you-go/accessibility-sensory-guide/",
        note: "HERO Access Pass, attraction restrictions and IBCCES sensory ratings",
      },
      {
        label: "HERO accessibility guide",
        url: "https://www.peppapigthemepark.com/florida/media/fifl3s55/web-pptp-hero-accessibility-guide.pdf",
        note: "PDF",
      },
    ],
    photos: [],
    apps: [
      {
        name: "Peppa Pig Theme Park Florida",
        ios: appStore("peppa-pig-theme-park-florida", "1586298603"),
        android: playStore("com.peppapigthemepark.florida"),
      },
    ],
    social: {
      facebook: "https://www.facebook.com/PeppaPigThemeParkFlorida",
      instagram: "https://www.instagram.com/peppapigthemeparkflorida/",
      x: "https://x.com/PeppaPigFlorida",
    },
  },

  // accesso on the North American stack (ME-LLCALIFORNIA).
  legoland_california: {
    website: "https://www.legoland.com/california/",
    location: {
      address: "LEGOLAND California Resort, One LEGOLAND Drive, Carlsbad, CA",
      postcode: "92008",
      query: "LEGOLAND California Resort, Carlsbad, CA 92008",
      directions: "https://www.legoland.com/california/plan-your-visit/planning-tools/directions/",
      note: "From the I-5, take Cannon Road east and turn right at LEGOLAND Drive. Regular parking is to the right, Preferred to the left.",
    },
    booking: [
      {
        label: "Book tickets",
        url: "https://www.legoland.com/california/tickets-passes/tickets/",
        note: "Day tickets - Buy Now opens the accesso checkout on the page",
      },
      { label: "Annual passes", url: "https://www.legoland.com/california/tickets-passes/annual-passes/" },
      { label: "Fastrack", url: "https://www.legoland.com/california/tickets-passes/extras-experiences/fastrack/" },
    ],
    orders: [
      {
        label: "Manage my booking",
        url: "https://accountportal.meg-na.accessoticketing.com/accesso90/2600/en-US/login",
        note: "Sign in to manage a day ticket booking",
      },
    ],
    rideAvailability: rideAvailability(
      "https://www.legoland.com/california/plan-your-visit/know-before-you-go/temporary-closures/",
    ),
    openingTimes: openingTimes("https://www.legoland.com/california/plan-your-visit/planning-tools/opening-hours/"),
    access: [
      {
        label: "Accessibility information",
        url: "https://www.legoland.com/california/plan-your-visit/know-before-you-go/accessibility-information/",
        note: "Assisted Access Pass, issued at Guest Services, plus wheelchair and ECV rental",
      },
      {
        label: "Assisted Access guide",
        url: "https://www.legoland.com/california/media/bypc0w2m/legoland-california-assisted-access-guide.pdf",
        note: "PDF",
      },
    ],
    photos: [
      {
        label: "Unlimited Digital Photos",
        url: "https://www.legoland.com/california/tickets-passes/extras-experiences/unlimited-digital-photos/",
        note: "Price and which rides have photos, from the park itself",
      },
      {
        label: "Photo web app",
        url: "https://www.myfunmoments.com/legoland-ca",
        note: "Sign in with your phone number to view and download photos",
      },
    ],
    apps: [
      {
        name: "LEGOLAND California - Official",
        ios: appStore("legoland-california-official", "452395530"),
        android: playStore("com.merlin.legocal"),
      },
    ],
    social: {
      facebook: "https://www.facebook.com/legolandcalifornia",
      instagram: "https://www.instagram.com/legolandcalifornia/",
      x: "https://x.com/legoland_ca",
      youtube: "https://www.youtube.com/user/legolandcalifornia",
      pinterest: "https://www.pinterest.com/legoland_ca/",
    },
  },

  // accesso on the North American stack (ME-LLNEWYORK).
  legoland_new_york: {
    website: "https://www.legoland.com/new-york/",
    location: {
      address: "LEGOLAND New York Resort, 1 LEGOLAND Way, Goshen, NY",
      postcode: "10924",
      query: "LEGOLAND New York Resort, Goshen, NY 10924",
      directions: "https://www.legoland.com/new-york/plan-your-visit/planning-tools/directions-parking/",
      note: "Leave Route 17 at Exit 125, follow signs to Harriman Drive, then take the second left at the light onto LEGOLAND Way.",
    },
    booking: [
      {
        label: "Book tickets",
        url: "https://www.legoland.com/new-york/tickets-passes/tickets/",
        note: "Day tickets - Buy Now opens the accesso checkout on the page",
      },
      { label: "Season passes", url: "https://www.legoland.com/new-york/tickets-passes/annual-passes/" },
      { label: "Fastrack", url: "https://www.legoland.com/new-york/tickets-passes/extras-experiences/fastrack/" },
      {
        label: "Park reservations",
        url: "https://www.legoland.com/new-york/plan-your-visit/reservations-required/",
        note: "Open-dated and third-party tickets need a reservation for the day - dated tickets and passes don't",
      },
    ],
    orders: [
      {
        label: "Manage my reservation",
        url: "https://www.legoland.com/new-york/plan-your-visit/reservations-required/manage-or-change-reservations/",
        note: "Change or cancel a park reservation",
      },
    ],
    rideAvailability: rideAvailability(
      "https://www.legoland.com/new-york/plan-your-visit/know-before-you-go/seasonal-closures/",
      "Early and seasonal ride closures, from the park itself",
    ),
    openingTimes: openingTimes("https://www.legoland.com/new-york/plan-your-visit/planning-tools/operating-calendar/"),
    access: [
      {
        label: "Special situations and accessibility",
        url: "https://www.legoland.com/new-york/plan-your-visit/know-before-you-go/special-situations-accessibility/",
        note: "Overview, wagon accommodations and ECV rental",
      },
      {
        label: "Resort accessibility",
        url: "https://www.legoland.com/new-york/plan-your-visit/know-before-you-go/special-situations-accessibility/resort-accessibility/",
        note: "Assisted Access Pass, issued at the Guest Experience Center",
      },
      {
        label: "Accessibility guide",
        url: "https://www.legoland.com/new-york/media/o0uhthqm/llny-accessibility-guide-v6-52926.pdf",
        note: "PDF",
      },
    ],
    photos: [
      {
        label: "Unlimited Digital Photos",
        url: "https://www.legoland.com/new-york/tickets-passes/extras-experiences/unlimited-digital-photos/",
        note: "Price and which rides have photos, from the park itself",
      },
      {
        label: "Photo web app",
        url: "https://www.myfunmoments.com/legoland-ny",
        note: "Register with your phone number to view and download photos",
      },
    ],
    apps: [
      {
        name: "LEGOLAND New York Resort",
        ios: appStore("legoland-new-york-resort", "1551664372"),
        android: playStore("biz.merlinentertainments.legoland.newyork"),
      },
    ],
    social: {
      facebook: "https://www.facebook.com/LEGOLANDNewYork/",
      instagram: "https://www.instagram.com/legoland.newyork/",
      x: "https://x.com/legolandnewyork",
      youtube: "https://www.youtube.com/channel/UCXVSSmUxMFqJnH4QTElmhNA",
    },
  },

  // Independent, free admission: rides are paid per ride (ticket books) or
  // with ride-all-day passes. The ticket webstore (Gateway's eGalaxy, at
  // tickets.knoebels.com) sits behind a Cloudflare challenge, so it isn't
  // linked directly; the pricing page links each product into it.
  knoebels: {
    website: "https://knoebels.com/",
    location: {
      address: "Knoebels Amusement Resort, 391 Knoebels Blvd, Route 487, Elysburg, PA",
      postcode: "17824",
      query: "Knoebels Amusement Resort, Elysburg, PA 17824",
      // OpenStreetMap way 297094220 (operator "Knoebels Amusement Resort",
      // fee=no, the largest lot).
      drive: { lat: 40.878479, lon: -76.497366, label: "the main parking lot" },
      directions: "https://knoebels.com/info/plan-your-visit/",
      note: "Admission and parking are free.",
    },
    booking: [
      {
        label: "Pricing",
        url: "https://knoebels.com/info/pricing/",
        note: "Ticket books, ride-all-day passes and add-ons, each linked to the park's webstore",
      },
    ],
    // No order lookup: the park's FAQ sends questions about an online order to
    // an email address.
    orders: [],
    rideAvailability: rideAvailability(
      "https://knoebels.com/rides/",
      "Today's open or closed status for each ride, with height limits and prices",
    ),
    openingTimes: openingTimes("https://knoebels.com/calendar/"),
    access: [
      {
        label: "Accessibility",
        url: "https://knoebels.com/info/accessibility/",
        note: "Ride Accessibility Program - boarding via exit gates, needs an IBCCES Accessibility Card",
      },
      {
        label: "IBCCES Accessibility Card",
        url: "https://www.accessibilitycard.org/",
        note: "Register in advance - only IBCCES issues the card",
      },
    ],
    photos: [
      {
        label: "Season Photo Pass",
        url: "https://knoebels.com/faqs/mobile-app-photo-policy/",
        note: "Bought in the app - every ride photo all season in an online album",
      },
    ],
    apps: [
      {
        name: "Knoebels Amusement Resort",
        ios: appStore("knoebels-amusement-resort", "1612443277"),
        android: playStore("com.knoebels"),
        note: "Also where the Season Photo Pass is bought and photos are collected",
      },
    ],
    social: {
      facebook: "https://www.facebook.com/KnoebelsAmusementResort/",
      instagram: "https://www.instagram.com/knoebels/",
      tiktok: "https://www.tiktok.com/@knoebelsofficial",
      x: "https://x.com/knoebels",
      youtube: "https://www.youtube.com/user/KnoebelsTube",
      linkedin: "https://www.linkedin.com/company/knoebels/",
    },
  },

  // Independent (Looping Group) - VisiSoft webshop at tickets.pleasurewoodhills.com.
  // Ride access goes through Nimbus: a free Pleasurewood Digital Access Pass or a
  // full Access Card unlocks the Ride Access Service and Essential Companion
  // tickets.
  pleasurewood_hills: {
    website: "https://pleasurewoodhills.com/",
    location: {
      address: "Pleasurewood Hills, Leisure Way, Lowestoft, Suffolk",
      postcode: "NR32 5DZ",
      // The park tells drivers to use NR32 4TZ to arrive via Leisure Way;
      // OpenStreetMap also tags the park NR32 4TZ.
      query: "Pleasurewood Hills, NR32 4TZ",
      // OpenStreetMap way 1190421480 (amenity=parking only - no name, operator
      // or fee tags), about 25,000 m2, the largest lot beside the park, which it
      // adjoins to the south. The park's own map pin falls inside the theme-park
      // outline, not the car park.
      drive: { lat: 52.5061678, lon: 1.7434321, label: "the car park" },
      directions: "https://pleasurewoodhills.com/contact-us/",
      note: "Use NR32 4TZ in a sat nav to arrive via Leisure Way. Parking is £3 a car, added to your booking or paid with RingGo (location 71654); free for Premium season pass holders.",
    },
    booking: [
      {
        label: "Book tickets",
        url: "https://tickets.pleasurewoodhills.com/",
        note: "Day tickets, concessions, season passes and extras including car parking",
      },
      {
        label: "Season passes",
        url: "https://pleasurewoodhills.com/season-passes/",
        note: "Standard and Premium - Premium covers every open date and parking",
      },
    ],
    orders: [
      {
        label: "Manage order",
        url: "https://tickets.pleasurewoodhills.com/#manage-order",
        note: "Look up an order with its reference and your last name - no account needed",
      },
    ],
    openingTimes: openingTimes("https://pleasurewoodhills.com/park-info/opening-times/"),
    access: [
      {
        label: "Accessibility",
        url: "https://pleasurewoodhills.com/park-info/accessibility/",
        note: "Ride Access Service and Essential Companion tickets, both through Nimbus",
      },
      {
        label: "Apply via Access Card",
        url: "https://app.accesscard.online/apply/pleasurewood/form/",
        note: "Free Pleasurewood Digital Access Pass, or a £15 Nimbus Access Card",
      },
    ],
    photos: [
      {
        label: "Ride photos",
        url: "https://pleasurewoodhills.com/facilities/",
        note: "Photo booths at Wipeout, Water Fun Factory, Marble Madness and Wavebreaker - card only",
      },
    ],
    apps: [
      {
        name: "Pleasurewood Hills Official",
        ios: appStore("pleasurewood-hills-official", "6758147676"),
        android: playStore("com.pleasurewoodhills.aio"),
        note: "Also holds tickets, season passes and ride photos",
      },
    ],
    social: {
      facebook: "https://www.facebook.com/PleasurewoodHills/",
      instagram: "https://www.instagram.com/pwhills/",
      tiktok: "https://www.tiktok.com/@pwhills",
      youtube: "https://www.youtube.com/@pwhills",
    },
  },

  // Independent - day tickets on ngt.crealy.co.uk, annual passes on a separate
  // store at bookings.crealy.co.uk. Ride access is the Ride Assist Pass, which
  // needs a Nimbus Access Card or a free Crealy Digital Access Pass.
  crealy: {
    website: "https://www.crealy.co.uk/theme-park/",
    location: {
      address: "Crealy Theme Park & Resort, Sidmouth Road, Exeter, Devon",
      postcode: "EX5 1DR",
      query: "Crealy Theme Park, EX5 1DR",
      // No `drive`: the park publishes no car park pin, and OpenStreetMap maps
      // only an overflow lot and a small unnamed one, not the main car park.
      directions: "https://www.crealy.co.uk/theme-park/plan-your-visit/directions/",
      note: "Parking is free.",
    },
    booking: [
      {
        label: "Book tickets",
        url: "https://ngt.crealy.co.uk/untimed/?templateId=49",
        note: "Direct to the date picker on the park's ticketing site",
      },
      { label: "Ticket prices", url: "https://www.crealy.co.uk/theme-park/tickets-prices/" },
      {
        label: "Fast Track Ride Pass",
        url: "https://www.crealy.co.uk/theme-park/plan-your-visit/ride-fast-track-pass/",
        note: "£25, one skip on five named rides plus one of your choice - 20 a day, added when booking",
      },
      {
        label: "Annual passes",
        url: "https://www.crealy.co.uk/annual-passes/",
        note: "Pay in full or monthly by direct debit",
      },
    ],
    // Day tickets have no lookup: the FAQ sends date changes to an email address.
    orders: [
      {
        label: "Annual Pass Portal",
        url: "https://bookings.crealy.co.uk/crealy/account/login",
        note: "Sign in to manage an annual pass",
      },
    ],
    rideAvailability: rideAvailability(
      "https://www.crealy.co.uk/theme-park/rides-attractions/ride-status/",
      "Current closures, winter closures and planned maintenance dates",
    ),
    openingTimes: openingTimes("https://www.crealy.co.uk/theme-park/plan-your-visit/opening-times/"),
    access: [
      {
        label: "Accessibility",
        url: "https://www.crealy.co.uk/info-support/accessibility/",
        note: "Overview, plus ride accessibility restrictions",
      },
      {
        label: "Ride Assist Pass",
        url: "https://www.crealy.co.uk/info-support/accessibility/ride-assist-pass-rap-scheme/",
        note: "Crealy's equivalent of a Ride Access Pass - limited each day, needs a Nimbus Access Card",
      },
      {
        label: "Book a Ride Assist Pass",
        url: "https://ngt.crealy.co.uk/access-pass/",
        note: "Free, booked in advance with your Access Card number",
      },
      {
        label: "Apply via Access Card",
        url: "https://app.accesscard.online/apply/crealy/form/",
        note: "Free Crealy Digital Access Pass, or a £15 Nimbus Access Card",
      },
      {
        label: "Accessibility ticketing",
        url: "https://www.crealy.co.uk/info-support/accessibility/accessibility-ticketing/",
        note: "Essential Companion tickets at 25% off, free registered carer tickets",
      },
    ],
    photos: [
      {
        label: "Unlimited Photo Downloads",
        url: "https://www.crealy.co.uk/theme-park/plan-your-visit/unlimited-photo-downloads/",
        note: "£15, added when booking - collected at the Photo Hub",
      },
    ],
    apps: [
      {
        name: "Crealy Theme Park & Resort",
        ios: appStore("crealy-theme-park-resort", "6786353116"),
        android: playStore("uk.co.crealy.aio"),
        note: "Also sells tickets and annual passes",
      },
    ],
    social: {
      facebook: "https://www.facebook.com/CrealyResort/",
      instagram: "https://www.instagram.com/crealyresort/",
      tiktok: "https://www.tiktok.com/@crealyresort",
      youtube: "https://www.youtube.com/channel/UCPzOIA6SKdj4PwBGHfiPOzg",
    },
  },
  // Independent - accesso store LG-DRAYTONMANOR (merchant 100) at
  // lg-draytonmanor.tickets.draytonmanor.co.uk. The UK SnapWizardAdmission
  // keyword isn't in its catalog, so booking uses the store's own keywords.
  // Ride access is the Easy Access Service, which needs a Nimbus Access Card or
  // a free Drayton Manor Digital Access Pass.
  drayton_manor: {
    website: "https://www.draytonmanor.co.uk/",
    location: {
      // Street address as the car parking terms give it; the find-us page
      // shortens it to "Near Tamworth".
      address: "Drayton Manor Resort, Drayton Manor Drive, Tamworth, Staffordshire",
      postcode: "B78 3TW",
      // The find-us page gives B78 3SA for sat navs.
      query: "Drayton Manor Resort, B78 3SA",
      // OpenStreetMap way 239162713 (amenity=parking, access=customers,
      // parking=surface, no name), about 44,600 m2, by the Main Entrance: the lot
      // the park map labels "Theme Park & Thomas Land Car Park". Coordinate is
      // the polygon centroid.
      drive: { lat: 52.613477, lon: -1.7180551, label: "the Theme Park & Thomas Land car park" },
      directions: "https://www.draytonmanor.co.uk/plan-your-visit/find-us",
      note: "Use B78 3SA in a sat nav. Parking is £9.90 a car added to your booking or £11.90 on the day; free for Gold, Diamond, Platinum and Ultimate annual passholders.",
    },
    booking: [
      {
        label: "Book tickets",
        url: "https://lg-draytonmanor.tickets.draytonmanor.co.uk/packageList/keyword/Tickets",
        note: "Day tickets and seasonal event tickets on the park's ticketing site",
      },
      {
        label: "Ticket prices",
        url: "https://www.draytonmanor.co.uk/day-tickets",
        note: "Dated, Adult & Toddler, Flexi and group tickets",
      },
      {
        label: "Fast Pass",
        url: "https://www.draytonmanor.co.uk/tickets/extras/fast-pass",
        note: "Silver £26.90 (3 rides), Gold £39.90 (5 rides), Platinum £99.99 (unlimited) - entry not included, collected from Guest Services",
      },
      {
        label: "Annual passes",
        url: "https://www.draytonmanor.co.uk/tickets/annual-pass",
        note: "Silver and Gold, paid in full or monthly - Gold includes parking",
      },
      {
        label: "Passholder Hub",
        url: "https://www.draytonmanor.co.uk/tickets/annual-pass/passholder-hub",
        note: "Annual passholders reserve their visit dates here",
      },
    ],
    orders: [findOrder("https://lg-draytonmanor.tickets.draytonmanor.co.uk", "Apple or Google Wallet")],
    rideAvailability: rideAvailability("https://www.draytonmanor.co.uk/ride-availability"),
    // Our hours come from the app's API, not this page.
    openingTimes: {
      label: "Opening times",
      url: "https://www.draytonmanor.co.uk/plan-your-visit/opening-times",
      note: "The park's own calendar",
    },
    access: [
      {
        label: "Accessibility",
        url: "https://www.draytonmanor.co.uk/plan-your-visit/accessibility",
        note: "Easy Access Service (daily ride allowance, not on The Haunting) and Essential Companion tickets, both through Nimbus",
      },
      {
        label: "Apply via Access Card",
        url: "https://app.accesscard.online/apply/drayton-manor/form/",
        note: "Free Drayton Manor Digital Access Pass, or a £15 Nimbus Access Card",
      },
      {
        label: "Access guide",
        url: "https://www.draytonmanor.co.uk/fileadmin/user_upload/drayton_manor/plan-your-visit/accessibility/access-guide-2025.pdf",
        note: "PDF",
      },
      {
        label: "Ride accessibility chart",
        url: "https://www.draytonmanor.co.uk/fileadmin/user_upload/drayton_manor/plan-your-visit/accessibility/accessibility-guide-chart-2025.pdf",
        note: "PDF",
      },
    ],
    photos: [
      {
        label: "Ride photos",
        url: "https://www.draytonmanor.co.uk/tickets/extras/ride-photos",
        note: "Photo Pass: 4 photos, keyrings or magnets plus their digital copies. On Gold Rush, The Wave, Stormforce 10, Accelerator, Jormungandr, Sleipnir, Troublesome Trucks and Sodor Classic Cars",
      },
    ],
    apps: [
      {
        name: "Drayton Manor Resort",
        ios: appStore("drayton-manor-resort", "6793566826"),
        android: playStore("com.accesso.draytonmanor"),
        note: "Live queue times, plus tickets and annual passes in a digital wallet",
      },
    ],
    social: {
      facebook: "https://www.facebook.com/draytonmanor/",
      instagram: "https://www.instagram.com/draytonmanor/",
      tiktok: "https://www.tiktok.com/@drayton_manor",
      x: "https://x.com/draytonmanor",
      youtube: "https://www.youtube.com/@DraytonManorResort",
      linkedin: "https://www.linkedin.com/company/drayton-manor-resort/",
    },
  },
};
