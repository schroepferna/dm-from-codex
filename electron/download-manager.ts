import { net } from 'electron';
import type { WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  BATCH_PRESIGNED_URL_LIMIT,
  CHUNK_SIZE_BYTES,
  DEFAULT_CHUNK_CONCURRENCY,
  DEFAULT_FILE_CONCURRENCY,
  DEFAULT_URL_BATCH_CONCURRENCY,
  DISK_SPACE_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  PART_MANIFEST_VERSION
} from './constants';
import {
  Deferred,
  DirectDownloadSource,
  DownloadChunk,
  DownloadEvent,
  DownloadJob,
  DownloadStartRequest,
  DownloadUrlResult,
  NativeFileInput,
  PartManifest,
  PartialDownloadState,
  PresignedDownloadUrlResponse,
  ScanDownloadRequest
} from './models';
import { exchangeSessionForToken, verifyToken } from './auth-api';
import { getAvailableSpace } from './native-fs';
import { ensurePackageTargetDir, resolveInside, resolvePackageTargetDir, statIfExists } from './paths';
import { assertHttpUrl, fetchWithTimeout, formatBytes, stringOrEmpty, trimTrailingSlash, withTimeout } from './utils';

const jobs = new Map<string, DownloadJob>();

export function startDownloadJob(sender: WebContents, request: DownloadStartRequest): { jobId: string } {
  validateDownloadStartRequest(request);
  console.info(
    `Starting download job for package ${request.packageId}; files ${request.files.map((file) => file.packageFileId).join(', ')}.`
  );

  const job: DownloadJob = {
    id: randomUUID(),
    request,
    abortController: new AbortController(),
    sender,
    heartbeatTimer: null,
    paused: false,
    pauseWaiters: [],
    activeFiles: new Map(),
    downloadUrls: new Map()
  };

  jobs.set(job.id, job);
  sendDownloadEvent(job, {
    status: 'queued',
    message: `Queued package ${request.packageId}, file${request.files.length === 1 ? '' : 's'} ${request.files.map((file) => file.packageFileId).join(', ')}.`
  });
  void runDownloadJob(job).finally(() => jobs.delete(job.id));
  return { jobId: job.id };
}

export function pauseDownloadJobById(jobId: string): void {
  const job = jobs.get(jobId);
  if (job) {
    pauseDownloadJob(job);
  }
}

export function resumeDownloadJobById(jobId: string): void {
  const job = jobs.get(jobId);
  if (job) {
    resumeDownloadJob(job);
  }
}

export function cancelDownloadJob(jobId: string): void {
  const job = jobs.get(jobId);
  if (job) {
    job.abortController.abort();
    sendDownloadEvent(job, { status: 'cancelled', message: 'Download cancelled.' });
  }
}

export function cancelAllDownloadJobs(): void {
  for (const job of jobs.values()) {
    job.abortController.abort();
  }
}

export async function scanDownloadDirectory(request: ScanDownloadRequest): Promise<unknown[]> {
  if (!request?.targetDir || !Number.isFinite(Number(request.packageId)) || !Array.isArray(request.files)) {
    throw new Error('A download directory, package id, and file list are required.');
  }

  if (!stringOrEmpty(request.packageName).trim()) {
    throw new Error('A package name is required.');
  }

  const packageTargetDir = await ensurePackageTargetDir(request.targetDir, Number(request.packageId), request.packageName);
  return Promise.all(request.files.map(async (file) => {
    const filePath = resolveInside(packageTargetDir, file.downloadAlias);

    try {
      const fileStat = await stat(filePath);
      return {
        packageFileId: file.packageFileId,
        downloadAlias: file.downloadAlias,
        exists: true,
        complete: file.fileSize > 0 ? fileStat.size === file.fileSize : true,
        size: fileStat.size,
        modifiedAt: fileStat.mtime.toISOString(),
        path: filePath
      };
    } catch (error) {
      const partial = await getPartialDownloadScanResult(filePath, file);
      if (partial) {
        return partial;
      }

      const message = error instanceof Error ? error.message : 'File not found.';
      return {
        packageFileId: file.packageFileId,
        downloadAlias: file.downloadAlias,
        exists: false,
        complete: false,
        size: null,
        modifiedAt: null,
        path: null,
        error: message
      };
    }
  }));
}

