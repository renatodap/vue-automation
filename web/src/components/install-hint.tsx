"use client";

import { useEffect, useState } from "react";
import { Share, X } from "lucide-react";

const DISMISSED_KEY = "vue-install-hint-dismissed";

/**
 * iOS never fires `beforeinstallprompt` and shows no install affordance, so
 * the only way onto the home screen is a human knowing to tap Share → Add to
 * Home Screen. On a phone-first app that hint is part of the build.
 *
 * Shown only when not already installed, and only once.
 */
export function InstallHint() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const standalone = window.matchMedia("(display-mode: standalone)").matches;
    // iOS Safari exposes its own non-standard flag for the installed case.
    const iosStandalone =
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    if (standalone || iosStandalone) return;

    const isIos = /iphone|ipad|ipod/i.test(window.navigator.userAgent);
    if (!isIos) return;

    try {
      if (localStorage.getItem(DISMISSED_KEY)) return;
    } catch {
      // Private mode denies localStorage. Showing the hint again is a far
      // smaller cost than crashing the page over it.
    }
    setVisible(true);
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    setVisible(false);
    try {
      localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // Storage is evictable and sometimes unavailable — nothing depends on it.
    }
  };

  return (
    <div
      className="fixed left-0 right-0 flex items-center gap-2.5 mx-auto text-[13px]"
      style={{
        // Clears the tab bar, which is taller than the single line of text this
        // row used to hold. Same max() fallback as the footer itself: the raw
        // inset is 0px on a device without one.
        bottom: `calc(max(14px, env(safe-area-inset-bottom)) + 66px)`,
        maxWidth: "min(560px, calc(100vw - 32px))",
        background: "var(--elevated)",
        border: "1px solid var(--border-strong)",
        borderRadius: "var(--r-md)",
        boxShadow: "var(--shadow-lg)",
        padding: "10px 12px",
      }}
    >
      <Share size={16} className="shrink-0 text-[var(--accent)]" />
      <span className="flex-1 text-[var(--text-secondary)]">
        Add to your home screen: <strong className="text-[var(--text-primary)]">Share</strong>{" "}
        → Add to Home Screen
      </span>
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        className="shrink-0 text-[var(--text-muted)]"
        style={{ minWidth: 32, minHeight: 32 }}
      >
        <X size={15} />
      </button>
    </div>
  );
}
