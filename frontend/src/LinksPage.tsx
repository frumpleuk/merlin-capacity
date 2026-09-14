import { useEffect, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { loadRestrictions, tierSlug, type RestrictionsFile } from "./api";
import { findPark, PARK_HOME, type ParkDef } from "./catalog";
import { PARK_LINKS, PLATFORMS, type AppLink, type ParkLink } from "./links";
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
    <svg className="lk-social-icon" viewBox={glyph.viewBox} aria-hidden="true" focusable="false">
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

/** Copy the https form, for the clients that take a pasted URL. Falls back to
 *  selecting nothing and saying so if the clipboard isn't available (an
 *  insecure origin, or a browser that refuses the permission). */
function CopyUrl({ path }: { path: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  return (
    <button
      className="lk-copy"
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(feedUrl(path));
          setState("done");
        } catch {
          setState("failed");
        }
        setTimeout(() => setState("idle"), 2000);
      }}
      aria-label={`Copy the calendar URL for ${path}`}
    >
      {state === "done" ? "Copied" : state === "failed" ? "Copy failed" : "Copy URL"}
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
      <CopyUrl path={path} />
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
                  className="lk-social"
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

/** Static per-park link directory (tickets, accessibility, apps, socials), plus
 *  the park's calendar feeds.
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

        {links.access.length > 0 && (
          <section className="lk-group">
            <h3>Accessibility</h3>
            {links.access.map((l) => (
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
            <div className="lk-socials">
              {socials.map((s) => (
                <a key={s.key} className="lk-social" href={s.url} {...ext}>
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
