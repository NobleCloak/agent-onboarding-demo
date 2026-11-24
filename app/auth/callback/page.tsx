import { notFound } from "next/navigation";
import { CallbackClient } from "@/components/CallbackClient";
import { currentMode } from "@/lib/mode";

// Where the NobleCloak sign-in returns to (http://localhost:3417/auth/callback). Deployment mode only: the mock has no sign-in.
export const dynamic = "force-dynamic";

export default function CallbackPage() {
  if (currentMode() !== "deployment") notFound();
  return (
    <main className="main">
      <h1>Signing in</h1>
      <CallbackClient />
    </main>
  );
}
