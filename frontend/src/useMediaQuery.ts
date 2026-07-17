import { useEffect, useState } from "react";

/** Reactively track a CSS media query. Used to switch the calendar between the
 *  desktop month grid and the mobile agenda list. */
export function useMediaQuery(query: string): boolean {
  const get = () =>
    typeof window !== "undefined" && window.matchMedia(query).matches;
  const [matches, setMatches] = useState(get);

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
