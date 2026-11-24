// The launcher records what it started in .demo-launcher.json (git-ignored) so `reset`, `reset:full` and `preflight`
// can tell a demo they own from a process somebody else started. Nothing here kills anything.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { basename, dirname, resolve } from "node:path";

export type ChildName = "mock" | "app" | "worker";
export type ChildInfo = { pid: number; startedAt: string };
export type LauncherState = {
  pid: number;
  /** This checkout's root and the launcher's absolute script path. The pid is trusted only if its command line names this script. */
  root: string;
  script: string;
  /** The launcher process's own start time (ms, from ps), so a reused pid is never taken for it. */
  procStartMs: number;
  startedAt: string;
  appPort: number;
  mockPort: number;
  /** `paused` means the launcher is alive and every child is stopped (during `reset:full`). */
  mode: "starting" | "running" | "restarting" | "paused";
  /** Counts completed starts, restarts and resumes, so a caller can wait for the next one. */
  generation: number;
  /** Why the launcher has no worker although NobleCloak is installed (it gave up after quick exits). */
  workerNote?: string;
  children: Partial<Record<ChildName, ChildInfo>>;
};

export function readState(file: string): LauncherState | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as LauncherState;
  } catch {
    return null;
  }
}

export function writeState(file: string, state: LauncherState): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, file);
}

export const removeState = (file: string) => rmSync(file, { force: true });

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function commandOf(pid: number): string {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

export function startOf(pid: number): number | null {
  try {
    const ms = Date.parse(execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim());
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

/**
 * Is `pid` the process recorded as running `script` (absolute) from `root`, started at `startMs`? The command line must
 * name a file of the script's name that resolves, against the root, to the recorded path (`bun scripts/demo.ts` and an
 * absolute path both do), and the start time must agree to 3 s. Fails closed when ps cannot say.
 */
export function isRecordedProcess(pid: number, root: string, script: string, startMs: number | undefined, command: string = commandOf(pid), started: number | null = startOf(pid)): boolean {
  if (!isAlive(pid) || startMs === undefined || started === null || Math.abs(started - startMs) > 3000) return false;
  return command.split(/\s+/).some((token) => basename(token) === basename(script) && resolve(root, token) === script);
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const sameDir = (a: string, b: string | undefined) => b !== undefined && real(a) === real(b);

/** The recorded launcher, only if it is verifiably that process (see isRecordedProcess) and the file is in its own checkout. Otherwise null. */
export function liveLauncher(file: string): LauncherState | null {
  const state = readState(file);
  if (!state || !sameDir(dirname(file), state.root)) return null;
  return isRecordedProcess(state.pid, state.root, state.script, state.procStartMs) ? state : null;
}

/** True when something accepts connections on 127.0.0.1:port. */
export function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (used: boolean) => {
      socket.destroy();
      resolve(used);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
}

/** Who listens on a port, for an error message. Best effort: empty when lsof cannot say. */
export function listenerOf(port: number): string {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    return pids.map((pid) => `pid ${pid}: ${commandOf(Number(pid)).slice(0, 100)}`).join("; ");
  } catch {
    return "";
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function waitFor<T>(what: string, probe: () => T | null | false | undefined | Promise<T | null | false | undefined>, timeoutMs: number, everyMs = 200): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}`);
    await sleep(everyMs);
  }
}
