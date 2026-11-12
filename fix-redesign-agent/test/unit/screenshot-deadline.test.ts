import { describe, expect, it } from 'vitest';
import { withDeadline } from '../../src/t-layer/screenshot.ts';

describe('withDeadline — a capture that never returns cannot park the pipeline', () => {
  it('REGRESSION: rejects with a specific error when the work never settles', async () => {
    const never = new Promise<string>(() => {});
    await expect(withDeadline(never, 30, 'R7 after-crop e130')).rejects.toThrow(/R7 after-crop e130: no result within 30 ms — skipped/);
  });
  it('passes the result through when the work settles in time', async () => {
    await expect(withDeadline(Promise.resolve('ok'), 1000, 'x')).resolves.toBe('ok');
  });
  it("propagates the work's own error unchanged", async () => {
    await expect(withDeadline(Promise.reject(new Error('boom')), 1000, 'x')).rejects.toThrow('boom');
  });
});