async function runDownloadJob(job: DownloadJob): Promise<void> {
  const {
    files,
    fileConcurrency = DEFAULT_FILE_CONCURRENCY,
    tokenConcurrency = DEFAULT_URL_BATCH_CONCURRENCY
  } = job.request;

  try {
    for (const file of files) {
      sendDownloadEvent(job, {
        packageFileId: file.packageFileId,
        downloadAlias: file.downloadAlias,
        status: 'queued',
        receivedBytes: 0,
        totalBytes: file.fileSize
      });
    }

    const packageTargetDir = await ensurePackageTargetDir(job.request.targetDir, job.request.packageId, job.request.packageName);
    await mkdir(packageTargetDir, { recursive: true });
    sendDownloadEvent(job, { status: 'queued', message: 'Checking existing files.' });
    const filesToDownload = await prepareDownloadFiles(job, files);

    if (filesToDownload.length === 0) {
      sendDownloadEvent(job, { status: 'job-complete', message: 'Download complete.' });
      return;
    }

    sendDownloadEvent(job, { status: 'queued', message: 'Checking disk space.' });
    await withTimeout(checkDownloadDiskSpace(job, filesToDownload), DISK_SPACE_TIMEOUT_MS, 'Checking disk space timed out before the download could start.');

    sendDownloadEvent(job, {
      status: 'fetching-token',
      message: `Preparing download URLs for ${filesToDownload.length} file${filesToDownload.length === 1 ? '' : 's'}.`
    });
    startDownloadHeartbeat(job);
    const urlPrefetch = prefetchDownloadUrls(job, filesToDownload, clamp(tokenConcurrency, 1, 8));
    const failedFiles: NativeFileInput[] = [];

    await runLimited(filesToDownload, clamp(fileConcurrency, 1, 6), async (file) => {
      await waitForResume(job);

      if (job.abortController.signal.aborted) {
        throw new Error('Download cancelled.');
      }

      try {
        await downloadOneFile(job, file);
      } catch (error) {
        if (job.abortController.signal.aborted) {
          throw error;
        }

        failedFiles.push(file);
      }
    });
    await urlPrefetch;

    if (failedFiles.length > 0) {
      const failedNames = failedFiles
        .slice(0, 5)
        .map((file) => file.downloadAlias)
        .join(', ');
      const remainingCount = failedFiles.length - 5;
      const message = failedFiles.length === 1
        ? `1 file failed to download: ${failedNames}.`
        : `${failedFiles.length} files failed to download: ${failedNames}${remainingCount > 0 ? ` and ${remainingCount} more` : ''}.`;
      sendDownloadEvent(job, { status: 'error', message });
      return;
    }

    sendDownloadEvent(job, { status: 'job-complete', message: 'Download complete.' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Download failed.';
    const wasCancelled = job.abortController.signal.aborted;
    if (!wasCancelled) {
      job.abortController.abort();
    }
    sendDownloadEvent(job, { status: wasCancelled ? 'cancelled' : 'error', message: wasCancelled ? 'Download cancelled.' : message });
  } finally {
    job.paused = false;
    releasePauseWaiters(job);
    job.activeFiles.clear();
    job.downloadUrls.clear();

    if (job.heartbeatTimer) {
      clearInterval(job.heartbeatTimer);
      job.heartbeatTimer = null;
    }
  }
}

async function prepareDownloadFiles(job: DownloadJob, files: NativeFileInput[]): Promise<NativeFileInput[]> {
  const pendingFileIds = new Set<number>();

  await runLimited(files, 16, async (file) => {
    const finalPath = resolveInside(resolvePackageTargetDir(job.request.targetDir, job.request.packageId, job.request.packageName), file.downloadAlias);
    const existing = await statIfExists(finalPath);
    if (existing && file.fileSize > 0 && existing.size === file.fileSize) {
      sendDownloadEvent(job, {
        packageFileId: file.packageFileId,
        downloadAlias: file.downloadAlias,
        status: 'skipped',
        receivedBytes: existing.size,
        totalBytes: file.fileSize,
        path: finalPath,
        message: 'Already downloaded.'
      });
      return;
    }

    pendingFileIds.add(file.packageFileId);
  });

  return files.filter((file) => pendingFileIds.has(file.packageFileId));
}

async function prefetchDownloadUrls(job: DownloadJob, files: NativeFileInput[], concurrency: number): Promise<void> {
  const deferredByFileId = new Map<number, Deferred<DownloadUrlResult>>();

  for (const file of files) {
    const deferred = createDeferred<DownloadUrlResult>();
    deferredByFileId.set(file.packageFileId, deferred);
    job.downloadUrls.set(file.packageFileId, deferred.promise);
  }

  await runLimited(chunkItems(files, BATCH_PRESIGNED_URL_LIMIT), concurrency, async (batch) => {
    try {
      await waitForResume(job);

      if (job.abortController.signal.aborted) {
        throw new Error('Download cancelled.');
      }

      const urls = await fetchBatchPresignedUrls(job, batch);
      const urlByFileId = new Map(urls.map((url) => [url.package_file_id, url]));
      for (const file of batch) {
        const deferred = deferredByFileId.get(file.packageFileId);
        const url = urlByFileId.get(file.packageFileId);
        if (!deferred) {
          continue;
        }

        if (url) {
          deferred.resolve({ ok: true, url });
        } else {
          deferred.resolve({
            ok: false,
            error: new Error(`Presigned URL response did not include ${file.downloadAlias}.`)
          });
        }
      }
    } catch (error) {
      for (const file of batch) {
        deferredByFileId.get(file.packageFileId)?.resolve({ ok: false, error });
      }
    }
  });
}

async function getDownloadUrl(job: DownloadJob, file: NativeFileInput): Promise<PresignedDownloadUrlResponse> {
  const prefetched = job.downloadUrls.get(file.packageFileId);
  if (!prefetched) {
    const [url] = await fetchBatchPresignedUrls(job, [file]);
    if (!url) {
      throw new Error(`Presigned URL response did not include ${file.downloadAlias}.`);
    }

    return url;
  }

  const result = await prefetched;
  if (result.ok) {
    return result.url;
  }

  throw result.error instanceof Error ? result.error : new Error('Presigned URL request failed.');
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
}

function chunkItems<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

async function checkDownloadDiskSpace(job: DownloadJob, files: NativeFileInput[]): Promise<void> {
  const remainingBytes = new Array<number>(files.length).fill(0);

  await runLimited(files.map((file, index) => ({ file, index })), 16, async ({ file, index }) => {
    remainingBytes[index] = await getRemainingDownloadBytes(job, file);
  });

  const requiredBytes = remainingBytes.reduce((total, bytes) => total + bytes, 0);
  const space = await getAvailableSpace(job.request.targetDir);

  if (space.availableBytes >= requiredBytes) {
    return;
  }

  throw new Error(
    `Not enough disk space in ${job.request.targetDir}. ` +
    `Required ${formatBytes(requiredBytes)}, available ${formatBytes(space.availableBytes)}.`
  );
}

function pauseDownloadJob(job: DownloadJob): void {
  if (job.paused || job.abortController.signal.aborted) {
    return;
  }

  job.paused = true;
  sendDownloadEvent(job, { status: 'paused', isPaused: true, message: 'Download paused.' });

  for (const file of job.activeFiles.values()) {
    sendDownloadEvent(job, {
      packageFileId: file.packageFileId,
      downloadAlias: file.downloadAlias,
      status: 'paused',
      isPaused: true,
      totalBytes: file.fileSize,
      message: 'Paused.'
    });
  }
}

function resumeDownloadJob(job: DownloadJob): void {
  if (!job.paused || job.abortController.signal.aborted) {
    return;
  }

  job.paused = false;
  releasePauseWaiters(job);
  sendDownloadEvent(job, { status: 'downloading', isPaused: false, message: 'Download resumed.' });

  for (const file of job.activeFiles.values()) {
    sendDownloadEvent(job, {
      packageFileId: file.packageFileId,
      downloadAlias: file.downloadAlias,
      status: 'downloading',
      isPaused: false,
      totalBytes: file.fileSize,
      message: 'Resumed.'
    });
  }
}

function waitForResume(job: DownloadJob): Promise<void> {
  if (job.abortController.signal.aborted) {
    return Promise.reject(new Error('Download cancelled.'));
  }

  if (!job.paused) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const resolveWhenReady = () => {
      job.abortController.signal.removeEventListener('abort', rejectWhenCancelled);
      resolve();
    };
    const rejectWhenCancelled = () => {
      job.pauseWaiters = job.pauseWaiters.filter((waiter) => waiter !== resolveWhenReady);
      reject(new Error('Download cancelled.'));
    };

    job.pauseWaiters.push(resolveWhenReady);
    job.abortController.signal.addEventListener('abort', rejectWhenCancelled, { once: true });
  });
}

