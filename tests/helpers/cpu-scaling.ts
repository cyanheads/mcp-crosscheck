/**
 * @file tests/helpers/cpu-scaling.ts
 * `expectLinearCpuTime`: the CPU-time scaling check for adapter text scanners.
 */
import { expect } from 'bun:test';

/** Input sizes, in UTF-16 code units, doubling over a 64× span. */
const SCALING_SIZES = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
const SCALING_REPEATS = 3;
/** Calls per baseline measurement; larger sizes run proportionally fewer, down to one. */
const BASELINE_BATCH = 8;

/** This thread's CPU time per call of `call(input)`, in microseconds, over `batch` calls. */
function cpuPerCall(call: (input: string) => unknown, input: string, batch: number): number {
  const start = process.threadCpuUsage();
  for (let index = 0; index < batch; index += 1) call(input);
  const used = process.threadCpuUsage(start);
  return (used.user + used.system) / batch;
}

/**
 * Assert that `call` costs CPU time linear in the length of `shape(size)`.
 * Each size from 5k to 320k code units is timed per call beside the 5k
 * baseline, and the least growth over several repeats is checked before the
 * next size runs, so a quadratic fails at the 20k step within seconds: under
 * 3× the size ratio at every step, which also holds the 64× span under 192
 * (a quadratic reaches 4,096), and under one CPU second for the largest call.
 */
export function expectLinearCpuTime(
  shape: (size: number) => string,
  call: (input: string) => unknown,
): void {
  const [base = 0] = SCALING_SIZES;
  const largest = SCALING_SIZES.at(-1) ?? base;
  const baseline = shape(base);
  const batchFor = (size: number) => Math.max(1, Math.round((BASELINE_BATCH * base) / size));
  let leastLargest = Number.POSITIVE_INFINITY;
  for (const size of SCALING_SIZES.slice(1)) {
    const input = shape(size);
    let growth = Number.POSITIVE_INFINITY;
    for (let repeat = 0; repeat < SCALING_REPEATS; repeat += 1) {
      const before = cpuPerCall(call, baseline, BASELINE_BATCH);
      const at = cpuPerCall(call, input, batchFor(size));
      growth = Math.min(growth, at / Math.max(before, 1e-3));
      if (size === largest) leastLargest = Math.min(leastLargest, at);
    }
    expect(growth).toBeLessThan((3 * size) / base);
  }
  expect(leastLargest).toBeLessThan(1_000_000);
}
