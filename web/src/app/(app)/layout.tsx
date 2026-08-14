import { AppShell } from "@/components/app-shell";

/**
 * The four tabs share one shell and one poller.
 *
 * A route group, so the URLs stay flat — Room is still the app's root — while
 * /login keeps the root layout and never inherits a tab bar it has no business
 * showing to someone who is not signed in yet.
 */
export default function TabsLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
