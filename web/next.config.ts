import type { NextConfig } from "next";

// Set when the app is mounted under a path prefix (renatodap.me/vue-automation)
// instead of owning a domain root. Unset once it gets its own domain.
// See Persimmon infra README.md "Path-mounted Next.js apps".
const basePath = process.env.NEXT_BASE_PATH || undefined;

const nextConfig: NextConfig = {
  ...(basePath ? { basePath } : {}),
  // Next only auto-prepends basePath to its own router/Link/asset internals.
  // Raw fetch("/api/...") in client components, the service worker scope, and
  // the manifest all need it themselves — derive one client-visible copy from
  // the single source of truth rather than syncing a second env var by hand.
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath || "",
  },
  // The HA proxy holds a request open while Home Assistant answers over the
  // tailnet. A cold HA (or a sleeping Pi) can take a few seconds; don't let
  // Next kill the route before the client's own timeout fires.
  experimental: {
    proxyTimeout: 30_000,
  },
};

export default nextConfig;
