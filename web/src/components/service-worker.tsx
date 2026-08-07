"use client";

import { useEffect } from "react";

/**
 * Registers the service worker at the app's own scope.
 *
 * The scope matters: mounted at renatodap.me/vue-automation, a service worker
 * scoped to "/" would claim every other app on the domain.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const base = process.env.NEXT_PUBLIC_BASE_PATH || "";
    navigator.serviceWorker
      .register(`${base}/sw.js`, { scope: `${base}/` })
      .catch(() => {
        // A failed registration costs offline support, not the app. Nothing
        // useful to tell the user, and a toast about it would be noise.
      });
  }, []);

  return null;
}
