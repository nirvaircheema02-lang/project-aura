// Vendored verbatim from audit-agent src/ds/findings.ts (2026-09-18) — see docs/ARCHITECTURE.md Decision Log #3. Only import paths changed.
/**
 * A source inconsistency discovered while reading the Design System —
 * preserved and reported, never silently fixed (explicit build instruction).
 * Every D-module that can hit a contradiction in the real DS content
 * accumulates these into its output rather than picking a winner quietly.
 */
export interface DSFinding {
  module: 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6';
  severity: 'info' | 'warning';
  summary: string;
  detail: string;
  /** File(s) this finding is about, relative to designSystemPath where possible. */
  sources: string[];
}

export function finding(f: DSFinding): DSFinding {
  return f;
}