function releasePauseWaiters(job: DownloadJob): void {
  const waiters = job.pauseWaiters.splice(0);
  for (const waiter of waiters) {
    waiter();
  }
}

function startDownloadHeartbeat(job: DownloadJob): void {
  if (!job.request.sessionId) {
    return;
  }

  job.heartbeatTimer = setInterval(() => {
    void keepDownloadSessionAlive(job)
      .catch((error) => {
        const message = error instanceof Error ? error.message : 'Session heartbeat failed.';
        sendDownloadEvent(job, { status: 'error', message });
        job.abortController.abort();
      });
  }, HEARTBEAT_INTERVAL_MS);
}

async function keepDownloadSessionAlive(job: DownloadJob): Promise<void> {
  if (!job.request.sessionId) {
    return;
  }

  await verifySessionForJob(job);
}

async function refreshJobAuthToken(job: DownloadJob): Promise<void> {
  const { host, sessionId } = job.request;
  if (!sessionId) {
    return;
  }

  const token = await exchangeSessionForToken(host, sessionId);
  const verification = await verifyToken(host, token);

  if (!verification.valid) {
    throw new Error(verification.errorMessage || 'Token verification failed.');
  }

  job.request.authToken = token;
}

async function verifySessionForJob(job: DownloadJob): Promise<void> {
  const { host, authToken, sessionId } = job.request;
  if (!sessionId) {
    return;
  }

  const response = await fetchWithTimeout(`${trimTrailingSlash(host)}/api/ras/verifySession`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ jSessionId: sessionId }),
    signal: job.abortController.signal
  });

  if (!response.ok) {
    throw new Error(`Session heartbeat failed with HTTP ${response.status}.`);
  }

  const body = await response.json() as { valid?: boolean; errorMessage?: string | null };
  if (!body.valid) {
    throw new Error(body.errorMessage || 'Session is invalid or expired.');
  }

}

