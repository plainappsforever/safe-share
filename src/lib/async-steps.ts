/**
 * Runs an engine step generator (`verifySteps`, `rangesEqualSteps`) in short slices so the JS thread is free between
 * them: the screen repaints, the progress bar moves and Cancel can be tapped (P7, closes P4-6). The steps themselves are
 * the engine's own code; this only decides when to pause.
 */
import type { StepProgress } from '@/engine/io';

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

/** A flag the UI sets; the runner looks at it between slices. */
export interface CancelToken {
  cancelled: boolean;
}

export interface SliceOptions {
  cancel?: CancelToken;
  onProgress?: (p: StepProgress) => void;
  /** Longest time to work before handing the thread back (default 80 ms). */
  sliceMs?: number;
  /** Minimum time between progress reports (default 100 ms). */
  reportMs?: number;
  now?: () => number;
  /** Hands the thread back (default: a macrotask, so React can render and touches are handled). */
  pause?: () => Promise<void>;
}

// A real timer, not setImmediate: a loop of immediates starves React's rendering (measured on Android: the progress bar never painted). On Android a
// zero timer waits for about one frame, which is why slices are long enough (80 ms) for that wait to cost little.
const macrotask = () => new Promise<void>((r) => setTimeout(r, 0));

/** The longest stretch the runner held the thread without pausing is reported in `longestSliceMs`. */
export async function runInSlices<T>(gen: Generator<StepProgress, T, void>, opts: SliceOptions = {}): Promise<{ value: T; longestSliceMs: number; pauses: number }> {
  const now = opts.now ?? Date.now;
  const pause = opts.pause ?? macrotask;
  const sliceMs = opts.sliceMs ?? 80;
  const reportMs = opts.reportMs ?? 100;
  let sliceStart = now();
  let lastReport = -Infinity;
  let longest = 0;
  let pauses = 0;
  let last: StepProgress | null = null;
  for (;;) {
    if (opts.cancel?.cancelled) {
      gen.return(undefined as never);
      throw new CancelledError();
    }
    const r = gen.next();
    if (r.done) {
      longest = Math.max(longest, now() - sliceStart);
      return { value: r.value, longestSliceMs: longest, pauses };
    }
    last = r.value;
    const t = now();
    if (t - sliceStart >= sliceMs) {
      longest = Math.max(longest, t - sliceStart);
      if (last && t - lastReport >= reportMs) {
        lastReport = t;
        opts.onProgress?.(last);
      }
      await pause();
      pauses++;
      sliceStart = now();
    }
  }
}
