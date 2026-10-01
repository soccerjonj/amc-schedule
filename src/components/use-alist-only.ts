// "A-List only" preference: hide showings AMC marks "Excluded from A-List".
// Saved in this browser's localStorage (like hidden movies / theatre order) since
// it describes the visitor's membership, not a one-off filter.

import { useCallback, useEffect, useState } from "react";

const ALIST_ONLY_KEY = "amc:alistOnly";

export function useAListOnly() {
  const [aListOnly, setState] = useState(false);

  // Load once on the client (avoids an SSR hydration mismatch).
  useEffect(() => setState(window.localStorage.getItem(ALIST_ONLY_KEY) === "1"), []);

  const setAListOnly = useCallback((on: boolean) => {
    setState(on);
    if (on) window.localStorage.setItem(ALIST_ONLY_KEY, "1");
    else window.localStorage.removeItem(ALIST_ONLY_KEY);
  }, []);

  return { aListOnly, setAListOnly };
}
