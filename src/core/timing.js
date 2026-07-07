import { performance } from "node:perf_hooks";

export const PIPELINE_TIMING_KEYS = [
  "resolveInputMs",
  "preflightMs",
  "ingestMs",
  "packZipMs",
  "publishMs",
  "issueFragmentMs",
  "validateMs",
  "readSmokeCheckMs"
];

export function emptyTimings() {
  return Object.fromEntries(PIPELINE_TIMING_KEYS.map((key) => [key, 0]));
}

export function elapsedMs(start) {
  return Math.round((performance.now() - start) * 100) / 100;
}

export async function timeStage(timings, key, fn) {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    timings[key] = Math.round(((timings[key] || 0) + performance.now() - start) * 100) / 100;
  }
}

export function preflightSummary(preflight) {
  const unresolved = (preflight?.issues || []).filter((issue) => !issue.fixed);
  return {
    repairs: preflight?.repairs?.length || 0,
    unresolved: unresolved.length,
    issues: preflight?.issues?.length || 0,
    status: preflight?.status || (preflight?.ok ? "ok" : "unknown")
  };
}
