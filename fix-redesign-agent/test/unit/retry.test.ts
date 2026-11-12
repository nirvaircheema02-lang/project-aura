import { describe, expect, it } from 'vitest';
import { classify, RepairableError, TerminalError, backoffDelayMs, RETRY_POLICY } from '../../src/retry.ts';

describe('classify', () => {
  it('classifies a RepairableError as REPAIRABLE', () => {
    expect(classify(new RepairableError('bad schema'))).toBe('REPAIRABLE');
  });

  it('classifies a TerminalError as TERMINAL', () => {
    expect(classify(new TerminalError('404'))).toBe('TERMINAL');
  });

  it('classifies a 429 as RETRYABLE', () => {
    expect(classify({ status: 429 })).toBe('RETRYABLE');
  });

  it('classifies a 500 as RETRYABLE', () => {
    expect(classify({ status: 503 })).toBe('RETRYABLE');
  });

  it('classifies a plain 404 as TERMINAL', () => {
    expect(classify({ status: 404 })).toBe('TERMINAL');
  });

  it('classifies an unknown error as RETRYABLE by default (never silently drops a real failure)', () => {
    expect(classify(new Error('mystery'))).toBe('RETRYABLE');
  });
});

describe('RETRY_POLICY (§2.4)', () => {
  it('deterministic: 3 attempts, 2s base', () => {
    expect(RETRY_POLICY.deterministic).toEqual({ maxAttempts: 3, baseDelayMs: 2000 });
  });
  it('ai: 2 attempts, 5s base', () => {
    expect(RETRY_POLICY.ai).toEqual({ maxAttempts: 2, baseDelayMs: 5000 });
  });
});

describe('backoffDelayMs', () => {
  it('grows with attempt number and includes jitter (non-deterministic within a bound)', () => {
    const policy = { maxAttempts: 5, baseDelayMs: 1000 };
    const samples = Array.from({ length: 20 }, () => backoffDelayMs(policy, 3));
    // attempt 3 -> exponential = 1000 * 2^2 = 4000; delay should be in [exponential/2, exponential]
    for (const d of samples) {
      expect(d).toBeGreaterThanOrEqual(2000);
      expect(d).toBeLessThanOrEqual(4000);
    }
    // jitter means not every sample is identical
    expect(new Set(samples).size).toBeGreaterThan(1);
  });
});