async function downloadOneFile(job: DownloadJob, file: NativeFileInput): Promise<void> {
  job.activeFiles.set(file.packageFileId, file);

  try {
    const finalPath = resolveInside(resolvePackageTargetDir(job.request.targetDir, job.request.packageId, job.request.packageName), file.downloadAlias);
    await mkdir(path.dirname(finalPath), { recursive: true });

    const existing = await statIfExists(finalPath);
    if (existing && file.fileSize > 0 && existing.size === file.fileSize) {
      sendDownloadEvent(job, {
        packageFileId: file.packageFileId,
        downloadAlias: file.downloadAlias,
        status: 'skipped',
        receivedBytes: existing.size,
        totalBytes: file.fileSize,
        path: finalPath,
        message: 'Already downloaded.'
      });
      return;
    }

    await waitForResume(job);
    sendDownloadEvent(job, {
      packageFileId: file.packageFileId,
      downloadAlias: file.downloadAlias,
      status: 'fetching-token',
      receivedBytes: 0,
      totalBytes: file.fileSize,
      message: ''
    });

    const presignedUrl = await getDownloadUrl(job, file);
    assertHttpUrl(presignedUrl.downloadURL);
    await waitForResume(job);
    const downloadSource = getDirectDownloadSource(presignedUrl.downloadURL);

    const totalBytes = file.fileSize > 0
      ? file.fileSize
      : await fetchPresignedDownloadSize(presignedUrl.downloadURL, file, job.abortController.signal);

    const tempPath = `${finalPath}.part`;
    await waitForResume(job);
    const partialState = totalBytes > 0
      ? await preparePartialDownload(tempPath, file, totalBytes, downloadSource)
      : null;

    sendDownloadEvent(job, {
      packageFileId: file.packageFileId,
      downloadAlias: file.downloadAlias,
      status: 'downloading',
      receivedBytes: partialState?.completedBytes ?? 0,
      totalBytes,
      path: finalPath,
      message: partialState && partialState.completedBytes > 0 ? `Resuming from ${formatBytes(partialState.completedBytes)}.` : undefined
    });

    if (totalBytes === 0) {
      await waitForResume(job);
      const handle = await open(tempPath, 'w');
      await handle.close();
    } else {
      await downloadPresignedUrlObject(job, presignedUrl.downloadURL, tempPath, file, totalBytes, partialState);
      await ensureFileSize(tempPath, totalBytes);
    }

    await waitForResume(job);
    await rm(finalPath, { force: true });
    await rename(tempPath, finalPath);
    await rm(getPartManifestPath(tempPath), { force: true });

    sendDownloadEvent(job, {
      packageFileId: file.packageFileId,
      downloadAlias: file.downloadAlias,
      status: 'complete',
      receivedBytes: totalBytes,
      totalBytes,
      path: finalPath
    });
  } catch (error) {
    if (!job.abortController.signal.aborted) {
      sendDownloadEvent(job, {
        packageFileId: file.packageFileId,
        downloadAlias: file.downloadAlias,
        status: 'error',
        totalBytes: file.fileSize,
        message: error instanceof Error ? error.message : 'Download failed.'
      });
    }

    throw error;
  } finally {
    job.activeFiles.delete(file.packageFileId);
  }
}

