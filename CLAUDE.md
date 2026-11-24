# Fernhill Desk: local setup facts

This app's NobleCloak deployment is a local mock on this machine. There is no account, no sign-in and no real service
principal. To protect the agent's tool calls, use the plugin's `/noblecloak-setup` command with the facts below. They
answer what the command and its skill would otherwise stop to ask.

- **Which skill:** `langgraph`. This repo is also a Next.js app; the module skills are not what is being set up.
- **Package source:** `registry`, but the packages are already installed, so run `apply.mjs --skip-install`: a `bun add`
  would loosen this repo's exact pins (`@noblecloak/langgraph` 0.5.2, `@noblecloak/client` 0.14.1; no `overrides` entry
  is needed any more).
- **API origin:** `http://127.0.0.1:8787`. It is running (`bun run noblecloak`). So is the app, from this checkout
  (`bun run dev`, port 3417).
- **Service principal id:** `svc_adapter`. Use it as `agent.principal_id` in the plan.
- **Credential file:** `.data/noblecloak-sp.credentials.json`. The local mock generates it on start; it is git-ignored.
- **Environment:** `.env.local` already sets `NC_BASE_URL`, `NOBLECLOAK_SP_CREDENTIALS` and `NC_EXPECTED_PRINCIPAL` for
  the app. The launcher (`bun run demo`) starts the worker by itself once `src/noblecloak/worker.ts` exists; do not start it yourself. Nothing else needs setting.
- **The proposal:** the mock has no plugin sign-in, so `setup.mjs propose` cannot work here. Run the skill's `propose.mjs`
  directly, and get the token the same way each time (it changes when the mock restarts):

  ```sh
  NC_BASE_URL=http://127.0.0.1:8787 \
  NC_PROPOSER_TOKEN="$(curl -s http://127.0.0.1:8787/__mock/tokens | node -pe 'JSON.parse(require("fs").readFileSync(0)).creator_user')" \
  node <the skill's directory>/scripts/propose.mjs --plan <plan.json>
  ```

  That token is a person's, as the skill requires. The agent never uses it.
- **Approval:** an administrator approves the proposal on the run page, `http://127.0.0.1:3417/people/onboarding/maya-torres`.
  `NOBLECLOAK_APPROVALS_URL` can be set to that address.

## Deployment mode (a real NobleCloak deployment instead of the mock)

Everything above is **mock mode**, the default. If `NEXT_PUBLIC_FERNHILL_MODE=deployment` is set (the `*:deployment`
scripts set it), the facts that differ are these; the rest of this file holds. Runbook: `docs/deployment-mode.md`.

- **No mock.** Nothing starts, calls or reads `/__mock/*` or `/__demo/*`. API origin `https://govern.noblecloak.com` (`NC_BASE_URL`), issuer
  `https://auth.noblecloak.com`. The app is opened at `http://localhost:3417`, not 127.0.0.1.
- **Service principal id and credential:** the ones `npx @noblecloak/cli sp create` made, not `svc_adapter`. The credential file is
  outside the repo; `.env.local` names it (`NOBLECLOAK_SP_CREDENTIALS`, `NC_EXPECTED_PRINCIPAL`). Use that id as `agent.principal_id`.
- **The proposal:** the plugin signs in for real, so use `setup.mjs propose` (after `/noblecloak-login`). Do **not** use the mock
  workaround (`propose.mjs` with a token from `/__mock/tokens`); there is no such route and no such token.
- **Approval:** the signed-in person approves in the app. The service principal's token is never used to approve. There is no persona switch.
- **Ports and launcher:** `bun run demo:deployment` starts the app and the worker only, and waits for the app on the token-free `/api/health` (`/api/run` is 401 until sign-in). `reset`, `reset:full`, `demo:new` refuse. A build started in the wrong mode answers a generic 500; the rebuild message is in the server log only.
- **Tokens on `/api/run`:** deployment mode needs the bearer on GET, POST and DELETE `/api/run`; decision details (who decided, why) come only from approvals the request's own token can read, never from the run store.

## What is already decided here

- `demo/rules.plan.json` gives every policy a plain `name` and `description`, so approvers read names instead of
  `pol_…` ids. The skill's `propose.mjs` accepts those members from NobleCloak Claude Code plugin **0.2.3**; an older
  plugin refuses the plan (`plan.policies[0].name is not a member`). Update the plugin first.
- All nine tools in `src/agent/tools.ts` are in scope and the list is complete. They run in-process, so each one is
  `ext:fernhill-desk:<tool>`. All the systems they reach are real outside vendors or Fernhill's own directory.
- Fernhill's approver policy, where it differs from what the rubric picks on its own: the six routine onboarding tools
  (`okta_create_user`, `google_create_account`, `slack_invite`, `cdw_order_laptop`, `merch_order_polos`,
  `print_order_business_cards`) run freely, as Fernhill's own decision, even though some spend money with a vendor;
  record the truthful assessment and say in the rationale that it is the company's decision. `adp_create_employee` and
  `mercury_issue_card` ask a person. `okta_assign_admin_role` is denied: the agent must never do it.
- Who approves is not part of the plan: a proposal's policies carry `mode` only, and one with `approvers` is refused. The
  local mock names HR on the payroll rule and Finance on the card rule by itself once they are published
  (`scripts/noblecloak-local.ts`). Do not add `approvers`, `approver_groups` or `rules` to the plan.
- Do not stop to confirm the tool list, the plan or the proposal. Nothing takes effect until the administrator approves,
  which is the check. Say what you did, and leave the approval to the administrator. Do not approve it or run the agent.
- When you report, do not name `bun run demo` or suggest starting or restarting anything. The demo is already running
  and picks the install up by itself; a restart wipes the mock, and the proposal with it. Say that nothing needs
  restarting and that the next step is to approve the rules on the run page.
- Everything needed is in this file, the skill and `src/agent/`. `demo/`, `docs/`, `e2e/`, `lib/` and `scripts/` are not part
  of the install and do not need reading. They include plans and transcripts from earlier installs; write the plan yourself
  from the skill's rubric.

## Wiring

- `buildAgent({ middleware })` in `src/agent/agent.ts` takes the governance middleware and already has a persistent
  SQLite checkpointer that the app and the worker share. Do not change `src/agent/agent.ts`.
- The app starts the agent in `startAgentRun` in `src/agent/start.ts`. Keep the `reconcile` call and the rest of that
  function; change only how the agent is built. `src/agent/start.test.ts` mocks `./agent` and `src/agent/agent.test.ts`
  drives `startAgentRun` with the real agent, so both need `../noblecloak/governance` and
  `../noblecloak/governed-agent` mocked after that change.
- **Imports in `src/noblecloak/` that the app also loads are extensionless**, like every other file under `src/`:
  `import { buildAgent } from "../agent/agent"`, not `"../agent/agent.js"`. `governed-agent.ts` is bundled by Next.js,
  which cannot resolve a `.js` specifier to a `.ts` file, so every page answers 500. The generated `worker.ts` uses `.js`
  because it runs under `tsx`; do not copy that style into `governed-agent.ts`.
- The plan file goes outside the source tree, as the skill says. The run page refuses to approve what it cannot state, so:
  one baseline policy for each tool and a tool entry for each policy; `show_arguments_to_approvers` true on every tool; a
  tool's `side_effect_level` equal to its policy's `assessment.side_effect_level`; no members the skill's plan example does
  not show.
