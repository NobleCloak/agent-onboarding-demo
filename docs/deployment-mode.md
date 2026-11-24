# Deployment mode

Fernhill Desk runs two ways. **Mock mode** (the default) is the sales demo: a local mock stands in for NobleCloak, the
Priya/Sam switch picks who approves, and nothing leaves this machine. **Deployment mode** runs the same app against a
real NobleCloak deployment: you sign in, and you are the one approver. It never starts, calls or depends on the mock,
and if a setting is missing it says which one and stops. It does not fall back to the mock.

Deployment mode is opened at **http://localhost:3417**, not 127.0.0.1: the sign-in module requires the redirect address to
be on the page's own origin, and this app's config check accepts only `https` or `http://localhost` for it.

## Setup, in order

**(a) Sign in once at https://app.noblecloak.com.** The first sign-in creates your organisation. Find its UUID in the app for step (c).

**(b) Register the public client, once (the operator).** The id is not a secret and a registration is permanent, so do
not repeat it. From a `noblecloak-ts` checkout, in `packages/react`:

```sh
bun run register-client --issuer https://auth.noblecloak.com \
  --redirect-uri http://localhost:3417/auth/callback
# {"issuer":"https://auth.noblecloak.com","client_id":"..."}
```

**(c) Create the agent's service principal.** Pick a path outside this repo for the credential:

```sh
NOBLECLOAK_AUTH_URL=https://auth.noblecloak.com NOBLECLOAK_ADMIN_AUDIENCE=https://admin-api.noblecloak.com \
  npx @noblecloak/cli sp create --org <org-uuid> --name "Fernhill Desk agent" \
  --audience https://govern.noblecloak.com --out <path outside the repo>
```

Copy the deployment block of `.env.example` into `.env.local` and fill it in: `NC_BASE_URL` and
`NEXT_PUBLIC_NC_API_URL` (`https://govern.noblecloak.com`), `NEXT_PUBLIC_NC_ISSUER`, `NEXT_PUBLIC_NC_CLIENT_ID` (from b),
`NEXT_PUBLIC_NC_REDIRECT_URI`, `NOBLECLOAK_SP_CREDENTIALS` (the `--out` path) and `NC_EXPECTED_PRINCIPAL` (the id
`sp create` printed). Then check them: `bun run preflight:deployment`. It reads the environment and the credential file
only; it makes no network call.

**(d) Install the governance, in Claude Code.** Run `/noblecloak-login`, then `/noblecloak-setup` (the `langgraph`
skill). Propose `demo/rules.plan.json` with `agent.principal_id` set to the new service principal's id, through the
plugin's `setup.mjs propose`. That is a real sign-in, so there is no mock token to fetch (the mock workaround in
`CLAUDE.md` is for mock mode only).

**(e) Approve the baseline, signed in.** Start the app (step f), click "Sign in to NobleCloak", and approve the rules on
the run page (`/people/onboarding/maya-torres`) or in the embedded Approvals panel. Only a person can approve; the
service principal's token is never used for it.

**(f) Run the demo.** `bun run demo:deployment` starts the app on localhost:3417 and, once the install is complete and
the credential file exists, the worker. It waits for the app on `/api/health`, which answers 200 without a sign-in and
without contacting NobleCloak (`/api/run` answers 401 until someone signs in, so it cannot be the readiness check).
`bun run dev:deployment` starts the app alone. (`bun run build:deployment` and `start:deployment` do the same for a
production build; the build needs the same `NEXT_PUBLIC_` values.) Next bakes the mode into the build, so a build must be
started in the mode it was built in: `start` and `start:deployment` name their mode in `FERNHILL_RUN_MODE`, and
`instrumentation.ts` makes the server fail every request when the two differ. The browser, and `curl`, see only a generic
500 "Internal Server Error"; the message that says to rebuild is in the server's log (the terminal that ran `start`). (A
bare `next start` names nothing and is not checked.)

## How it differs from mock mode

- The browser sends your access token on each call to `/api/nc`, `/api/proposal`, `/api/approvals` and `/api/run`
  (all three methods of `/api/run`: read, start, reset); the server forwards that one header and stores, mints and
  fetches nothing. A call without it gets 401, and so does a token the deployment rejects (the app asks the deployment
  before it answers, even when nothing is waiting); the page then shows a sign-in prompt. Cookies, and the persona
  cookie, are not forwarded. Only `/api/health` needs no token.
- Who decided a step, what they decided and why is shown only for approvals your own token can read. The app keeps none
  of it in its run store: each `/api/run` answer reads the run's approvals again with the token on that request, so a
  signed-in person who cannot read an approval sees the step without those details. The page's first, server-rendered
  paint is an idle skeleton with nothing from the run (no arguments, details or approval ids); the browser loads the run
  from `/api/run` with your token.
- The Priya/Sam switch is hidden. You are the approver.
- The Permissions page asks which Fernhill tools are registered from the browser, with your token (the mock-mode page asks
  from the server). Until you are signed in it shows a sign-in prompt, not the "not built yet" stub.
- The list of tools and rules is still cut down to Fernhill's (`ext:fernhill-desk:` tools and the rules naming them or
  covering every tool). The mock's own `mcp:` and `ext:local:` entries do not exist on a deployment; the filter does no harm there.
- The rule-copying shim (`syncModesFromPolicies` in `scripts/noblecloak-local.ts`) lives inside the mock and does not
  run. On a deployment the published rules decide on their own.
- `reset`, `reset:full` and `demo:new` refuse: they are mock only.
- No CORS setup is needed: the browser calls this app, and this app calls the deployment.

## Not yet verified against production

Nothing here has been run against https://govern.noblecloak.com or https://auth.noblecloak.com. Open points:

- That a first sign-in makes you an organisation administrator and an accepted approver.
- That the sign-in's scope (the default `approvals:resolve`, or `NEXT_PUBLIC_NC_SCOPE`) covers what the pages call: the
  approvals list and resolve, the policy-set proposal, and the Permissions module's policy edits. Compare it with the
  deployment's own `GET /v1/capabilities` answer.
- That an in-process `ext:` tool resumes after you approve it.
- That the policy-set proposal can be read and resolved from this app. On the mock, an approval's arguments came back to an
  administrator's token but not to a persona's; if a deployment does the same, a signed-in person without that right sees
  an empty proposal and cannot approve here.