async function fetchBatchPresignedUrls(job: DownloadJob, batch: NativeFileInput[]): Promise<PresignedDownloadUrlResponse[]> {
  if (batch.length === 0) {
    return [];
  }

  if (batch.length > BATCH_PRESIGNED_URL_LIMIT) {
    throw new Error(`Presigned URL batches cannot include more than ${BATCH_PRESIGNED_URL_LIMIT} files.`);
  }

  let response = await requestBatchPresignedUrls(job, batch);
  if (!response.ok && shouldRefreshAuthBeforeRetry(response.status)) {
    await refreshJobAuthToken(job);
    await verifySessionForJob(job);
    response = await requestBatchPresignedUrls(job, batch);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    if (shouldRetryAfterSessionError(response.status, detail) && job.request.sessionId) {
      await refreshJobAuthToken(job);
      await verifySessionForJob(job);
      const retry = await requestBatchPresignedUrls(job, batch);
      if (retry.ok) {
        const retryPayload = await retry.json().catch(() => {
          throw new Error(`Presigned URL response for package ${job.request.packageId} was not valid JSON.`);
        });
        return normalizeBatchPresignedUrlsResponse(retryPayload, batch);
      }

      const retryDetail = await retry.text().catch(() => '');
      throw new Error(`Presigned URL request failed for package ${job.request.packageId}: HTTP ${retry.status}${retryDetail ? ` ${retryDetail}` : ''}`);
    }

    throw new Error(`Presigned URL request failed for package ${job.request.packageId}: HTTP ${response.status}${detail ? ` ${detail}` : ''}`);
  }

  const payload = await response.json().catch(() => {
    throw new Error(`Presigned URL response for package ${job.request.packageId} was not valid JSON.`);
  });
  return normalizeBatchPresignedUrlsResponse(payload, batch);
}

function requestBatchPresignedUrls(job: DownloadJob, batch: NativeFileInput[]): Promise<Response> {
  const url = `${trimTrailingSlash(job.request.host)}/api/package/${job.request.packageId}/files/batchGeneratePresignedUrls`;
  return fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${job.request.authToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(batch.map((file) => file.packageFileId)),
    signal: job.abortController.signal
  });
}

function shouldRefreshAuthBeforeRetry(status: number): boolean {
  return status === 401 || status === 403;
}

function shouldRetryAfterSessionError(status: number, detail: string): boolean {
  const normalized = detail.toLowerCase();
  return status >= 400 && (
    normalized.includes('session') ||
    normalized.includes('expired') ||
    normalized.includes('unauthorized') ||
    normalized.includes('token')
  );
}

function normalizeBatchPresignedUrlsResponse(payload: unknown, batch: NativeFileInput[]): PresignedDownloadUrlResponse[] {
  const values = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>)['presignedUrls']
      : null;

  if (!Array.isArray(values)) {
    throw new Error(`Presigned URL response for package files ${batch.map((file) => file.packageFileId).join(', ')} was empty or malformed.`);
  }

  return values.map(normalizePresignedUrlResponse);
}

function normalizePresignedUrlResponse(value: unknown): PresignedDownloadUrlResponse {
  if (!value || typeof value !== 'object') {
    throw new Error('Presigned URL response item was empty or malformed.');
  }

  const record = value as Record<string, unknown>;
  const packageFileId = readNumberFromKeys(record, ['package_file_id', 'packageFileId'], Number.NaN);
  if (!Number.isFinite(packageFileId)) {
    throw new Error('Presigned URL response item is missing package file id.');
  }

  const downloadURL = readStringFromKeys(record, ['downloadURL', 'downloadUrl', 'download_url'], '');
  if (!downloadURL) {
    throw new Error(`Presigned URL response for file ${packageFileId} is missing downloadURL.`);
  }

  assertHttpUrl(downloadURL);
  return {
    package_file_id: packageFileId,
    downloadURL
  };
}

function readStringFromKeys(record: Record<string, unknown>, keys: string[], fallback: string): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return fallback;
}

function readNumberFromKeys(record: Record<string, unknown>, keys: string[], fallback: number): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return fallback;
}

async function downloadPresignedUrlObject(
  job: DownloadJob,
  downloadUrl: string,
  tempPath: string,
  file: NativeFileInput,
  totalBytes: number,
  partialState: PartialDownloadState | null
): Promise<void> {
  const chunks = createChunks(totalBytes, CHUNK_SIZE_BYTES);
  const completedChunks = partialState?.completedChunks ?? new Set<number>();
  const emitProgress = createProgressEmitter(job, file, totalBytes, partialState?.completedBytes ?? 0);
  let manifestWrite = Promise.resolve();

  await runLimited(chunks, clamp(job.request.chunkConcurrency || DEFAULT_CHUNK_CONCURRENCY, 1, 8), async (chunk) => {
    if (completedChunks.has(chunk.index)) {
      return;
    }

    await waitForResume(job);

    if (job.abortController.signal.aborted) {
      throw new Error('Download cancelled.');
    }

    const response = await net.fetch(downloadUrl, {
      method: 'GET',
      headers: {
        Range: `bytes=${chunk.start}-${chunk.end}`
      },
      signal: job.abortController.signal
    });

    if (!response.ok) {
      throw new Error(`Download request failed for ${file.downloadAlias}: ${await responseStatusText(response)}`);
    }

    if (chunks.length > 1 && response.status !== 206) {
      await cancelResponseBody(response);
      throw new Error(`Download server did not honor range requests for ${file.downloadAlias}.`);
    }

    const writeStream = fs.createWriteStream(tempPath, {
      flags: 'r+',
      start: chunk.start
    });
    const expectedChunkBytes = chunk.end - chunk.start + 1;
    let receivedChunkBytes = 0;

    await pipeline(
      toReadable(response.body),
      createPauseGate(job, (buffer) => {
        receivedChunkBytes += buffer.length;
        emitProgress(buffer.length);
      }),
      writeStream,
      { signal: job.abortController.signal }
    );

    if (receivedChunkBytes !== expectedChunkBytes) {
      throw new Error(`Download chunk was incomplete for ${file.downloadAlias}.`);
    }

    completedChunks.add(chunk.index);
    if (partialState) {
      manifestWrite = manifestWrite.then(() => writePartManifest(partialState.manifestPath, createPartManifest(
        file,
        totalBytes,
        getDirectDownloadSource(downloadUrl),
        completedChunks
      )));
      await manifestWrite;
    }
  });

  await manifestWrite;
}

