# Fernhill Desk: a NobleCloak demo you can run yourself

Fernhill Desk is a small pretend company app. Inside it, an AI agent onboards a new hire named Maya: it creates her
accounts, orders her laptop, sets up her payroll and issues her a company card.

The demo shows the same agent twice:

1. **With no rules.** The agent does everything it is asked, including handing Maya a $25,000 card and full admin
   access. Nobody is asked first.
2. **With NobleCloak.** The routine steps still run on their own. The risky ones stop: one is refused outright, and two
   wait for a person to approve or deny them.

You don't need to be a developer to run it. If you can copy and paste into a terminal, you can follow this page. Setup
takes about 10 minutes.

## Is any of this real?

Nothing in the demo touches a real system, and nothing leaves your computer.

- **The company, the people and the tools are fake.** No real accounts are created, nothing is ordered and no card is
  issued.
- **The agent is scripted.** It follows a fixed script instead of calling an AI model, so it does the same thing every
  time and needs no API key.
- **The NobleCloak pieces in the app are the real, published packages**: the part that checks each tool call, the
  approval flow, and the Permissions screen.
- **They talk to a stand-in for NobleCloak's service** that runs on your computer, so you need no account. It is a
  simplified stand-in, not NobleCloak's actual policy engine.

## What you need

These steps were written and tested on a Mac. They have not been tried on Windows.

