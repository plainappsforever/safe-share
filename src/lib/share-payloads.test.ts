import { filePayloads, inboxFolderOf, isMediaStoreUri, requireOriginalUri, sharedFileName } from './share-payloads';

describe('filePayloads', () => {
  it('keeps files in order and drops text, links and duplicates', () => {
    const got = filePayloads([
      { value: 'content://media/external/images/media/31', shareType: 'image', mimeType: 'image/jpeg' },
      { value: 'hello', shareType: 'text', mimeType: 'text/plain' },
      { value: 'https://example.com/a.jpg', shareType: 'url', mimeType: 'text/plain' },
      { value: 'content://media/external/video/media/32', shareType: 'video', mimeType: 'video/mp4' },
      { value: 'content://media/external/images/media/31', shareType: 'image', mimeType: 'image/jpeg' },
      { value: 'file:///private/var/mobile/Containers/Shared/AppGroup/X/SafeShareInbox/U1/doc.pdf', shareType: 'file' },
    ]);
    expect(got.map((p) => p.value)).toEqual([
      'content://media/external/images/media/31',
      'content://media/external/video/media/32',
      'file:///private/var/mobile/Containers/Shared/AppGroup/X/SafeShareInbox/U1/doc.pdf',
    ]);
  });

  it('ignores a file type whose value is not a file or content URI', () => {
    expect(filePayloads([{ value: 'https://example.com/x.pdf', shareType: 'file' }])).toEqual([]);
    expect(filePayloads([{ value: '', shareType: 'image' }])).toEqual([]);
  });

  it('three files from SEND_MULTIPLE stay three jobs', () => {
    const uris = [31, 32, 33].map((n) => ({ value: `content://media/external/images/media/${n}`, shareType: 'image' }));
    expect(filePayloads(uris)).toHaveLength(3);
  });
});

describe('requireOriginalUri', () => {
  it('asks MediaStore for the original bytes', () => {
    expect(requireOriginalUri('content://media/external/images/media/31')).toBe('content://media/external/images/media/31?requireOriginal=1');
    expect(requireOriginalUri('content://media/external/images/media/31?x=1')).toBe('content://media/external/images/media/31?x=1&requireOriginal=1');
  });

  it('leaves other providers and already-marked URIs alone', () => {
    const photos = 'content://com.google.android.apps.photos.contentprovider/0/1/mediakey%3A/local%3A1/ORIGINAL/NONE/image%2Fjpeg/123';
    expect(requireOriginalUri(photos)).toBe(photos);
    expect(requireOriginalUri('content://media/external/images/media/31?requireOriginal=1')).toBe('content://media/external/images/media/31?requireOriginal=1');
    expect(isMediaStoreUri('file:///x.jpg')).toBe(false);
    expect(isMediaStoreUri('content://media/picker/0/com.android.providers.media.photopicker/media/19')).toBe(false); // P6: requireOriginal refused
    expect(requireOriginalUri('content://media/picker/0/com.android.providers.media.photopicker/media/19')).not.toMatch(/requireOriginal/);
  });
});

describe('inboxFolderOf', () => {
  it('finds the per-share folder the extension created', () => {
    expect(inboxFolderOf('file:///G/SafeShareInbox/ABC-1/IMG_0001.HEIC')).toBe('file:///G/SafeShareInbox/ABC-1');
    expect(inboxFolderOf('file:///G/Other/IMG_0001.HEIC')).toBeNull();
  });
});

describe('sharedFileName', () => {
  it('adds the extension from the MIME type to a MediaStore id', () => {
    expect(sharedFileName('content://media/external/images/media/31', 'image/jpeg')).toBe('31.jpg');
    expect(sharedFileName('content://media/external/video/media/32', 'video/quicktime')).toBe('32.mov');
  });

  it('keeps a real file name and decodes it', () => {
    expect(sharedFileName('file:///G/SafeShareInbox/U/IMG%200001.HEIC', 'image/heic')).toBe('IMG 0001.HEIC');
    expect(sharedFileName('content://com.example.files/doc%2Freport.pdf')).toBe('report.pdf');
    expect(sharedFileName('content://com.example/x', 'application/octet-stream')).toBe('x');
    expect(sharedFileName('content://com.android.providers.media.documents/document/image%3A19', 'image/jpeg')).toBe('19.jpg');
    expect(sharedFileName('content://com.android.externalstorage.documents/document/primary%3APictures%2Fss-photo.jpg', 'image/jpeg')).toBe('ss-photo.jpg');
  });
});
