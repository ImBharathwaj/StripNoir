import { apiPost } from './apiClient';
import { buildMediaPublicReadPath, publicObjectUrl } from './publicMediaUrl';

export type UploadUrlResponse = {
  objectKey: string;
  uploadUrl: string;
  storageBucket: string;
  storageProvider: string;
};

/**
 * Presigned PUT to object store, then register `media_asset` row.
 */
export async function uploadUserMedia(file: File, mediaType: 'image' | 'video' | 'audio'): Promise<{ id: string; publicUrl: string }> {
  const contentType = file.type || 'application/octet-stream';
  const up = await apiPost<UploadUrlResponse>('/media/upload-url', { contentType });
  let put: Response;
  try {
    put = await fetch(up.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: file
    });
  } catch (err: unknown) {
    let origin = '';
    try {
      origin = new URL(up.uploadUrl).origin;
    } catch {
      // ignore
    }
    const hint =
      'Browser could not reach object storage (often missing MinIO CORS or wrong MINIO_PUBLIC_URL). ' +
      'Run infra stack so minio-init applies bucket CORS, ensure MinIO is reachable at ' +
      (origin || 'the presigned URL host') +
      ', and set MINIO_PUBLIC_URL to that base if you use a non-default host/port.';
    const base = err instanceof Error ? err.message : String(err);
    throw new Error(`${base}. ${hint}`);
  }
  if (!put.ok) {
    throw new Error(`upload failed (${put.status})`);
  }
  const publicUrl =
    typeof window !== 'undefined'
      ? buildMediaPublicReadPath(up.storageBucket, up.objectKey)
      : publicObjectUrl(up.storageBucket, up.objectKey);
  const done = await apiPost<{ media: { id: string } }>('/media/complete', {
    mediaType,
    objectKey: up.objectKey,
    mimeType: contentType,
    byteSize: file.size,
    originalFilename: file.name,
    storageBucket: up.storageBucket,
    storageProvider: up.storageProvider,
    metadata: { publicUrl, playbackUrl: publicUrl }
  });
  const id = done?.media?.id;
  if (!id) throw new Error('media complete returned no id');
  return { id, publicUrl };
}
