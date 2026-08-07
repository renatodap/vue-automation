"use client";

import { useState } from "react";
import { apiUrl, postJson } from "@/lib/client";

export default function LoginPage() {
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await postJson("/api/login", { passphrase });
      // A full navigation, not a router push: the session cookie has to be
      // attached to the next document request for middleware to see it.
      window.location.href = apiUrl("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <header />
      <main className="flex flex-col justify-center">
        <div className="mb-7">
          <h1 className="text-[28px] font-semibold tracking-tight m-0">Vue Lights</h1>
          <p className="text-[14px] text-[var(--text-muted)] m-0 mt-1">
            Living room lighting
          </p>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-3">
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="Passphrase"
            autoComplete="current-password"
            // No autoFocus: it opens the keyboard before the user has decided
            // to type, and on iOS that shoves the layout around on arrival.
            aria-label="Passphrase"
            aria-invalid={error !== null}
          />
          <button
            type="submit"
            disabled={busy || passphrase.length === 0}
            className="rounded-[var(--r-md)] font-medium text-[15px] transition-opacity disabled:opacity-40"
            style={{
              minHeight: 48,
              background: "var(--accent)",
              color: "var(--text-on-accent)",
            }}
          >
            {busy ? "Checking…" : "Unlock"}
          </button>
          {error && (
            <p className="text-[13px] m-0" style={{ color: "var(--negative)" }} role="alert">
              {error}
            </p>
          )}
        </form>
      </main>
      <footer>
        <span className="text-[12px] text-[var(--text-muted)]">
          One passphrase, no accounts.
        </span>
      </footer>
    </div>
  );
}
