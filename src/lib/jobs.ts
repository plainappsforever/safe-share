/** In-memory job list (SPEC F6, D23: nothing about cleaned files is ever stored). A job = one file going through the flow. */
import { useSyncExternalStore } from 'react';

import type { MetadataReport } from '@/engine/inspect';
import type { Profile } from '@/engine/profiles';

import type { Outcome, Progress } from './pipeline';

export type JobState = 'new' | 'reading' | 'ready' | 'cleaning' | 'done';

export interface Job {
  id: string;
  /** Name shown to the user (the original name of the received file). */
  name: string;
  /** `<cache>/work/<id>` — deleted with the job. */
  dir: string;
  inputPath: string;
  size: number;
  /** How the file came in: the Android media-location step re-reads only what it can reach again (P5). */
  origin?: 'picker' | 'files' | 'share' | 'debug';
  /** Share-in on Android: the content URI the file was copied from (readable while this app task lives). */
  sourceUri?: string;
  state: JobState;
  report?: MetadataReport;
  inspectMs?: number;
  profile?: Profile;
  outcome?: Outcome;
  /** While cleaning: which stage and how far (P7). */
  progress?: Progress;
}

let jobs: readonly Job[] = [];
const listeners = new Set<() => void>();

function set(next: readonly Job[]) {
  jobs = next;
  listeners.forEach((l) => l());
}

export function getJobs(): readonly Job[] {
  return jobs;
}

export function getJob(id: string | undefined): Job | undefined {
  return jobs.find((j) => j.id === id);
}

export function addJobs(added: Job[]) {
  set([...jobs, ...added]);
}

export function patchJob(id: string, patch: Partial<Job>) {
  set(jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)));
}

export function clearJobs() {
  set([]);
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useJobs(): readonly Job[] {
  return useSyncExternalStore(subscribe, getJobs, getJobs);
}

export function useJob(id: string | undefined): Job | undefined {
  const all = useJobs();
  return all.find((j) => j.id === id);
}

let counter = 0;
export function newJobId(): string {
  counter += 1;
  return `j${counter}-${Math.random().toString(36).slice(2, 7)}`;
}
