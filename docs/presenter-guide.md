# Presenter and developer guide

The detailed reference for people who present Fernhill Desk or change its code. If you just want to try the demo, start
with the [README](../README.md).

Fernhill Desk is a fake internal ops app (placeholder company "Fernhill") that demonstrates NobleCloak live. The agent is
scripted (no LLM) and the nine tools are fake. What runs is the published NobleCloak packages (the adapter, the approval
flow and the Permissions module) against a local mock, with a small demo shim that makes saved rules decide outcomes.

Package name is `fernhill-desk`, so governed tool refs are `ext:fernhill-desk:<tool>`.

## Install

NobleCloak packages come from public npm (`@noblecloak/langgraph` 0.5.2, `client` 0.14.1, `spec` 0.12.3), pinned
exactly. (`langgraph` 0.5.2 accepts `client` `>=0.13.1 <0.15.0`, so there is one installed `client` and no `overrides` entry.)

    bun install

## Local NobleCloak (no account)

    bun run noblecloak     # the published mock on http://127.0.0.1:8787, admits http://127.0.0.1:3417

This is a demo shim over the mock, not NobleCloak's policy engine (see the comment in `scripts/noblecloak-local.ts`).
State is in memory: stopping it wipes everything, and a fresh one has no tools or rules until a plan is proposed and
approved. On start it writes `.data/noblecloak-sp.credentials.json` and, if missing, `.env.local` (both git-ignored).

**Who approves.** Payroll (`adp_create_employee`) is decided by HR and the company card (`mercury_issue_card`) by Finance;
the table is `lib/approver-routing.ts`. A setup proposal carries a mode for each rule and nothing else, so the shim names
the team's role as the approver on those two rules once they are published, and gives Priya's token the `finance` role and
Sam's the `hr` role. The mock then enforces it by itself, as the NobleCloak API describes: a decision from anyone else is
refused (403 `not_eligible`) and they are not shown the call's arguments. In the panel that person sees "Only HR can decide
this. Switch to Sam." with no buttons. A tool with no team (any of the other seven, if a rule edit makes it ask) can be
decided by either. In a real deployment an administrator names the approvers on the policy.

To run the same app against a real NobleCloak deployment (you sign in and approve; no mock), see [`deployment-mode.md`](deployment-mode.md).

## Governed run

`CLAUDE.md` holds the local setup facts for installing NobleCloak with the plugin's `/noblecloak-setup`. Once installed:

    bun run worker         # resumes approved calls. `bun run demo` starts it for you; run it by hand only without the launcher (preflight will not accept it)

The rule proposal shows on the run page for an administrator to approve.

## Running the demo

Commands, all from the repo root. The scripts act only on the checkout they live in: `bun run <script>` always starts in that root,
and running `bun scripts/<name>.ts` from any other directory is refused.

    bun run demo:new [name]   # a fresh clone of the base branch in ~/demos/fernhill-<name or date>, bun install done; copies nothing
    bun run demo           # the mock, the app, and the worker (started by itself once src/noblecloak/worker.ts is complete), together; Ctrl-C stops them
    bun run preflight      # exits non-zero and names what is wrong; READY means safe to begin
    bun run reset          # between runs: clears the run, restarts the mock and worker (needs bun run demo)
    bun run reset --rules      # same, then reopens and approves demo/rules.plan.json (plugin found automatically, see below)
    bun run reset --rules --no-approve   # same, but leaves the approval to the administrator on the page
    bun run reset:full     # back to the pre-install branch, src/noblecloak/ gone, .data/ cleared

The NobleCloak plugin is installed once on the demo machine, from Claude Code's marketplace:

    /plugin marketplace add NobleCloak/noblecloak-claude-plugin
    /plugin install noblecloak@noblecloak

Claude Code unpacks it under `~/.claude/plugins/cache/noblecloak/noblecloak/<version>/` and lists it in
`~/.claude/plugins/installed_plugins.json`. `reset --rules` reads that list and uses the `installPath` it finds (the folder that
holds `setup-skills/`), so no path needs typing. `--plugin <dir>` or `NOBLECLOAK_PLUGIN_DIR` override it (for a plugin checkout);
`bun run preflight` warns when the plugin is not in the list. Run the demo from a clone outside `~/bianoble`, or the parent `CLAUDE.md` loads into the live session
(preflight warns).

