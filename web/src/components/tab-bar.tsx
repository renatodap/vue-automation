"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Clock, House, LayoutGrid, Lightbulb } from "lucide-react";

/**
 * The app's third grid row.
 *
 * Not `position: fixed` — the shell is already `auto 1fr auto`, so this is a row
 * that exists whether or not anything fills it. Fixed elements detach from the
 * layout viewport and iOS moves them independently; a grid row cannot move,
 * because the grid IS the viewport.
 *
 * Link and usePathname both handle basePath themselves: Link prepends it,
 * usePathname reports the path with it already stripped, so the hrefs and the
 * comparisons below are both written as if the app owned the domain root.
 */
const TABS = [
  { href: "/", label: "Home", Icon: House },
  { href: "/scenes", label: "Scenes", Icon: LayoutGrid },
  { href: "/schedules", label: "Schedules", Icon: Clock },
  { href: "/devices", label: "Devices", Icon: Lightbulb },
] as const;

export function TabBar() {
  const pathname = usePathname();

  return (
    <nav className="tabbar" aria-label="Sections">
      {TABS.map(({ href, label, Icon }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className="tab"
            data-active={active || undefined}
            aria-current={active ? "page" : undefined}
            // Prefetch is on by default and is the right call here: four routes,
            // all tiny, and a tab that hesitates feels like a web page.
          >
            <Icon size={19} aria-hidden />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
