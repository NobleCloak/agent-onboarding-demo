import Link from "next/link";
import type { ReactNode } from "react";
import { SignInBar } from "@/components/SignInBar";
import { navSections, type NavKey } from "@/lib/nav";
import { seed } from "@/lib/seed";

export function AppShell({
  active,
  children,
  side,
}: {
  active: NavKey;
  children: ReactNode;
  /** Optional right-hand panel, as on the onboarding mockup. */
  side?: ReactNode;
}) {
  return (
    <div className={side ? "app" : "app two"}>
      <nav className="nav" aria-label="Main">
        <div className="org">
          <span className="logo">F</span>
          {seed.org}
        </div>
        {navSections.map((section, i) => (
          <div key={section.title ?? i}>
            {section.title && <div className="sec">{section.title}</div>}
            {section.items.map((item) => (
              <Link
                key={item.key}
                href={item.href}
                className={item.key === active ? "lnk on" : "lnk"}
                aria-current={item.key === active ? "page" : undefined}
              >
                {item.label}
                {item.count !== undefined && <i>{item.count}</i>}
              </Link>
            ))}
          </div>
        ))}
        <SignInBar />
      </nav>
      <main className="main">{children}</main>
      {side && <aside className="side">{side}</aside>}
    </div>
  );
}
