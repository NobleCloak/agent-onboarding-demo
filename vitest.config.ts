import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname) } },
  test: {
    // A developer's .env.local may select deployment mode; the suite runs in mock mode unless a test says otherwise.
    env: { NEXT_PUBLIC_FERNHILL_MODE: "mock" },
    include: ["scripts/**/*.test.ts", "lib/**/*.test.ts", "src/**/*.test.ts", "components/**/*.test.{ts,tsx}", "proxy.test.ts"],
    exclude: ["e2e/**", "node_modules/**"],
  },
});
