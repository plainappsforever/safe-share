/** Runs the pipeline for jobs on the device and records the results in the job store. */
import { getJob, patchJob } from './jobs';
import { deviceIo } from './device-io';
import { joinPath } from './files';
import type { CancelToken } from './async-steps';
import { cleanFile, inspectFile, type Outcome, type Progress } from './pipeline';
import type { Profile } from '@/engine/profiles';
import { IS_DEV_BUILD } from './work';

/** Lets React paint ("Reading…", progress) before the synchronous engine blocks the JS thread. */
export const nextFrame = () => new Promise<void>((r) => setTimeout(r, 30));

export async function runInspect(id: string): Promise<void> {
  const job = getJob(id);
  if (!job || job.state !== 'new') return;
  patchJob(id, { state: 'reading' });
  await nextFrame();
  try {
    const { report, ms } = inspectFile(deviceIo, job.inputPath);
    patchJob(id, { state: 'ready', report, inspectMs: ms });
  } catch (e) {
    // The engine reports problems as `supported: false`; anything else is unexpected and must not look like "clean".
    patchJob(id, {
      state: 'ready',
      report: {
        format: 'unknown', size: job.size, supported: false, problem: 'corrupt', detail: e instanceof Error ? e.message : String(e),
        fields: [], containers: [], dataRanges: [], scanRanges: [], notes: [], findings: [], extras: [],
      },
    });
  }
}

/** Dev builds only (Settings → "Test: phone reader reads the original"): injects a reader-3 failure (D44). */
let injectPlatformOriginal = false;
export function setInjectPlatformOriginal(v: boolean): void {
  injectPlatformOriginal = IS_DEV_BUILD && v;
}
export function getInjectPlatformOriginal(): boolean {
  return injectPlatformOriginal;
}

/** Dev builds only (Settings → "Test: phone reader cannot read the copy"): reader 3 is pointed at a file that does not exist while it can still read the original → "Could not verify" (D44). */
let injectPlatformError = false;
export function setInjectPlatformError(v: boolean): void {
  injectPlatformError = IS_DEV_BUILD && v;
}
export function getInjectPlatformError(): boolean {
  return injectPlatformError;
}

/** Dev builds only (Settings → "Test: slow down the clean"): every chunk of the check waits 3 s, so Cancel can be tried on any file. */
let injectSlow = false;
export function setInjectSlow(v: boolean): void {
  injectSlow = IS_DEV_BUILD && v;
}
export function getInjectSlow(): boolean {
  return injectSlow;
}

/** Cancel tokens of the files being cleaned right now (one per job). */
const tokens = new Map<string, CancelToken>();

/** Stops the clean of one file at the next slice (a 1 MiB chunk, about 20 ms); the half-made copy is deleted. */
export function cancelClean(id: string): void {
  const t = tokens.get(id);
  if (t) t.cancelled = true;
}

/** Dev builds: how long the JS thread was ever blocked (the gap between 50 ms timer ticks) — proof that nothing freezes. */
function startLagMonitor(): () => number {
  if (!IS_DEV_BUILD) return () => 0;
  let last = Date.now();
  let worst = 0;
  const timer = setInterval(() => {
    const t = Date.now();
    worst = Math.max(worst, t - last - 50);
    last = t;
  }, 50);
  return () => {
    clearInterval(timer);
    return Math.max(0, worst);
  };
}

export interface CleanOptions {
  /** Settings → "Keep original file names". */
  keepName?: boolean;
}

/** Cleans and verifies one file. The job shows its progress while it runs; `cancelClean` stops it (the job then goes back to "ready"). */
export async function runClean(id: string, profile: Profile, opts: CleanOptions = {}): Promise<Outcome | undefined> {
  const job = getJob(id);
  if (!job) return undefined;
  const cancel: CancelToken = { cancelled: false };
  tokens.set(id, cancel);
  patchJob(id, { state: 'cleaning', profile, progress: { stage: 'copying', fraction: 0 }, outcome: undefined });
  await nextFrame();
  const stopLag = startLagMonitor();
  let lastPatch = 0;
  const onProgress = (p: Progress) => {
    const t = Date.now();
    if (p.stage === 'checking' && t - lastPatch < 100) return;
    lastPatch = t;
    patchJob(id, { progress: p });
  };
  const outcome = await cleanFile(deviceIo, {
    inputPath: job.inputPath, originalName: job.name, outDir: joinPath(job.dir, 'out'), profile, report: job.report,
    debugPlatformReadsInput: injectPlatformOriginal, debugPlatformCannotReadCopy: injectPlatformError, keepName: opts.keepName, cancel, onProgress, slowMs: injectSlow ? 3000 : undefined,
  });
  const maxLagMs = stopLag();
  if (IS_DEV_BUILD) outcome.ms.maxLag = maxLagMs;
  tokens.delete(id);
  if (outcome.status === 'cancelled') {
    patchJob(id, { state: 'ready', outcome: undefined, progress: undefined });
    return outcome;
  }
  patchJob(id, { state: 'done', outcome, profile, progress: undefined });
  if (IS_DEV_BUILD) {
    // Read by scripts/pull-outputs.sh to map the neutral output name back to its fixture and to record timings (dev only).
    try {
      deviceIo.writeText(
        joinPath(job.dir, 'job.json'),
        JSON.stringify({
          source: job.name, output: outcome.outputName ?? null, profile, status: outcome.status, format: job.report?.format,
          sizeIn: job.size, sizeOut: outcome.result?.bytesOut ?? null, removed: outcome.result?.removed.length ?? null,
          kept: outcome.result?.kept.length ?? null, readers: outcome.verdict?.readers ?? null,
          platform: outcome.platform ?? null, survivors: outcome.verdict?.survivors ?? [], problems: outcome.verdict?.problems ?? [],
          injected: injectPlatformOriginal,
          ms: { inspect: job.inspectMs ?? null, ...outcome.ms }, maxLagMs, message: outcome.message ?? null,
        })
      );
      // Raw reader-3 output of the copy (or of the original when injected): the Jest samples in test/platform/ come from these.
      if (outcome.platformRaw) deviceIo.writeText(joinPath(job.dir, 'platform.json'), outcome.platformRaw);
    } catch {
      // diagnostics only
    }
  }
  return outcome;
}
