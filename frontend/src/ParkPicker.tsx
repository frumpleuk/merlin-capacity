import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { PARKS, type ParkDef } from "./catalog";
import { useMediaQuery } from "./useMediaQuery";

type GroupBy = "country" | "operator";

const INDEPENDENT = "Independent";
const RECENT_KEY = "parkPicker.recent";
const GROUP_KEY = "parkPicker.groupBy";
const PIN_KEY = "parkPicker.pinned";
const RECENT_MAX = 4;

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

export function countryName(code: string): string {
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

// Browser storage only remembers the viewer's own conveniences (recent parks,
// grouping). It can be missing or throw in a private window, so every access
// is guarded and the picker works without it.
function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}
/** A stored list of park keys, dropping any park no longer in the catalog. */
function loadKeys(key: string): string[] {
  try {
    const v = JSON.parse(load(key) ?? "[]");
    return Array.isArray(v)
      ? v.filter((k) => PARKS.some((p) => p.key === k))
      : [];
  } catch {
    return [];
  }
}

/** Lower case with accents stripped, so "liseberg" finds "Liséberg". */
const fold = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const operatorOf = (p: ParkDef) => p.operator ?? INDEPENDENT;

/** Every word of the query must appear in the park's name, resort, country or
 *  operator, so "paris" finds both Disney parks and "uk merlin" the four. */
function matches(p: ParkDef, words: string[]): boolean {
  const hay = fold(
    [p.label, p.resort, countryName(p.country), p.country, operatorOf(p)]
      .filter(Boolean)
      .join(" "),
  );
  return words.every((w) => hay.includes(w));
}

interface Entry {
  resort?: string;
  parks: ParkDef[];
}
interface Section {
  key: string;
  label: string;
  entries: Entry[];
}

/** Sections in catalog order (the UK first), parks of one resort nested under
 *  it. Independents go last when grouping by operator. */
function group(parks: ParkDef[], by: GroupBy): Section[] {
  const sections = new Map<string, Section>();
  for (const p of parks) {
    const key = by === "country" ? p.country : operatorOf(p);
    let s = sections.get(key);
    if (!s) {
      s = {
        key,
        label: by === "country" ? countryName(key) : key,
        entries: [],
      };
      sections.set(key, s);
    }
    const resort = p.resort && s.entries.find((e) => e.resort === p.resort);
    if (resort) resort.parks.push(p);
    else s.entries.push({ resort: p.resort, parks: [p] });
  }
  const out = [...sections.values()];
  if (by === "operator") {
    out.sort((a, b) => +(a.key === INDEPENDENT) - +(b.key === INDEPENDENT));
  }
  return out;
}

