import { useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Card } from '@/components/ui';
import type { MetadataReport } from '@/engine/inspect';
import { pickFiles } from '@/lib/intake';
import { patchJob, type Job } from '@/lib/jobs';
import { coordinatesBlanked, locationState } from '@/lib/location';
import { askForMediaLocation, mediaLocationApplies, mediaLocationState, type MediaLocationState } from '@/lib/media-location';
import { rereadOriginal } from '@/lib/share-in';
import { isMediaStoreUri } from '@/lib/share-payloads';
import { strings } from '@/lib/strings';
import { isImage } from '@/lib/summary';

/**
 * Android only (SPEC F2, D17, P4-4): says honestly that the copy Safe Share received may have had its location blanked
 * by Android, and offers "Show the original location" — the only place Safe Share asks for ACCESS_MEDIA_LOCATION.
 * Shown when the bytes contain blank GPS coordinates, or (for photos from the picker or a share) no location at all.
 */
export function LocationCard({ job, report }: { job: Job; report: MetadataReport }) {
  const db = useSQLiteContext();
  const router = useRouter();
  const [perm, setPerm] = useState<MediaLocationState | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const blanked = coordinatesBlanked(report.fields);
  const photoFromSystem = isImage(report.format) && (job.origin === 'share' || job.origin === 'picker');
  const relevant = mediaLocationApplies() && report.supported && (blanked || (locationState(report.fields) === 'none' && photoFromSystem));

  useEffect(() => {
    if (relevant) mediaLocationState(db).then(setPerm);
  }, [db, relevant]);

  if (!relevant || perm === null) return null;

  async function reveal() {
    setBusy(true);
    try {
      const next = await askForMediaLocation(db);
      setPerm(next);
      if (next === 'refused') setMessage(strings.location.refused);
      if (next !== 'granted') return;
      if (await rereadOriginal(job)) {
        setMessage(null);
        // Inspect reads the new copy; if it is still blank, the card comes back with "still hidden".
        patchJob(job.id, { state: 'new', report: undefined, inspectMs: undefined });
      } else setMessage(strings.location.rereadFailed);
    } finally {
      setBusy(false);
    }
  }

  // The permission only helps where Safe Share can read the photo again with requireOriginal: a photo shared as a
  // MediaStore URI. The photo picker blanks the GPS whatever the app holds and Android refuses requireOriginal on picker
  // URIs (V1_LOG P5/P6): for picker copies the card offers the Files picker instead, which hands over the original (D45).
  const reReadable = job.origin === 'share' && !!job.sourceUri && isMediaStoreUri(job.sourceUri);
  const canAsk = perm === 'ask' && reReadable;
  const fromPicker = job.origin === 'picker';

  async function chooseInFiles() {
    setBusy(true);
    try {
      const jobs = await pickFiles(true);
      if (jobs.length === 1) router.replace({ pathname: '/inspect', params: { id: jobs[0].id } });
      else if (jobs.length > 1) router.replace('/batch');
    } catch {
      setMessage(strings.home.pickFailed);
    } finally {
      setBusy(false);
    }
  }

  const text =
    message ??
    (fromPicker ? strings.location.pickerHint
    : !reReadable ? null
    : perm === 'granted' ? strings.location.stillHidden
    : perm === 'refused' ? strings.location.refused
    : null);
  return (
    <Card testID="location-hidden">
      <ThemedText type="smallBold">{strings.location.hiddenTitle}</ThemedText>
      <ThemedText type="small" testID="location-hidden-text">
        {blanked ? strings.location.emptyInCopy : strings.location.noneInCopy}
      </ThemedText>
      {canAsk && !message ? (
        <Button testID="show-original-location" variant="secondary" label={strings.location.showOriginal} disabled={busy} onPress={reveal} />
      ) : null}
      {fromPicker ? (
        <Button testID="pick-in-files" variant="secondary" label={strings.location.chooseInFiles} disabled={busy} onPress={chooseInFiles} />
      ) : null}
      {text ? (
        <ThemedText type="small" themeColor="textSecondary" testID="location-hidden-hint">
          {text}
        </ThemedText>
      ) : null}
    </Card>
  );
}
