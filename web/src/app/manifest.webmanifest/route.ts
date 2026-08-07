import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Served from a route rather than public/ so start_url and scope follow
 * NEXT_BASE_PATH instead of being hardcoded.
 *
 * Scope is the reason this matters: mounted at renatodap.me/vue-automation, a
 * bare "/" scope claims the entire domain, and every other app on it opens
 * inside this one.
 */
export async function GET() {
  const base = process.env.NEXT_PUBLIC_BASE_PATH || "";

  return NextResponse.json(
    {
      name: "Vue Lights",
      short_name: "Vue Lights",
      description: "Lighting scenes for the living room",
      start_url: `${base}/`,
      scope: `${base}/`,
      display: "standalone",
      orientation: "portrait",
      background_color: "#14120e",
      // Must match the <meta name="theme-color"> in layout.tsx, or the status
      // bar changes colour between browser and installed app.
      theme_color: "#14120e",
      icons: [
        { src: `${base}/icon-192.png`, sizes: "192x192", type: "image/png", purpose: "any" },
        { src: `${base}/icon-512.png`, sizes: "512x512", type: "image/png", purpose: "any" },
        // Its own file, never "any maskable" on one image — that gets padded
        // and cropped wrong in both roles.
        {
          src: `${base}/icon-512-maskable.png`,
          sizes: "512x512",
          type: "image/png",
          purpose: "maskable",
        },
      ],
    },
    { headers: { "Content-Type": "application/manifest+json" } },
  );
}
