import { useParams } from "react-router-dom";
import { findParkByPath } from "./catalog";

/** The internal key of the park named by the /:country/:slug URL, or undefined
 *  when the URL names no park we list. */
export function useParkKey(): string | undefined {
  const { country, slug } = useParams();
  return findParkByPath(country, slug)?.key;
}
