"use client";

import { RefreshCw, Undo2, X } from "lucide-react";
import { HouseProvider, summarize, useHouse } from "./house";
import { InstallHint } from "./install-hint";
import { TabBar } from "./tab-bar";

/**
 * The app shell: three grid rows, one scroller, on every tab.
 *
 *   header   auto   title + what the room is doing
 *   main     1fr    the only scrolling element in the document
 *   footer   auto   the tab bar
 *
 * Adding tabs did not change the shape of this. The bottom nav is the third row
 * the grid always had — it is not fixed, it is not an overlay, and it cannot
 * drift, because the grid IS the viewport. Height is 100dvh, never 100vh: vh
 * resolves against the LARGEST viewport, so on load with the browser toolbars
 * visible the nav would sit below the fold.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <HouseProvider>
      <Shell>{children}</Shell>
    </HouseProvider>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { state, lamps, notice, undo, revert, dismissUndo, load } = useHouse();

  return (
    <div className="app">
      <header className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[25px] font-semibold tracking-tight m-0">Home</h1>
          <p className="text-[13px] text-[var(--text-muted)] m-0 mt-0.5 truncate">
            {state === null ? "Connecting…" : state.ok ? summarize(lamps) : "Disconnected"}
          </p>
        </div>
        <button
          onClick={() => void load()}
          aria-label="Refresh"
          className="text-[var(--text-muted)] active:scale-90 transition-transform shrink-0"
          style={{ minWidth: 44 }}
        >
          <RefreshCw size={17} />
        </button>
      </header>

      <main>{children}</main>

      <footer>
        {/* The notice used to be the footer's only content; the tab bar lives
            there now, so these float just above it. Absolutely positioned
            against the footer ROW — not fixed to the viewport — so they ride
            with the shell instead of being moved independently by iOS, and so
            their appearance never reflows the layout under the user's thumb. */}
        <div className="floats">
          {notice && (
            <div className="notice" role="status" aria-live="polite">
              {notice}
            </div>
          )}
          {undo && (
            <div className="undo">
              <button onClick={() => void revert()} className="undo-action">
                <Undo2 size={14} aria-hidden />
                Undo {undo.label}
              </button>
              <button onClick={dismissUndo} aria-label="Dismiss undo" className="undo-dismiss">
                <X size={13} />
              </button>
            </div>
          )}
        </div>
        <TabBar />
      </footer>

      <InstallHint />
    </div>
  );
}
