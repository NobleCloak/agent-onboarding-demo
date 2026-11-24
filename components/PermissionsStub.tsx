import { toolCount } from "@/lib/seed";

const AGENTS = ["Onboarding agent", "IT request agent", "Vendor renewal agent"];

/** The Permissions page before NobleCloak: a static stub, the page the presenter points at when they say "I need to handle this." */
export function PermissionsStub() {
  return (
    <>
      <div className="tabs" style={{ marginTop: 0 }}>
        <b>Agents</b>
        <span>Approvals</span>
        <span>History</span>
      </div>
      <table>
        <thead>
          <tr><th>Agent</th><th>Connected as</th><th>Tools</th><th>Needs approval</th></tr>
        </thead>
        <tbody>
          {AGENTS.map((name) => (
            <tr key={name}>
              <td><b>{name}</b></td>
              <td><span className="chip">fernhill-automation key</span></td>
              <td>All {toolCount()}</td>
              <td>Nothing</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="stub">
        <h4>Rules and approvals aren&apos;t built yet</h4>
        <p>Right now every agent can call every tool, and nobody gets asked.</p>
        <div className="todo">
          TODO: who approves what? per-role rules? HR vs Finance routing?<br />
          TODO: audit log for SOC 2. Ask Jordan what they need.
        </div>
      </div>
    </>
  );
}
