// The visitor's preferred theatre order, saved in this browser's localStorage.
// Like the hidden-movies list it persists across visits on this device and never
// leaves it (no account). An empty list means "use the default order".

import { useCallback, useEffect, useState } from "react";

const THEATRE_ORDER_KEY = "amc:theatreOrder";

function loadOrder(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = JSON.parse(window.localStorage.getItem(THEATRE_ORDER_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

export function useTheatreOrder() {
  const [order, setOrderState] = useState<string[]>([]);

  // Load once on the client (avoids an SSR hydration mismatch).
  useEffect(() => setOrderState(loadOrder()), []);

  const setOrder = useCallback((next: string[]) => {
    setOrderState(next);
    window.localStorage.setItem(THEATRE_ORDER_KEY, JSON.stringify(next));
  }, []);

  const resetOrder = useCallback(() => {
    setOrderState([]);
    window.localStorage.removeItem(THEATRE_ORDER_KEY);
  }, []);

  return { order, setOrder, resetOrder };
}