async function fetchPresignedDownloadSize(downloadUrl: string, file: NativeFileInput, abortSignal: AbortSignal): Promise<number> {
  const response = await net.fetch(downloadUrl, {
    method: 'GET',
    headers: {
      Range: 'bytes=0-0'
    },
    signal: abortSignal
  });

  if (response.status === 206) {
    const totalBytes = parseContentRangeTotal(response.headers.get('content-range'));
    await cancelResponseBody(response);
    if (totalBytes !== null) {
      return totalBytes;
    }
  } else if (response.status === 200) {
    const contentLength = parseContentLength(response.headers.get('content-length'));
    await cancelResponseBody(response);
    if (contentLength !== null) {
      return contentLength;
    }
  } else if (response.status === 416) {
    const totalBytes = parseContentRangeTotal(response.headers.get('content-range'));
    await cancelResponseBody(response);
    if (totalBytes !== null) {
      return totalBytes;
    }
  } else {
    throw new Error(`Could not determine download size for ${file.downloadAlias}: ${await responseStatusText(response)}`);
  }

  throw new Error(`Could not determine download size for ${file.downloadAlias}.`);
}

async function responseStatusText(response: Response): Promise<string> {
  const detail = await response.text().catch(() => '');
  return `HTTP ${response.status}${detail ? ` ${detail}` : ''}`;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best effort only; callers are already abandoning this response body.
  }
}

