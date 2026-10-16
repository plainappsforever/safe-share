// Sorts pulled job folders (<raw>/<job>/out/<neutral-name> + job.json) into <dir>/<profile>/ and runs the referee on each group.
// Also prints the timings recorded by the app. Exit 1 when any output fails.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = process.argv[2];
const raw = join(dir, 'raw');
const groups = { all: [], camera: [], location: [] };
const rows = [];
for (const job of readdirSync(raw)) {
  const jf = join(raw, job, 'job.json');
  if (!existsSync(jf)) continue;
  const j = JSON.parse(readFileSync(jf, 'utf8'));
  rows.push(j);
  if (!j.output || j.status !== 'clean') continue; // dirty / unverified copies are expected to fail the referee
  const src = join(raw, job, 'out', j.output);
  if (!existsSync(src)) { console.log(`MISSING ${j.source} -> ${j.output}`); groups.all.push(null); continue; }
  // For video and PDF "Keep camera settings" removes everything (D33), so it is checked like "Remove everything".
  const eff = j.profile === 'camera' && ['mp4', 'mov', 'pdf'].includes(j.format) ? 'all' : j.profile;
  const target = join(dir, eff);
  mkdirSync(target, { recursive: true });
  copyFileSync(src, join(target, j.output));
  groups[eff].push({ name: j.output, fixture: j.source });
}
console.log(`\n${rows.length} job(s) pulled from the device`);
for (const j of rows) {
  const ms = j.ms ?? {};
  console.log(`  ${String(j.source).padEnd(16)} ${String(j.format).padEnd(5)} ${String(j.profile).padEnd(8)} ${String(j.status).padEnd(11)} ${String(j.sizeIn).padStart(9)} B  inspect ${ms.inspect} ms · clean ${ms.clean} ms · verify ${ms.verify} ms · total ${ms.total} ms · readers ${j.readers}`);
}
let bad = groups.all.includes(null) ? 1 : 0;
for (const [profile, files] of Object.entries(groups)) {
  const list = files.filter(Boolean);
  if (!list.length) continue;
  const args = ['scripts/check-outputs.mjs', ...(profile === 'camera' ? ['--keep-camera'] : profile === 'location' ? ['--location'] : []), join(dir, profile)];
  for (const f of list) args.push('--map', `${f.name}=${f.fixture}`);
  console.log(`\n== referee: ${profile} (${list.length} file(s))`);
  const r = spawnSync('node', args, { encoding: 'utf8' });
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  if (r.status !== 0) bad = 1;
}
process.exit(bad);
