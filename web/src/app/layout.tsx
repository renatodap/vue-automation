import type { Metadata, Viewport } from "next";
import "./globals.css";
import { basePath } from "@/lib/env";
import { ServiceWorker } from "@/components/service-worker";

export const metadata: Metadata = {
  title: "Vue Lights",
  description: "Lighting scenes for the living room",
  manifest: `${basePath}/manifest.webmanifest`,
  appleWebApp: {
    capable: true,
    title: "Vue Lights",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [
      { url: `${basePath}/icon-192.png`, sizes: "192x192", type: "image/png" },
      { url: `${basePath}/icon-512.png`, sizes: "512x512", type: "image/png" },
    ],
    // iOS ignores the manifest icons entirely. Without this the home screen
    // shows a screenshot thumbnail and the bare domain.
    apple: [{ url: `${basePath}/apple-touch-icon.png`, sizes: "180x180" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Without cover the safe-area insets all resolve to 0px and the CSS that
  // reads them looks like it does nothing.
  viewportFit: "cover",
  // Without this the keyboard resizes only the VISUAL viewport, so a bottom
  // row either rides up on top of the keyboard or vanishes under it. With it
  // the layout viewport shrinks and the dvh grid simply re-lays out.
  interactiveWidget: "resizes-content",
  // Must match the manifest's theme_color, or the status bar changes colour
  // between the browser and the installed app.
  themeColor: "#14120e",
  // Never user-scalable: false — it fails WCAG 1.4.4. The 16px input rule in
  // globals.css is what actually stops iOS zooming on focus.
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
