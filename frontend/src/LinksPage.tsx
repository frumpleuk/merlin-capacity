import { useEffect, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { loadRestrictions, tierSlug, type RestrictionsFile } from "./api";
import { findPark, PARK_HOME, type ParkDef } from "./catalog";
import {
  mapLinks,
  PARK_LINKS,
  PLATFORMS,
  type AppLink,
  type ParkLink,
  type ParkLocation,
} from "./links";
import { SOCIAL_GLYPHS } from "./socialIcons";

/** Everything on this page leaves the site, so every anchor opens in a new tab
 *  (and drops the opener reference). */
const ext = { target: "_blank", rel: "noreferrer noopener" } as const;

/** Arrow-out-of-box, the usual "this opens elsewhere" mark. Decorative — the
 *  anchor's own text is the label. */
function ExtIcon() {
  return (
    <svg
      className="lk-ext"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M7 3.75H3.75v8.5h8.5V9" />
      <path d="M9.75 3.75h2.5v2.5M12.25 3.75 7.5 8.5" />
    </svg>
  );
}

function LinkRow({ link }: { link: ParkLink }) {
  return (
    <a className="lk-link" href={link.url} {...ext}>
      <span className="lk-label">
        <span className="lk-text">{link.label}</span>
        <ExtIcon />
      </span>
      {link.note && <span className="lk-note">{link.note}</span>}
    </a>
  );
}

function AppRow({ app }: { app: AppLink }) {
  return (
    <div className="lk-app">
      <span className="lk-label">{app.name}</span>
      {app.note && <span className="lk-note">{app.note}</span>}
      {/* Official store badges (Apple's and Google's own artwork, unmodified,
          served from /badges). Apple ships a black and a white variant, so
          <picture> swaps them by colour scheme; Google's single badge is
          designed to work on both. Alt text is the wording each store's
          guidelines require. */}
      <span className="lk-badges">
        {app.ios && (
          <a href={app.ios} {...ext}>
            <picture>
              <source srcSet="/badges/app-store-white.svg" media="(prefers-color-scheme: dark)" />
              <img
                className="lk-badge-apple"
                src="/badges/app-store-black.svg"
                alt={`Download ${app.name} on the App Store`}
              />
            </picture>
          </a>
        )}
        {app.android && (
          <a href={app.android} {...ext}>
            <img
              className="lk-badge-google"
              src="/badges/google-play.png"
              alt={`Get ${app.name} on Google Play`}
            />
          </a>
        )}
      </span>
    </div>
  );
}

/** Brand glyph, drawn at the current text colour so one copy serves both
 *  themes. Decorative: the pill's own text is the accessible label. */
function SocialIcon({ platform }: { platform: string }) {
  const glyph = SOCIAL_GLYPHS[platform];
  if (!glyph) return null;
  return (
    <svg className="lk-chip-icon" viewBox={glyph.viewBox} aria-hidden="true" focusable="false">
      <path d={glyph.path} fill="currentColor" />
    </svg>
  );
}

/* ── Calendar subscriptions ────────────────────────────────────────────────────
 *
 * The only links on this page that don't leave the site: our own iCal feeds (see
 * src/ical.ts). Built from the current host rather than a configured origin, so
 * they're right in local dev and behind any domain the Worker is served on. */

const feedUrl = (path: string) => `${window.location.origin}${path}`;
/** Apple Calendar, Outlook and most desktop clients subscribe on this scheme;
 *  Google Calendar wants the https URL pasted, which is why both are offered. */
const webcalUrl = (path: string) => `webcal://${window.location.host}${path}`;

/** Copy a string to the clipboard — the https form of a feed, or a postcode.
 *  Falls back to saying so if the clipboard isn't available (an insecure
 *  origin, or a browser that refuses the permission). */
function CopyButton({
  value,
  aria,
  idle = "Copy",
}: {
  value: string;
  aria: string;
  idle?: string;
}) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  return (
    <button
      className="lk-copy"
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setState("done");
        } catch {
          setState("failed");
        }
        setTimeout(() => setState("idle"), 2000);
      }}
      aria-label={aria}
    >
      {state === "done" ? "Copied" : state === "failed" ? "Copy failed" : idle}
    </button>
  );
}

function FeedRow({ label, note, path }: { label: string; note?: string; path: string }) {
  return (
    <div className="lk-feed">
      <a className="lk-link lk-feed-sub" href={webcalUrl(path)}>
        <span className="lk-label">
          <span className="lk-text">{label}</span>
        </span>
        {note && <span className="lk-note">{note}</span>}
      </a>
      <CopyButton
        value={feedUrl(path)}
        aria={`Copy the calendar URL for ${path}`}
        idle="Copy URL"
      />
    </div>
  );
}

/** The park's own calendar feed, plus — on a Merlin park — one feed per pass
 *  level. The levels come from the served restriction file rather than a list
 *  here, because they rotate (see src/restrictions.ts). */
