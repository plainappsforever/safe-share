import { cleanWorkFolder, iosTmpDir, joinPath, pickerLeftovers, workFolderPath, type WorkFs } from './files';

/** In-memory directory tree: a set of directory paths and a set of file paths. */
function createFakeFs(dirs: string[], files: string[]) {
  const d = new Set(dirs);
  const f = new Set(files);
  const fs: WorkFs & { dirs: Set<string>; files: Set<string>; failRemove?: boolean } = {
    dirs: d,
    files: f,
    exists: (p) => d.has(p),
    removeDir(p) {
      if (fs.failRemove) throw new Error('permission denied');
      for (const x of [...d]) if (x === p || x.startsWith(p + '/')) d.delete(x);
      for (const x of [...f]) if (x.startsWith(p + '/')) f.delete(x);
    },
    makeDir(p) {
      d.add(p);
    },
  };
  return fs;
}

const CACHE = 'file:///data/cache/';

describe('work folder', () => {
  it('builds paths without doubled slashes', () => {
    expect(joinPath('file:///a/', 'b', 'c')).toBe('file:///a/b/c');
    expect(workFolderPath(CACHE)).toBe('file:///data/cache/work');
  });

  it('deletes leftover jobs and recreates an empty work folder', () => {
    const fs = createFakeFs(
      [`${CACHE}work`, `${CACHE}work/j1`, `${CACHE}work/j1/in`, `${CACHE}work/j1/out`],
      [`${CACHE}work/j1/in/a.jpg`, `${CACHE}work/j1/out/IMG_1.jpg`]
    );
    expect(cleanWorkFolder(fs, CACHE)).toEqual({ cleaned: true });
    expect([...fs.dirs]).toEqual([`${CACHE}work`]);
    expect(fs.files.size).toBe(0);
  });

  it('creates the folder when it does not exist yet, and is safe to run twice', () => {
    const fs = createFakeFs([], []);
    expect(cleanWorkFolder(fs, CACHE).cleaned).toBe(true);
    expect(cleanWorkFolder(fs, CACHE).cleaned).toBe(true);
    expect([...fs.dirs]).toEqual([`${CACHE}work`]);
  });

  it('leaves other cache content alone (dev debug-in files, sibling folders)', () => {
    const fs = createFakeFs(
      [`${CACHE}work`, `${CACHE}work/j1`, `${CACHE}debug-in`, `${CACHE}workshop`],
      [`${CACHE}work/j1/x`, `${CACHE}debug-in/a.jpg`, `${CACHE}workshop/y`]
    );
    cleanWorkFolder(fs, CACHE);
    expect(fs.files.has(`${CACHE}debug-in/a.jpg`)).toBe(true);
    expect(fs.files.has(`${CACHE}workshop/y`)).toBe(true);
    expect(fs.files.has(`${CACHE}work/j1/x`)).toBe(false);
  });

  it('never throws; reports the error instead', () => {
    const fs = createFakeFs([`${CACHE}work`], []);
    fs.failRemove = true;
    expect(cleanWorkFolder(fs, CACHE)).toEqual({ cleaned: false, error: 'permission denied' });
  });
});

describe('picker leftovers (review S10)', () => {
  it('iOS: the pickers\' cache folders and the document picker Inbox in tmp', () => {
    const cache = 'file:///var/mobile/Containers/Data/Application/ABC/Library/Caches/';
    expect(iosTmpDir(cache)).toBe('file:///var/mobile/Containers/Data/Application/ABC/tmp');
    expect(pickerLeftovers(cache, ['com.tim.safeshare-Inbox', 'other', 'WebKit'])).toEqual([
      'file:///var/mobile/Containers/Data/Application/ABC/Library/Caches/DocumentPicker',
      'file:///var/mobile/Containers/Data/Application/ABC/Library/Caches/ImagePicker',
      'file:///var/mobile/Containers/Data/Application/ABC/tmp/com.tim.safeshare-Inbox',
    ]);
  });

  it('Android: only the pickers\' cache folders', () => {
    const cache = 'file:///data/user/0/com.tim.safeshare/cache';
    expect(iosTmpDir(cache)).toBeNull();
    expect(pickerLeftovers(cache, null)).toEqual(['file:///data/user/0/com.tim.safeshare/cache/DocumentPicker', 'file:///data/user/0/com.tim.safeshare/cache/ImagePicker']);
  });
});
