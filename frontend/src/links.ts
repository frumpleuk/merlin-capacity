// Static per-park link directory powering the Links tab. Everything here is a
// public URL captured by hand (verified live), so — unlike hours/queues/tickets
// — there's no poller, no R2 file and no backend involvement: adding a park's
// links is a data-only edit here.
//
// The Merlin parks share three booking URL shapes off their accesso ticketing
// origin (the same `origin` as src/config.ts), so they're built by helper rather
// than repeated seven times. The independents (Paulton's, Flamingo Land,
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

export interface ParkLinks {
  /** The park's own marketing site. */
  website: string;
  /** Tickets, prebooking and queue-skip products. */
  booking: ParkLink[];
  /** Accessibility: the park's ride-access scheme (RAP and its equivalents). */
  access: ParkLink[];
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

export const PARK_LINKS: Record<string, ParkLinks> = {
  alton_towers: {
    website: "https://www.altontowers.com/",
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
    access: [
      rapInfo(
        "https://www.altontowers.com/plan-your-visit/before-you-visit/accessibility/accessibility-theme-park/ride-access-pass/",
      ),
    ],
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
    booking: [
      bookTickets("https://me-tpr.tickets.thorpepark.com"),
      {
        label: "Passholder prebook",
        url: MAP_PREBOOK,
        note: "Book and manage Merlin Annual Pass trips",
      },
      fastrackPerk("https://me-tpr.tickets.thorpepark.com", "1shot10p"),
    ],
    access: [
      rapInfo(
        "https://www.thorpepark.com/plan-your-visit/before-you-visit/accessibility-information/theme-park-accessibility/ride-access-pass/",
      ),
    ],
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
    booking: [
      bookTickets("https://me-llwindsor.tickets.legoland.co.uk"),
      {
        label: "Passholder prebook",
        url: MAP_PREBOOK,
        note: "Book and manage Merlin Annual Pass trips",
      },
      fastrackPerk("https://me-llwindsor.tickets.legoland.co.uk", "MAPFT10"),
    ],
    access: [
      rapInfo(
        "https://www.legoland.co.uk/plan-your-day/before-you-visit/accessibility/theme-park-accessibility/ride-access-pass/",
      ),
    ],
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
    booking: [
      bookTickets("https://me-wachessington.tickets.chessington.com"),
      {
        label: "Passholder prebook",
        url: MAP_PREBOOK,
        note: "Book and manage Merlin Annual Pass trips",
      },
      fastrackPerk("https://me-wachessington.tickets.chessington.com", "mapft10"),
    ],
    access: [
      rapInfo(
        "https://www.chessington.com/plan-your-visit/before-you-visit/accessibility-guide/theme-park-accessibility/ride-access-pass/",
      ),
    ],
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
    booking: [
      {
        label: "Book tickets",
        url: "https://paultonspark.co.uk/tickets/",
        note: "Day tickets, annual passes and add-ons",
      },
    ],
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
    access: [
      {
        label: "Accessibility guide",
        url: "https://www.flamingoland.co.uk/plan-your-visit/accessibility-guide/",
        note: "Access provision and ride restrictions",
      },
    ],
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