export function ParkPicker({
  current,
  hrefFor,
}: {
  current: ParkDef;
  /** Where choosing a park goes: the same page at that park, when it has one. */
  hrefFor: (p: ParkDef) => string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [groupBy, setGroupBy] = useState<GroupBy>(() =>
    load(GROUP_KEY) === "operator" ? "operator" : "country",
  );
  const [recent, setRecent] = useState<string[]>(() => loadKeys(RECENT_KEY));
  const [pinned, setPinned] = useState<string[]>(() => loadKeys(PIN_KEY));
  // The pins the row and the Pinned section are drawn from. Held while the
  // panel is open, so pinning fills the icon without moving rows under the
  // pointer; the layout catches up when the panel closes.
  const [layoutPins, setLayoutPins] = useState(pinned);
  // The highlighted option; null until the arrows or mouse pick one.
  const [picked, setPicked] = useState<number | null>(null);
  // Desktop has room for the pinned (or else recent) parks as links, with the
  // full list behind "More parks"; a phone gets the current park as the one
  // button.
  const wide = useMediaQuery("(min-width: 820px)");

  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const uid = useId();
  const panelId = `${uid}-panel`;
  const listId = `${uid}-list`;

  // Remember the park being viewed, most recent first.
  useEffect(() => {
    setRecent((prev) => {
      const next = [current.key, ...prev.filter((k) => k !== current.key)]
        .filter((k) => PARKS.some((p) => p.key === k))
        .slice(0, RECENT_MAX + 1);
      save(RECENT_KEY, JSON.stringify(next));
      return next;
    });
  }, [current.key]);

  // The panel hangs from its button's left edge; "More parks" can sit far
  // enough right for that to run off the window, so pull it back in.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const button = buttonRef.current;
    if (!open || !panel || !button) return;
    panel.style.left = "0px";
    const gutter = 16;
    const over =
      button.getBoundingClientRect().left +
      panel.offsetWidth -
      (window.innerWidth - gutter);
    if (over > 0) panel.style.left = `${-over}px`;
  }, [open, wide]);

  useEffect(() => {
    if (!open) setLayoutPins(pinned);
  }, [open, pinned]);

  // Choosing a park changes the route; close on any navigation.
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    // A phone keyboard popping up over a short list is more hindrance than
    // help, so the search box takes focus only with a mouse or trackpad.
    if (window.matchMedia("(pointer: fine)").matches) inputRef.current?.focus();
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const words = fold(query).split(/\s+/).filter(Boolean);
  const filtered = useMemo(
    () => PARKS.filter((p) => matches(p, words)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query],
  );
  const sections = useMemo(() => group(filtered, groupBy), [filtered, groupBy]);
  const togglePin = (key: string) =>
    setPinned((prev) => {
      const next = prev.includes(key)
        ? prev.filter((k) => k !== key)
        : [...prev, key];
      save(PIN_KEY, JSON.stringify(next));
      return next;
    });

  // Pinned and recent parks head the list until a query is typed. Pinned
  // parks show in catalog order; recent ones leave out what's pinned, and on
  // desktop are left out altogether, as the row above already shows them.
  const pinnedParks =
    words.length === 0 ? PARKS.filter((p) => layoutPins.includes(p.key)) : [];
  const recentParks =
    !wide && words.length === 0
      ? recent
          .filter((k) => k !== current.key && !layoutPins.includes(k))
          .slice(0, RECENT_MAX)
          .map((k) => PARKS.find((p) => p.key === k)!)
          .filter(Boolean)
      : [];

  // The desktop row. With parks pinned: those and the current park. Without:
  // the current park and the last few viewed, topped up from the catalog for a
  // new visitor. Either way in catalog order, so links don't swap places on
  // every switch.
  const rowParks = (() => {
    if (layoutPins.length) {
      return PARKS.filter(
        (p) => layoutPins.includes(p.key) || p.key === current.key,
      );
    }
    const keys = new Set([current.key, ...recent].slice(0, RECENT_MAX + 1));
    for (const p of PARKS) {
      if (keys.size > RECENT_MAX) break;
      keys.add(p.key);
    }
    return PARKS.filter((p) => keys.has(p.key));
  })();

  // Options in display order, for the arrow keys. A pinned or recent park
  // appears twice (up top and in its section), so each option gets its own id;
  // `listed` marks the copy in its section.
  const options: { id: string; park: ParkDef; listed?: boolean }[] = [
    ...pinnedParks.map((p) => ({ id: `${uid}-pinned-${p.key}`, park: p })),
    ...recentParks.map((p) => ({ id: `${uid}-recent-${p.key}`, park: p })),
    ...sections.flatMap((s) =>
      s.entries.flatMap((e) =>
        e.parks.map((p) => ({
          id: `${uid}-${s.key}-${p.key}`,
          park: p,
          listed: true,
        })),
      ),
    ),
  ];
  const indexOf = new Map(options.map((o, i) => [o.id, i]));

  // Until one is picked, highlight the current park, or the first match once
  // a query is typed. Worked out in render, not an effect, so an Enter typed
  // straight after a keystroke never meets a stale index.
  const fallback = words.length
    ? 0
    : Math.max(
        0,
        options.findIndex((o) => o.park.key === current.key && o.listed),
      );
  const active = Math.min(picked ?? fallback, options.length - 1);

  const activeId = options[active]?.id;
  useEffect(() => {
    if (open && activeId) {
      document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
    }
  }, [open, activeId]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!options.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setPicked((active + step + options.length) % options.length);
    } else if (e.key === "Enter" && e.target === inputRef.current) {
      const o = options[active];
      if (o) {
        e.preventDefault();
        setOpen(false);
        navigate(hrefFor(o.park));
      }
    }
  };

  const changeGroup = (by: GroupBy) => {
    setGroupBy(by);
    setPicked(null);
    save(GROUP_KEY, by);
  };

  const option = (id: string, p: ParkDef) => {
    const i = indexOf.get(id) ?? -1;
    const isPinned = pinned.includes(p.key);
    return (
      <div key={id} className={"pp-item" + (i === active ? " active" : "")}>
        <Link
          id={id}
          role="option"
          aria-selected={i === active}
          aria-current={p.key === current.key ? "page" : undefined}
          to={hrefFor(p)}
          className={
            "pp-option" +
            (i === active ? " active" : "") +
            (p.key === current.key ? " current" : "")
          }
          onMouseMove={() => i !== active && setPicked(i)}
          onClick={() => setOpen(false)}
        >
          {p.label}
        </Link>
        <button
          type="button"
          className={"pp-pin" + (isPinned ? " on" : "")}
          aria-pressed={isPinned}
          aria-label={`${isPinned ? "Unpin" : "Pin"} ${p.label}`}
          title={isPinned ? "Unpin" : "Pin to the top"}
          onClick={() => togglePin(p.key)}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M10.5 1.5 14.5 5.5 12 6.5 9.5 9 10 12.5 8.5 14 5.5 11 2 14.5 1.5 14 5 10.5 2 7.5 3.5 6 7 6.5 9.5 4Z"
              fill={isPinned ? "currentColor" : "none"}
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    );
  };

  const where = current.resort ?? countryName(current.country);

  return (
    <div
      className="park-picker"
      ref={rootRef}
      onKeyDown={open ? onKeyDown : undefined}
      onBlur={(e) => {
        // Tabbing out of the panel closes it, as a click outside does.
        if (
          open &&
          !rootRef.current?.contains(e.relatedTarget as Node | null)
        ) {
          setOpen(false);
        }
      }}
    >
      {wide && (
        <nav
          className="pp-row"
          aria-label={layoutPins.length ? "Pinned parks" : "Recent parks"}
        >
          {rowParks.map((p) => (
            <Link
              key={p.key}
              to={hrefFor(p)}
              aria-current={p.key === current.key ? "page" : undefined}
              className={"park-link" + (p.key === current.key ? " active" : "")}
            >
              {p.label}
            </Link>
          ))}
        </nav>
      )}
      <div className="pp-anchor">
        <button
          ref={buttonRef}
          type="button"
          className={wide ? "pp-more" : "pp-button"}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => {
            setQuery("");
            setPicked(null);
            setOpen((o) => !o);
          }}
        >
          {wide ? (
            "More parks"
          ) : (
            <>
              <span className="pp-name">{current.label}</span>
              <span className="pp-where">{where}</span>
            </>
          )}
          <svg
            className="pp-caret"
            width="12"
            height="12"
            viewBox="0 0 12 12"
            aria-hidden="true"
          >
            <path
              d="M2.5 4.5 6 8l3.5-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
            />
          </svg>
        </button>
        {open && (
          <div
            ref={panelRef}
            id={panelId}
            className="pp-panel"
            role="dialog"
            aria-label="Choose a park"
          >
            <div className="pp-top">
              <input
                ref={inputRef}
                type="search"
                className="pp-search"
                role="combobox"
                aria-expanded="true"
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={options[active]?.id}
                aria-label="Search parks"
                placeholder={`Search ${PARKS.length} parks`}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPicked(null);
                }}
              />
              <div
                className="pp-groupby"
                role="group"
                aria-label="Group parks by"
              >
                {(["country", "operator"] as const).map((by) => (
                  <button
                    key={by}
                    type="button"
                    aria-pressed={groupBy === by}
                    className={groupBy === by ? "on" : ""}
                    onClick={() => changeGroup(by)}
                  >
                    {by === "country" ? "Country" : "Operator"}
                  </button>
                ))}
              </div>
            </div>
            <div
              className="pp-list"
              id={listId}
              role="listbox"
              ref={listRef}
              aria-label="Parks"
            >
              {pinnedParks.length > 0 && (
                <div role="group" aria-labelledby={`${uid}-h-pinned`}>
                  <div className="pp-heading" id={`${uid}-h-pinned`}>
                    Pinned
                  </div>
                  {pinnedParks.map((p) => option(`${uid}-pinned-${p.key}`, p))}
                </div>
              )}
              {recentParks.length > 0 && (
                <div role="group" aria-labelledby={`${uid}-h-recent`}>
                  <div className="pp-heading" id={`${uid}-h-recent`}>
                    Recent
                  </div>
                  {recentParks.map((p) => option(`${uid}-recent-${p.key}`, p))}
                </div>
              )}
              {sections.map((s) => (
                <div
                  key={s.key}
                  role="group"
                  aria-labelledby={`${uid}-h-${s.key}`}
                >
                  <div className="pp-heading" id={`${uid}-h-${s.key}`}>
                    {s.label}
                  </div>
                  {s.entries.map((e) =>
                    e.resort ? (
                      <div
                        key={e.resort}
                        className="pp-resort"
                        role="group"
                        aria-label={e.resort}
                      >
                        <div className="pp-resort-name" aria-hidden="true">
                          {e.resort}
                        </div>
                        {e.parks.map((p) =>
                          option(`${uid}-${s.key}-${p.key}`, p),
                        )}
                      </div>
                    ) : (
                      option(`${uid}-${s.key}-${e.parks[0].key}`, e.parks[0])
                    ),
                  )}
                </div>
              ))}
              {options.length === 0 && (
                <div className="pp-empty">No park matches "{query}"</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
