import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { PARKS, type ParkDef } from "./catalog";

type GroupBy = "country" | "operator";

const INDEPENDENT = "Independent";
const RECENT_KEY = "parkPicker.recent";
const GROUP_KEY = "parkPicker.groupBy";
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
function loadRecent(): string[] {
  try {
    const v = JSON.parse(load(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((k) => typeof k === "string") : [];
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
      s = { key, label: by === "country" ? countryName(key) : key, entries: [] };
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
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [active, setActive] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
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
  const recentParks =
    words.length === 0
      ? recent
          .filter((k) => k !== current.key)
          .slice(0, RECENT_MAX)
          .map((k) => PARKS.find((p) => p.key === k)!)
          .filter(Boolean)
      : [];

  // Options in display order, for the arrow keys. Recent parks appear twice
  // (in Recent and in their section), so each option gets its own id.
  const options: { id: string; park: ParkDef }[] = [
    ...recentParks.map((p) => ({ id: `${uid}-recent-${p.key}`, park: p })),
    ...sections.flatMap((s) =>
      s.entries.flatMap((e) =>
        e.parks.map((p) => ({ id: `${uid}-${s.key}-${p.key}`, park: p })),
      ),
    ),
  ];
  const indexOf = new Map(options.map((o, i) => [o.id, i]));

  // Start on the current park, or on the first match once a query is typed.
  useEffect(() => {
    if (!open) return;
    const i = words.length
      ? 0
      : options.findIndex((o) => o.park.key === current.key && !o.id.includes("-recent-"));
    setActive(Math.max(0, i));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, groupBy]);

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
      setActive((i) => (i + step + options.length) % options.length);
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
    save(GROUP_KEY, by);
  };

  const option = (id: string, p: ParkDef) => {
    const i = indexOf.get(id) ?? -1;
    return (
      <Link
        key={id}
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
        onMouseMove={() => i !== active && setActive(i)}
        onClick={() => setOpen(false)}
      >
        {p.label}
      </Link>
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
        if (open && !rootRef.current?.contains(e.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className="pp-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => {
          setQuery("");
          setOpen((o) => !o);
        }}
      >
        <span className="pp-name">{current.label}</span>
        <span className="pp-where">{where}</span>
        <svg className="pp-caret" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      </button>
      {open && (
        <div id={panelId} className="pp-panel" role="dialog" aria-label="Choose a park">
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
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="pp-groupby" role="group" aria-label="Group parks by">
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
          <div className="pp-list" id={listId} role="listbox" ref={listRef} aria-label="Parks">
            {recentParks.length > 0 && (
              <div role="group" aria-labelledby={`${uid}-h-recent`}>
                <div className="pp-heading" id={`${uid}-h-recent`}>Recent</div>
                {recentParks.map((p) => option(`${uid}-recent-${p.key}`, p))}
              </div>
            )}
            {sections.map((s) => (
              <div key={s.key} role="group" aria-labelledby={`${uid}-h-${s.key}`}>
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
                      {e.parks.map((p) => option(`${uid}-${s.key}-${p.key}`, p))}
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
  );
}