A mock restart wipes the rules, the registered tools and the agent, so on an installed tree plain `reset` leaves every call
at "Not allowed" until the rules are approved again; `--rules` does that. `reset:full` refuses, and lists the files, if
anything outside the install's paths has changed, if an install file has an edit that is not the install's, if `.data` is a
symlink, or if the base branch is checked out in another worktree. It saves what it discards to `.reset-backups/`
(git-ignored) and prints the path. The base branch it returns to is `BASE_BRANCH` in `scripts/demo-config.ts` (`main`). `FERNHILL_APP_PORT` and `FERNHILL_MOCK_PORT` move the ports (defaults 3417 and 8787) for
rehearsals and tests. `bun run demo` fails if a port is taken and never stops a process it did not start.

### Demo day: start from a new copy

Each demo starts from a brand-new copy, not a reset checkout. From the source checkout (any branch):

1. `bun run demo:new` (or `bun run demo:new <name>`). It clones `BASE_BRANCH` from `origin` into
   `~/demos/fernhill-<name or date>`, runs `bun install` from the public npm registry (no GitHub Packages token), and prints
   the next commands. It refuses if the folder exists or is under `~/bianoble`, and copies nothing from the source (no
   `.env.local`, `.data/`, credentials). `demo/governed` must be pushed to `origin`, or the fallback below is not in the copy
   (the command warns). `FERNHILL_DEMOS_DIR` replaces `~/demos`.
2. `cd` into the copy. Terminal 1: `bun run demo`. It writes the missing `.env.local`, the mock writes the credential, the
   app and mock start (no worker yet: NobleCloak is not installed). 0 restarts. While it runs it watches for
   `src/noblecloak/worker.ts` and starts the worker itself as soon as that file, the files it imports and the credential are
   complete (it retries a few times if a file is still being written, and stops the worker if the file goes away). Nobody
   starts the worker by hand: preflight only accepts the launcher's.
3. Terminal 2: `bun run preflight` until READY.

Then one of:

#### Live install (the session installs NobleCloak on stage)

4. Optional, the ungoverned run: click Run. Between takes `bun run reset` (1 mock restart each).
5. Open Claude Code in the copy (`claude`) with the plugin installed (above), and give it the install prompt, word for word:
   "These tool calls run without checking any policies. We need to protect them with NobleCloak." (`CLAUDE.md` holds the
   answers it would otherwise ask for, including that the launcher owns the worker.)
6. When the session has written the files the launcher starts the worker by itself (it logs `starting the worker`); the
   running app picks up the new agent wiring without a restart. The session's own rules proposal is on the run page: the
   administrator approves it there. 0 restarts. (If the proposal was lost, `bun run reset --rules`
   reopens it and restarts the mock and worker once.)
7. `bun run preflight` until READY, then Run. Between takes: `bun run reset --rules` (1 restart each;
   add `--no-approve` to approve on stage).

#### Fallback: cut to `demo/governed`

`demo/governed` is `main` plus the NobleCloak install. A GitHub Actions workflow (`.github/workflows/sync-governed.yml`)
merges `main` into it after every push to `main`, runs the type check and the unit tests on the result, and pushes. If the
merge conflicts or a check fails it pushes nothing and the run fails; merge `main` into `demo/governed` by hand then. Never
merge `demo/governed` into `main`: `main` is the pre-install state the demo starts from.

4. In the same copy (clean tree): `git checkout demo/governed` (it comes from `origin/demo/governed`). If the live install
   was attempted, run `bun run reset:full` first, then this checkout.
5. The running launcher notices the new files and starts the worker itself, with no restart (watch for `starting the worker`).
6. `bun run reset --rules --no-approve`. 1 restart; the administrator approves the proposal on the page.
7. `bun run preflight` until READY, then Run. Between takes: `bun run reset --rules` (1 restart each).

After a demo, throw the copy away. `bun run reset:full` exists to rewind a copy you want to keep (it pauses and restarts the
demo once, ends pre-install) and `reset` for a rehearsal in place.

#### Opening the proposal by hand

`bun run reset --rules` does this for you. To do it yourself, for example on `demo/governed`, which has no session to write
a plan: the branch uses `demo/rules.plan.json`, whose principal is `svc_adapter`. From the repo root, with the mock running
on a fresh start, and with `<plugin>` the plugin's directory:

    NC_BASE_URL=http://127.0.0.1:8787 \
    NC_PROPOSER_TOKEN="$(curl -s http://127.0.0.1:8787/__mock/tokens | node -pe 'JSON.parse(require("fs").readFileSync(0)).creator_user')" \
    node <plugin>/setup-skills/noblecloak-setup-langgraph/scripts/propose.mjs --plan demo/rules.plan.json

It writes the mock's agent id into `src/noblecloak/agent.json`, so after a mock restart run
`git checkout src/noblecloak/agent.json` before proposing again, or it answers `unknown_agent`.

## Browser tests

Playwright needs a browser once per machine: `bunx playwright install chromium`.
