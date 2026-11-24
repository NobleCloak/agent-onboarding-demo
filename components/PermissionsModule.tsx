"use client";

import "@noblecloak/react/styles.css";
import { Permissions, usePolicies, type PermissionsLabels } from "@noblecloak/react/permissions";
import { Select, type SelectProps } from "@noblecloak/theme";
import { useSyncExternalStore } from "react";
import { sharedAuth } from "../lib/browser-auth";
import { currentMode } from "../lib/mode";

// NobleCloak's own Permissions module, pointed at this app's same-origin /api/nc route.
// Mock mode: the route holds the real token; this placeholder is what the module sends as its bearer and the route throws away.
// Deployment mode: the module sends the signed-in person's own access token and the route forwards it.
const PLACEHOLDER = "local-demo-placeholder";
const getToken = (): Promise<string> | string => (currentMode() === "deployment" ? sharedAuth().getToken() : PLACEHOLDER);
// The one role the local demo's rules are written for. The module adds an Organisation column of its own, which
// it has no option to leave out.
const ROLES = [{ id: "everyone" }];

/** The column the module always adds. The rules here are for `everyone` only, so this column is named as unused. */
export const UNUSED_COLUMN = "Organisation (not used here)";
const LABELS: PermissionsLabels = { heading: "Rules by tool", organisationColumn: UNUSED_COLUMN };

/** Whether a control belongs to the unused column: the module names each cell control "{mode} for {column} on {tool}". */
export const isUnusedColumnControl = (label: string | undefined) => (label ?? "").includes(` for ${UNUSED_COLUMN} on `);

// What this app reads when it decides a call is the published `everyone` rule, so a rule in any other column would
// save but change nothing. The module's Select slot (its supported way to change a control) disables that column.
function RoleSelect(props: SelectProps) {
  const unused = isUnusedColumnControl(props["aria-label"]);
  return <Select {...props} disabled={props.disabled || unused} title={unused ? "These rules apply to everyone" : props.title} />;
}
const COMPONENTS = { Select: RoleSelect };

const noop = () => () => undefined;
const origin = () => window.location.origin;

function Table({ baseUrl }: { baseUrl: string }) {
  const controller = usePolicies({ baseUrl, getToken, roles: ROLES, onFault: (f) => console.warn("[fernhill] permissions fault", f) });
  return <Permissions controller={controller} labels={LABELS} components={COMPONENTS} />;
}

export function PermissionsModule() {
  // Empty while the server renders and during hydration, then this page's own origin.
  const base = useSyncExternalStore(noop, origin, () => "");
  return (
    <div className="nc-host" data-nc-theme="light" data-testid="permissions-module">
      <p className="nc-host-label" data-testid="local-label">{currentMode() === "deployment" ? "NobleCloak" : "Local NobleCloak"}</p>
      {base === "" ? <p className="note">Loading rules.</p> : <Table baseUrl={`${base}/api/nc`} />}
    </div>
  );
}