function CalendarGroup({ parkDef }: { parkDef: ParkDef }) {
  const [restrictions, setRestrictions] = useState<RestrictionsFile | null>(null);
  useEffect(() => {
    if (!parkDef.merlinPass) return;
    let alive = true;
    loadRestrictions().then((f) => alive && setRestrictions(f));
    return () => {
      alive = false;
    };
  }, [parkDef]);

  return (
    <section className="lk-group lk-group-wide">
      <h3>Calendar subscription</h3>
      <FeedRow
        label={`${parkDef.label} calendar`}
        note="Opening hours, special events and private-event days, kept up to date"
        path={`/ical/${parkDef.key}.ics`}
      />
      {parkDef.merlinPass && (
        <>
          <FeedRow
            label="Pass restrictions — all levels"
            note="Every Merlin Annual Pass exclusion date, labelled with the levels it applies to"
            path="/ical/pass/all.ics"
          />
          {restrictions && (
            <div className="lk-feed-tiers">
              <span className="lk-note">Or just your own level:</span>
              {restrictions.tiers.map((t) => (
                <a
                  key={t.name}
                  className="lk-chip"
                  href={webcalUrl(`/ical/pass/${tierSlug(t.name)}.ics`)}
                >
                  {t.name}
                </a>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/* ── Getting there ────────────────────────────────────────────────────────────
 *
 * Three deep links and a postcode. The links carry the car park's coordinate
 * where the park publishes one, which routes better than the park's own POI —
 * see ParkLocation.drive in links.ts. */

/** Map pin, one glyph for all three apps. Their logos are trademarked artwork
 *  with their own usage rules, and nothing here needs them: the chip says which
 *  app it opens. */
function PinIcon() {
  return (
    <svg
      className="lk-chip-icon"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8 14.5s5-4.35 5-8a5 5 0 0 0-10 0c0 3.65 5 8 5 8Z" />
      <circle cx="8" cy="6.5" r="1.9" />
    </svg>
  );
}

function GettingThereGroup({ location }: { location: ParkLocation }) {
  return (
    <section className="lk-group">
      <h3>Getting there</h3>
      <div className="lk-place">
        <span className="lk-label">{location.address}</span>
        <span className="lk-postcode">
          {location.postcode}
          <CopyButton
            value={location.postcode}
            aria={`Copy the postcode ${location.postcode}`}
          />
        </span>
        {location.note && <span className="lk-note">{location.note}</span>}
        <div className="lk-chips">
          {mapLinks(location).map((m) => (
            <a key={m.name} className="lk-chip" href={m.url} {...ext}>
              <PinIcon />
              {m.name}
            </a>
          ))}
        </div>
        {location.drive && (
          <span className="lk-note">
            Routes to {location.drive.label} — {location.drive.lat},{" "}
            {location.drive.lon}
          </span>
        )}
      </div>
      <LinkRow
        link={{
          label: "Directions & parking",
          url: location.directions,
          note: "By car, train and bus, from the park itself",
        }}
      />
    </section>
  );
}

/** Static per-park link directory (tickets, finding an order you've already
 *  placed, getting there, accessibility, ride photos, apps, socials), plus the park's
 *  calendar feeds.
 *  The groups lay out as columns on a wide screen and stack on a narrow one;
 *  Social spans the full width so its pills get a full row before wrapping. */
export function LinksPage() {
  const { park } = useParams();
  const parkDef = findPark(park);
  if (!parkDef) return <Navigate to={PARK_HOME} replace />;

  const links = PARK_LINKS[parkDef.key];
  if (!links)
    return (
      <main>
        <p className="empty">No links for this park yet.</p>
      </main>
    );

  const socials = PLATFORMS.flatMap((p) => {
    const url = links.social[p.key];
    return url ? [{ ...p, url }] : [];
  });

  return (
    <main className="lk-main">
      <div className="lk-groups">
        <section className="lk-group">
          <h3>Tickets &amp; booking</h3>
          <LinkRow link={{ label: "Official website", url: links.website }} />
          {links.booking.map((l) => (
            <LinkRow key={l.url + l.label} link={l} />
          ))}
        </section>

        {links.orders.length > 0 && (
          <section className="lk-group">
            <h3>Already booked?</h3>
            {links.orders.map((l) => (
              <LinkRow key={l.url + l.label} link={l} />
            ))}
          </section>
        )}

        <section className="lk-group">
          <h3>What&apos;s open</h3>
          <LinkRow link={links.rideAvailability} />
          {links.liftAvailability && <LinkRow link={links.liftAvailability} />}
          <LinkRow link={links.openingTimes} />
        </section>

        <GettingThereGroup location={links.location} />

        {links.access.length > 0 && (
          <section className="lk-group">
            <h3>Accessibility</h3>
            {links.access.map((l) => (
              <LinkRow key={l.url + l.label} link={l} />
            ))}
          </section>
        )}

        {links.photos.length > 0 && (
          <section className="lk-group">
            <h3>Ride photos</h3>
            {links.photos.map((l) => (
              <LinkRow key={l.url + l.label} link={l} />
            ))}
          </section>
        )}

        {links.apps.length > 0 && (
          <section className="lk-group">
            <h3>Apps</h3>
            {links.apps.map((a) => (
              <AppRow key={a.name} app={a} />
            ))}
          </section>
        )}

        <CalendarGroup parkDef={parkDef} />

        {socials.length > 0 && (
          <section className="lk-group lk-group-wide">
            <h3>Social</h3>
            <div className="lk-chips">
              {socials.map((s) => (
                <a key={s.key} className="lk-chip" href={s.url} {...ext}>
                  <SocialIcon platform={s.key} />
                  {s.label}
                </a>
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