| You need | What it is | How to get it |
| --- | --- | --- |
| A terminal | The app where you type commands. | On a Mac, open **Terminal** (press Cmd+Space, type "Terminal", press Return). |
| Git | Downloads the code. | Type `git --version` in the terminal. If it isn't installed, your Mac offers to install it. |
| Node.js 22 or newer | Runs part of the demo. | Download the LTS installer from [nodejs.org](https://nodejs.org). |
| Bun | Installs and starts the app. | Paste `curl -fsSL https://bun.sh/install \| bash` into the terminal, then close and reopen it. |
| Claude Code (optional) | The AI coding assistant that adds NobleCloak to the app in Part 2. If you use a different assistant, or none, Part 2 has a path without it. | Follow the install steps at [claude.com/claude-code](https://claude.com/claude-code). |

To check your setup, run these one at a time. Each should print a version number. Skip the last one if you aren't
using Claude Code:

```
git --version
node --version
bun --version
claude --version
```

## Part 1: Get the app running

### 1. Download the code

"Cloning" means downloading a copy of the code to your computer. This puts it in a new folder called
`agent-onboarding-demo`, inside whatever folder your terminal is in:

```
git clone https://github.com/NobleCloak/agent-onboarding-demo.git
```

### 2. Go into the folder

Every command after this one is run from inside this folder:

```
cd agent-onboarding-demo
```

### 3. Install what the app needs

This downloads the code libraries the app is built on. It takes a few seconds:

```
bun install
```

### 4. Start the demo

```
bun run demo
```

Lines of text scroll past for up to a minute. Several of them start with `[demo]`, such as `[demo] mock ready` and
`[demo] app ready`. Those are progress messages, and the demo is not ready yet.

Wait for the line that starts with `[demo] up:`. It looks like this:

```
[demo] up: mock and app ... App http://127.0.0.1:3417  Mock http://127.0.0.1:8787  Ctrl-C stops everything.
```

After that line, more lines starting with `[app]` keep appearing as you use the app. That is normal.

**Leave this terminal window open.** The demo runs for as long as it stays open. To stop the demo later, click this
window and press Ctrl+C.

### 5. Check that it's ready

Open a **second** terminal window (Cmd+N in Terminal), go into the folder again, and run the check:

```
cd agent-onboarding-demo
bun run preflight
```

You want the last line to say `READY: safe to begin.` If it says `NOT READY`, the lines above it name what is wrong. A
`WARN` line about the plugin is expected. It goes away if you install the plugin in Part 2, and it is harmless if you
don't.

### 6. Open the app

Open a **new browser tab**, so this page stays open beside it. Copy this address, paste it into the new tab's address
bar, and press Return:

```
http://127.0.0.1:3417/people/onboarding/maya-torres
```

You are looking at Maya's onboarding ticket in Fernhill Desk.

## Part 2: See the problem, then fix it

### 1. Run the agent with no rules

Click **Run**. All nine steps turn green, and the page says "All set."

Now read what the agent actually did. It copied a colleague's setup, so Maya, a new coordinator, got:

- a company card with a $25,000 monthly limit
- the Org admin role, which controls everyone's access
- a salary copied from a vice president

### 2. See why nothing stopped it

In the left menu, open **Automation > Permissions**. Every agent can use every tool, and nothing needs approval. The
page even says so: rules and approvals aren't built yet.

Then go to your second terminal and clear the run, so you can start again:

```
bun run reset
```

### 3. Add NobleCloak

There are two ways to do this. Pick one.

- **Option A: have Claude Code do it.** You watch an AI coding assistant read the app and add NobleCloak to it. This is
  the full demo.
- **Option B: use the prebuilt copy.** NobleCloak's plugin is only available for Claude Code today. If you use a
  different assistant, or none, switch to a copy of the app that already has NobleCloak added. You skip watching the
  install and see everything else.

#### Option A: have Claude Code do it

In your second terminal, start Claude Code:

```
claude
```

Install the NobleCloak plugin with two commands. Copy and run them **separately**: Claude Code treats everything you
paste as one command, so pasting both together fails.

First, paste this into Claude Code and press Return:

```
/plugin marketplace add NobleCloak/noblecloak-claude-plugin
```

Wait for that to finish. Then paste this and press Return:

```
/plugin install noblecloak@noblecloak
```

Don't sign in to NobleCloak if the plugin offers it. This demo uses no account.

Then paste this message into Claude Code:

```
These tool calls run without checking any policies. We need to protect them with NobleCloak.
```

Claude reads the app, works out which of the agent's actions are risky, and writes the code that puts NobleCloak in
front of them. Expect it to take a few minutes. Claude may ask for permission to edit files or run commands along the
way; say yes. It is finished when it tells you the rules are waiting for approval.

**Don't stop or restart `bun run demo` in your first terminal**, even if Claude's summary mentions that command. The
demo picks up Claude's changes by itself. Restarting it erases the rules Claude just proposed, and you would have
nothing to approve in the next step.

If you run `bun run preflight` at this point, it says `NOT READY` and lists `approvals` and `rules`. That is expected:
the rules exist but nobody has approved them yet.

#### Option B: use the prebuilt copy

Run these three commands in your second terminal, one after another. Leave `bun run demo` running in the first.

Switch the code to the copy that already has NobleCloak added. The running demo notices the change by itself:

```
git checkout demo/governed
```

Download NobleCloak's plugin files into a folder next to this one. Nothing gets installed; the next command only needs
one script from them:

```
git clone https://github.com/NobleCloak/noblecloak-claude-plugin.git ../noblecloak-claude-plugin
```

Propose the rules, so they are waiting for you to approve:

```
bun run reset --rules --no-approve --plugin ../noblecloak-claude-plugin
```

The rules you are about to approve are a set saved with the demo.

### 4. Approve the rules

The rules have been proposed, but nothing can switch them on except a person.

Go back to Maya's page in your browser. The nine proposed rules are listed there. Read them, then click **Approve
rules**.

Open **Automation > Permissions** again. The "not built yet" page has been replaced by NobleCloak's permissions screen,
running inside the app.

### 5. Run the agent again

Go back to Maya's page and click **Run**. This time:

- **Six routine steps finish on their own**: her accounts, laptop, polos and business cards.
- **The admin role is refused.** That step shows "Not allowed". The agent is never permitted to do it.
- **Payroll and the company card wait for a person.**

Now be the approvers. At Fernhill, payroll is decided by HR and company cards by Finance, and NobleCloak holds each
person to their own team's requests. The approval panel in the right-hand column shows who you are acting as, with a
button to switch between Priya (Finance) and Sam (HR):

1. Check the panel says you are acting as Priya. If it says Sam, click **Switch to Priya**; the app remembers who you
   were last time. Scroll down the right-hand column to **Issue company card**. It shows the $25,000 limit. Click
   **Deny**.
2. Look at **Create payroll record**, just above it. Priya gets no Approve or Deny button there and can't see the
   salary details. The panel says only HR can decide it.
3. Click **Switch to Sam**, then click **Approve** on **Create payroll record**. Sam, in turn, can't decide or see the
   card request.

The run finishes without the card, and the page shows who decided what.

## Running it again

Run these in your second terminal. If Claude Code is still open there, type `/exit` first.

If you used Option B, add ` --plugin ../noblecloak-claude-plugin` to the end of any `bun run reset --rules` command, here
and in the troubleshooting table below.

| You want to | Run |
| --- | --- |
| Run the agent again with the rules in place | `bun run reset --rules`, then click **Run** |
| Approve the rules yourself again before running | `bun run reset --rules --no-approve` |
| Go all the way back to the app with no NobleCloak | `bun run reset:full` |
| Stop the demo | Click the first terminal window and press Ctrl+C |
| Start it again later | `cd agent-onboarding-demo`, then `bun run demo` |

## If something goes wrong

| What you see | What to do |
| --- | --- |
| `command not found: bun` (or `git`, `node`, `claude`) | That tool isn't installed, or the terminal hasn't noticed it yet. Close the terminal, open a new one, and try again. If it still fails, install it from [What you need](#what-you-need). |
| `git clone` says "Repository not found" | Check the address you typed against step 1. |
| `bun run demo` says a port is already in use | The demo, or another app, is already using it. Find the terminal window where the demo is still running and press Ctrl+C, then start it again. |
| `bun run demo` stops right after starting | Run `bun run demo` again. |
| The browser can't open the page | The demo isn't running. Check that the first terminal window is still open, then scroll up in it to find the `[demo] up:` line. If the line isn't there, the demo is still starting or has stopped. |
| Maya's page shows no rules to approve and no **Approve rules** button | The proposed rules are gone, usually because `bun run demo` was restarted after Claude finished. Run `bun run reset --rules --no-approve` in your second terminal, reload the page, and approve the rules that appear. |
| All nine steps show "Not allowed" | You clicked **Run** with no rules approved. Run `bun run reset --rules`, then click **Run**. |
| **Approve rules** is greyed out | The proposed rules have a problem the page can't accept. Run `bun run reset --rules --no-approve` to load a known-good set, then approve those. |
| Claude Code shows an **Add marketplace** box with a red "not a valid GitHub owner/repo shorthand" message | Both plugin commands were pasted at once. Press Esc, then run them one at a time, as in [Add NobleCloak](#3-add-noblecloak). |
| Anything else | Run `bun run preflight`. It names what is wrong. |

## Going further

- **Present this demo to an audience, or change the code:** see the
  [presenter and developer guide](docs/presenter-guide.md).
- **Run it against a real NobleCloak deployment** instead of the stand-in: see
  [deployment mode](docs/deployment-mode.md).
