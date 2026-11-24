import { assertBuiltMode, currentMode } from "./lib/mode";

// Runs once when the server starts. Next inlines NEXT_PUBLIC_FERNHILL_MODE into the server bundle at build time, so a
// build made in one mode and started as the other would run in the build's mode without saying so. The start scripts
// name the mode they intend in FERNHILL_RUN_MODE (not NEXT_PUBLIC_, so it is read at run time) and this refuses a mismatch.
export async function register(): Promise<void> {
  assertBuiltMode(process.env.FERNHILL_RUN_MODE, currentMode());
}
