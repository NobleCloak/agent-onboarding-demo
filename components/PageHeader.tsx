import type { ReactNode } from "react";

export function PageHeader({
  crumb,
  title,
  subtitle,
  actions,
}: {
  crumb: string;
  title: string;
  subtitle: string;
  actions?: ReactNode;
}) {
  return (
    <>
      <div className="crumb">{crumb}</div>
      <div className="who">
        <div>
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
        {actions && <div className="sp actions">{actions}</div>}
      </div>
    </>
  );
}
