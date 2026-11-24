"use client";

import { useMemo } from "react";
import { bearerFetch, sharedAuth } from "../lib/browser-auth";
import { currentMode } from "../lib/mode";

/**
 * The fetch the panels use for this app's own /api routes. Mock mode: the plain `fetch`, looked up on every call as
 * before. Deployment mode: one that attaches the signed-in person's access token.
 */
export function useApiFetch(): typeof globalThis.fetch {
  return useMemo(() => (currentMode() === "deployment" ? bearerFetch(() => sharedAuth().getToken()) : (...args) => globalThis.fetch(...args)), []);
}