function parseContentRangeTotal(value: string | null): number | null {
  const match = value?.match(/\/(\d+)$/);
  if (!match) {
    return null;
  }

  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseContentLength(value: string | null): number | null {
  if (!value?.trim()) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function preparePartialDownload(
  tempPath: string,
  file: NativeFileInput,
  totalBytes: number,
  source: DirectDownloadSource
): Promise<PartialDownloadState> {
  const manifestPath = getPartManifestPath(tempPath);
  const tempStat = await statIfExists(tempPath);
  const existingManifest = await readPartManifest(manifestPath);

  if (tempStat && existingManifest && isPartManifestValid(existingManifest, file, totalBytes, source)) {
    const completedChunks = normalizeCompletedChunks(existingManifest.completedChunks, totalBytes);
    if (tempStat.size >= completedHighWaterMark(completedChunks, totalBytes)) {
      if (tempStat.size > totalBytes) {
        await ensureFileSize(tempPath, totalBytes);
      }
      return {
        manifestPath,
        completedChunks,
        completedBytes: completedBytesForChunks(completedChunks, totalBytes)
      };
    }
  }

  await rm(tempPath, { force: true });
  await rm(manifestPath, { force: true });
  await createEmptyFile(tempPath);

  const completedChunks = new Set<number>();
  await writePartManifest(manifestPath, createPartManifest(file, totalBytes, source, completedChunks));

  return {
    manifestPath,
    completedChunks,
    completedBytes: 0
  };
}

async function getRemainingDownloadBytes(job: DownloadJob, file: NativeFileInput): Promise<number> {
  if (file.fileSize <= 0) {
    return 0;
  }

  const finalPath = resolveInside(resolvePackageTargetDir(job.request.targetDir, job.request.packageId, job.request.packageName), file.downloadAlias);
  const existing = await statIfExists(finalPath);
  if (existing && existing.size === file.fileSize) {
    return 0;
  }

  const tempPath = `${finalPath}.part`;
  const tempStat = await statIfExists(tempPath);
  if (!tempStat) {
    return file.fileSize;
  }

  const manifest = await readPartManifest(getPartManifestPath(tempPath));
  if (!manifest || !isPartManifestValidForFile(manifest, file, file.fileSize)) {
    return file.fileSize;
  }

  const completedChunks = normalizeCompletedChunks(manifest.completedChunks, file.fileSize);
  if (tempStat.size < completedHighWaterMark(completedChunks, file.fileSize)) {
    return file.fileSize;
  }

  return Math.max(0, file.fileSize - completedBytesForChunks(completedChunks, file.fileSize));
}

async function getPartialDownloadScanResult(filePath: string, file: NativeFileInput): Promise<unknown | null> {
  if (file.fileSize <= 0) {
    return null;
  }

  const tempPath = `${filePath}.part`;
  const tempStat = await statIfExists(tempPath);
  if (!tempStat) {
    return null;
  }

  const manifest = await readPartManifest(getPartManifestPath(tempPath));
  let completedBytes = 0;

  if (manifest && isPartManifestValidForFile(manifest, file, file.fileSize)) {
    const completedChunks = normalizeCompletedChunks(manifest.completedChunks, file.fileSize);
    if (tempStat.size >= completedHighWaterMark(completedChunks, file.fileSize)) {
      completedBytes = completedBytesForChunks(completedChunks, file.fileSize);
    }
  }

  return {
    packageFileId: file.packageFileId,
    downloadAlias: file.downloadAlias,
    exists: true,
    complete: false,
    size: completedBytes,
    modifiedAt: tempStat.mtime.toISOString(),
    path: null,
    error: completedBytes > 0 ? 'Partial download found.' : 'Partial download file found without resumable progress.'
  };
}

async function createEmptyFile(filePath: string): Promise<void> {
  const handle = await open(filePath, 'w');
  await handle.close();
}

async function ensureFileSize(filePath: string, size: number): Promise<void> {
  const existing = await statIfExists(filePath);
  if (existing?.size === size) {
    return;
  }

  const handle = await open(filePath, existing ? 'r+' : 'w+');
  try {
    await handle.truncate(size);
  } finally {
    await handle.close();
  }
}

function getPartManifestPath(tempPath: string): string {
  return `${tempPath}.manifest.json`;
}

async function readPartManifest(manifestPath: string): Promise<PartManifest | null> {
  try {
    const raw = await readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const record = parsed as Partial<PartManifest>;
    if (
      record.version !== PART_MANIFEST_VERSION ||
      typeof record.packageFileId !== 'number' ||
      typeof record.downloadAlias !== 'string' ||
      typeof record.fileSize !== 'number' ||
      typeof record.chunkSize !== 'number' ||
      typeof record.sourceHost !== 'string' ||
      typeof record.sourcePath !== 'string' ||
      !Array.isArray(record.completedChunks)
    ) {
      return null;
    }

    return {
      version: PART_MANIFEST_VERSION,
      packageFileId: record.packageFileId,
      downloadAlias: record.downloadAlias,
      fileSize: record.fileSize,
      chunkSize: record.chunkSize,
      sourceHost: record.sourceHost,
      sourcePath: record.sourcePath,
      completedChunks: record.completedChunks.filter((value): value is number => Number.isInteger(value)),
      updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : ''
    };
  } catch {
    return null;
  }
}

async function writePartManifest(manifestPath: string, manifest: PartManifest): Promise<void> {
  const tempManifestPath = `${manifestPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(tempManifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
  await rename(tempManifestPath, manifestPath);
}

function createPartManifest(
  file: NativeFileInput,
  totalBytes: number,
  source: DirectDownloadSource,
  completedChunks: Set<number>
): PartManifest {
  return {
    version: PART_MANIFEST_VERSION,
    packageFileId: file.packageFileId,
    downloadAlias: file.downloadAlias,
    fileSize: totalBytes,
    chunkSize: CHUNK_SIZE_BYTES,
    sourceHost: source.sourceHost,
    sourcePath: source.sourcePath,
    completedChunks: Array.from(completedChunks).sort((left, right) => left - right),
    updatedAt: new Date().toISOString()
  };
}

function isPartManifestValid(
  manifest: PartManifest,
  file: NativeFileInput,
  totalBytes: number,
  source: DirectDownloadSource
): boolean {
  return isPartManifestValidForFile(manifest, file, totalBytes)
    && manifest.sourceHost === source.sourceHost
    && manifest.sourcePath === source.sourcePath;
}

function isPartManifestValidForFile(manifest: PartManifest, file: NativeFileInput, totalBytes: number): boolean {
  return manifest.version === PART_MANIFEST_VERSION
    && manifest.packageFileId === file.packageFileId
    && manifest.downloadAlias === file.downloadAlias
    && manifest.fileSize === totalBytes
    && manifest.chunkSize === CHUNK_SIZE_BYTES;
}

function normalizeCompletedChunks(values: number[], totalBytes: number): Set<number> {
  const chunkCount = createChunks(totalBytes, CHUNK_SIZE_BYTES).length;
  return new Set(values.filter((value) => Number.isInteger(value) && value >= 0 && value < chunkCount));
}

function completedBytesForChunks(completedChunks: Set<number>, totalBytes: number): number {
  return createChunks(totalBytes, CHUNK_SIZE_BYTES)
    .filter((chunk) => completedChunks.has(chunk.index))
    .reduce((total, chunk) => total + chunk.end - chunk.start + 1, 0);
}

function completedHighWaterMark(completedChunks: Set<number>, totalBytes: number): number {
  return createChunks(totalBytes, CHUNK_SIZE_BYTES)
    .filter((chunk) => completedChunks.has(chunk.index))
    .reduce((highWaterMark, chunk) => Math.max(highWaterMark, chunk.end + 1), 0);
}

function createProgressEmitter(job: DownloadJob, file: NativeFileInput, totalBytes: number, initialBytes = 0): (bytes: number) => void {
  let receivedBytes = initialBytes;
  let lastSentAt = 0;

  return (bytes: number) => {
    receivedBytes += bytes;
    const now = Date.now();

    if (now - lastSentAt < 500 && receivedBytes < totalBytes) {
      return;
    }

    lastSentAt = now;
    sendDownloadEvent(job, {
      packageFileId: file.packageFileId,
      downloadAlias: file.downloadAlias,
      status: 'downloading',
      receivedBytes,
      totalBytes
    });
  };
}

function createPauseGate(job: DownloadJob, onChunk?: (chunk: Buffer) => void): Transform {
  return new Transform({
    transform(chunk, _encoding, callback) {
      void waitForResume(job)
        .then(() => {
          if (onChunk && Buffer.isBuffer(chunk)) {
            onChunk(chunk);
          }
          callback(null, chunk);
        })
        .catch((error) => callback(error instanceof Error ? error : new Error('Download cancelled.')));
    }
  });
}

function sendDownloadEvent(job: DownloadJob, event: Omit<DownloadEvent, 'jobId' | 'packageId' | 'packageName'>): void {
  if (job.sender.isDestroyed()) {
    return;
  }

  job.sender.send('download:event', {
    jobId: job.id,
    packageId: job.request.packageId,
    packageName: job.request.packageName,
    ...event
  } satisfies DownloadEvent);
}

function validateDownloadStartRequest(request: DownloadStartRequest): void {
  if (!request) {
    throw new Error('Download request is required.');
  }

  assertHttpUrl(request.host);

  if (!request.authToken) {
    throw new Error('An authentication token is required.');
  }

  request.packageId = Number(request.packageId);
  if (!Number.isFinite(request.packageId)) {
    throw new Error('A valid package id is required.');
  }

  request.packageName = stringOrEmpty(request.packageName).trim();
  if (!request.packageName) {
    throw new Error('A package name is required.');
  }

  if (!request.targetDir) {
    throw new Error('A download directory is required.');
  }

  if (!Array.isArray(request.files) || request.files.length === 0) {
    throw new Error('At least one file is required.');
  }

  for (const file of request.files) {
    file.packageFileId = Number(file.packageFileId);
    file.fileSize = Number(file.fileSize);

    if (!Number.isFinite(file.packageFileId)) {
      throw new Error(`A valid package file id is required for ${file.downloadAlias || 'the selected file'}.`);
    }

    if (!file.downloadAlias) {
      throw new Error(`A download alias is required for file ${file.packageFileId}.`);
    }

    if (!Number.isFinite(file.fileSize)) {
      file.fileSize = 0;
    }
  }
}

function getDirectDownloadSource(downloadUrl: string): DirectDownloadSource {
  const parsed = new URL(downloadUrl);
  return {
    sourceHost: parsed.hostname,
    sourcePath: parsed.pathname
  };
}

function createChunks(totalBytes: number, chunkSize: number): DownloadChunk[] {
  const chunks: DownloadChunk[] = [];

  for (let start = 0, index = 0; start < totalBytes; start += chunkSize, index += 1) {
    chunks.push({
      index,
      start,
      end: Math.min(start + chunkSize - 1, totalBytes - 1)
    });
  }

  return chunks;
}

async function runLimited<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  let firstError: unknown = null;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      if (firstError) {
        return;
      }

      const index = cursor;
      cursor += 1;
      try {
        await worker(items[index]);
      } catch (error) {
        firstError ??= error;
        return;
      }
    }
  });

  await Promise.all(runners);

  if (firstError) {
    throw firstError;
  }
}

function toReadable(body: unknown): NodeJS.ReadableStream {
  if (body instanceof Readable) {
    return body;
  }

  if (body && typeof (body as { pipe?: unknown }).pipe === 'function') {
    return body as NodeJS.ReadableStream;
  }

  if (body && typeof (body as { getReader?: unknown }).getReader === 'function') {
    return Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
  }

  throw new Error('Download response did not include a readable body.');
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
