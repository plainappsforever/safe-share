/** @jest-environment node */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openNodeByteFile } from '../../test/node-byte-file';

import { ENGINE_SMOKETEST_OK, runEngineSmokeTest } from './engine-smoketest';

it('engine smoke test (the dev-only device check) passes on Node', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-smoke-'));
  let n = 0;
  try {
    const result = runEngineSmokeTest((initial) => {
      const p = join(dir, `f${n++}.bin`);
      writeFileSync(p, initial);
      return openNodeByteFile(p, true);
    });
    expect(result).toBe(ENGINE_SMOKETEST_OK);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
