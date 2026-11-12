import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Integration hooks launch real Chromium and load the real Design System registry
    // (D5 runs the DS workspace's checker scripts as child processes) — 10s is too tight.
    hookTimeout: 120_000,
    // The default 5 s is below Playwright's own limits (15 s per action, 30 s per navigation) and below what several Chromium tests need when
    // the machine is busy: the suite runs dozens of Chromium files in parallel, and tests that take 1-2.5 s alone (resolver-colours' registry
    // sweep, the backdrop and element-kind probes) then fail as an opaque "Test timed out in 5000ms" that passes when the file is rerun alone.
    // 60 s lets Playwright report its own, informative error first; tests that need more still say so explicitly. Assertions are untouched.
    testTimeout: 60_000,
    // Dozens of files launch their own Chromium: with one worker per core (8) a navigation to a LOCAL fixture server stalled the full 30 s
    // Playwright limit once in the full suite (html-serialize, 0.5 s alone), while every file passes alone and 3x in a row. Fewer concurrent
    // browsers keeps the suite reliable; no assertion or timeout is loosened for it.
    maxWorkers: 4,
  },
});
