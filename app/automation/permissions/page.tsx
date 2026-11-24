import { AppShell } from "@/components/AppShell";
import { DeploymentPermissions } from "@/components/DeploymentPermissions";
import { PageHeader } from "@/components/PageHeader";
import { PermissionsModule } from "@/components/PermissionsModule";
import { PermissionsStub } from "@/components/PermissionsStub";
import { currentMode } from "@/lib/mode";
import { hasRegisteredTools } from "@/lib/nc-proxy";

// Read on every request, so approving the rules turns this page from the stub into the real module with no restart.
export const dynamic = "force-dynamic";

// Before NobleCloak: a static stub, the page the presenter points at when they say "I need to handle this."
// Once Fernhill's tools are registered (the rules were approved): NobleCloak's own Permissions module over the local mock.
// Deployment mode: this server holds no token, so it cannot ask; the page asks from the browser with the signed-in
// person's token (components/DeploymentPermissions.tsx).
export default async function PermissionsPage() {
  if (currentMode() === "deployment") {
    return (
      <AppShell active="permissions">
        <PageHeader crumb="Automation / Permissions" title="Permissions" subtitle="What each tool may do when an agent calls it" />
        <DeploymentPermissions stub={<PermissionsStub />} />
      </AppShell>
    );
  }
  if (await hasRegisteredTools()) {
    return (
      <AppShell active="permissions">
        <PageHeader crumb="Automation / Permissions" title="Permissions" subtitle="What each tool may do when an agent calls it" />
        <PermissionsModule />
      </AppShell>
    );
  }
  return (
    <AppShell active="permissions">
      <PageHeader crumb="Automation / Permissions" title="Permissions" subtitle="What each agent can do across your connected tools" />
      <PermissionsStub />
    </AppShell>
  );
}
