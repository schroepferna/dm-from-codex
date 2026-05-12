import { app, BrowserWindow, dialog, ipcMain, shell, WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, open, rename, rm, stat, statfs } from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';

const PROTOCOL = 'nda-dm';
const DEFAULT_AWS_REGION = process.env['NDA_DM_AWS_REGION'] || 'us-east-1';
const DEFAULT_FILE_CONCURRENCY = 2;
const DEFAULT_CHUNK_CONCURRENCY = 4;
const CHUNK_SIZE_BYTES = 64 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000;
const AUTH_CALLBACK_TTL_MS = 5 * 60 * 1000;
const AUTH_REQUEST_TIMEOUT_MS = 30000;
const ZENDESK_TOKEN = process.env['NDA_DM_ZENDESK_TOKEN'] || '';

interface NativeFileInput {
  packageFileId: number;
  downloadAlias: string;
  fileSize: number;
}

interface ScanDownloadRequest {
  targetDir: string;
  files: NativeFileInput[];
}

interface AuthCompleteRequest {
  host: string;
  sessionId: string;
}

interface AuthVerifySessionRequest {
  host: string;
  token: string;
  sessionId: string;
}

interface DownloadStartRequest {
  host: string;
  authToken: string;
  sessionId: string | null;
  packageId: number;
  packageName: string;
  targetDir: string;
  files: NativeFileInput[];
  fileConcurrency?: number;
  chunkConcurrency?: number;
}

interface DownloadTokenResponse {
  package_file_id: number;
  download_alias: string;
  access_key: string;
  secret_key: string;
  session_token: string;
  expiration_date: string;
  destination_uri: string | null;
  source_uri: string;
}

interface DownloadEvent {
  jobId: string;
  packageId: number;
  packageName: string;
  packageFileId?: number;
  downloadAlias?: string;
  status: 'queued' | 'fetching-token' | 'downloading' | 'skipped' | 'complete' | 'error' | 'cancelled' | 'job-complete' | 'heartbeat';
  receivedBytes?: number;
  totalBytes?: number;
  path?: string;
  message?: string;
}

interface DownloadJob {
  id: string;
  request: DownloadStartRequest;
  abortController: AbortController;
  sender: WebContents;
  heartbeatTimer: NodeJS.Timeout | null;
}

interface HelpRequest {
  name: string;
  username: string;
  email: string;
  message: string;
}

let mainWindow: BrowserWindow | null = null;
let pendingAuthCallback: { url: string; sessionId: string } | null = null;
const jobs = new Map<string, DownloadJob>();

const startupProtocolUrl = findProtocolUrl(process.argv);
const gotSingleInstanceLock = app.requestSingleInstanceLock(
  startupProtocolUrl ? { protocolUrl: startupProtocolUrl } : undefined
);

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
    const callbackUrl = protocolUrlFromAdditionalData(additionalData) || findProtocolUrl(argv);
    if (callbackUrl) {
      handleAuthCallback(callbackUrl);
    }

    showMainWindow();
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleAuthCallback(url);
  });

  app.whenReady().then(async () => {
    registerProtocol();
    registerIpcHandlers();
    await createWindow();
    if (startupProtocolUrl) {
      handleAuthCallback(startupProtocolUrl);
    }
  }).catch((error) => {
    console.error(error);
    app.quit();
  });
}

app.on('window-all-closed', () => {
  console.info('All windows closed.');

  for (const job of jobs.values()) {
    job.abortController.abort();
  }

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});

function registerProtocol(): void {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1] ?? '.')]);
    return;
  }

  app.setAsDefaultProtocolClient(PROTOCOL);
}

function showMainWindow(): void {
  if (!mainWindow) {
    void createWindow();
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1024,
    minHeight: 720,
    backgroundColor: '#f7f8fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.on('closed', () => {
    console.info('Main window closed.');
    mainWindow = null;
  });

  if (app.isPackaged) {
    await mainWindow.loadFile(getPackagedRendererIndex());
  } else {
    await mainWindow.loadURL('http://127.0.0.1:4200');
  }
}

function getPackagedRendererIndex(): string {
  const candidates = [
    path.join(__dirname, '..', 'dist', 'nda-download-manager', 'browser', 'index.html'),
    path.join(__dirname, '..', 'dist', 'nda-download-manager', 'index.html')
  ];

  const match = candidates.find((candidate) => fs.existsSync(candidate));
  if (!match) {
    throw new Error('Angular build output was not found.');
  }

  return match;
}

function handleAuthCallback(rawUrl: string): void {
  const sessionId = extractSessionId(rawUrl);

  if (!sessionId) {
    console.warn('Received an auth callback without a session id.');
    return;
  }

  console.info('Received RAS auth callback.');
  const callback = { url: rawUrl, sessionId };
  pendingAuthCallback = callback;

  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('auth:callback', callback);
  }

  setTimeout(() => {
    if (pendingAuthCallback === callback) {
      pendingAuthCallback = null;
    }
  }, AUTH_CALLBACK_TTL_MS);
}

function protocolUrlFromAdditionalData(additionalData: unknown): string | null {
  if (!additionalData || typeof additionalData !== 'object') {
    return null;
  }

  const protocolUrl = (additionalData as { protocolUrl?: unknown }).protocolUrl;
  return typeof protocolUrl === 'string' ? normalizeProtocolUrl(protocolUrl) : null;
}

function findProtocolUrl(values: readonly string[]): string | null {
  for (const value of values) {
    const match = normalizeProtocolUrl(value);
    if (match) {
      return match;
    }
  }

  return null;
}

function normalizeProtocolUrl(value: string): string | null {
  const trimmed = value.trim().replace(/^["']|["']$/g, '');
  const lower = trimmed.toLowerCase();

  if (lower.startsWith(`${PROTOCOL}:`)) {
    return trimmed;
  }

  const match = trimmed.match(/nda-dm:(?:\/\/)?[^\s"']*/i);
  return match?.[0] ?? null;
}

function extractSessionId(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    const named = parsed.searchParams.get('sessionId')
      || parsed.searchParams.get('jSessionId')
      || parsed.searchParams.get('jsessionid')
      || parsed.searchParams.get('session_id');

    if (named) {
      return named;
    }

    const hostCandidate = decodeURIComponent(parsed.hostname || '');
    if (hostCandidate.length > 16 && hostCandidate !== 'auth') {
      return hostCandidate;
    }

    const pathCandidate = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
    if (pathCandidate.length > 16) {
      return pathCandidate;
    }
  } catch {
    const uuidMatch = rawUrl.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return uuidMatch?.[0] ?? null;
  }

  const uuidMatch = rawUrl.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return uuidMatch?.[0] ?? null;
}

function registerIpcHandlers(): void {
  ipcMain.handle('auth:open-url', async (_event, authUrl: string) => {
    assertHttpUrl(authUrl);
    await shell.openExternal(authUrl);
  });

  ipcMain.handle('auth:get-pending-callback', async () => {
    const callback = pendingAuthCallback;
    pendingAuthCallback = null;
    return callback;
  });

  ipcMain.handle('auth:complete-sign-in', async (_event, request: AuthCompleteRequest) => {
    return completeSignIn(request);
  });

  ipcMain.handle('auth:verify-session', async (_event, request: AuthVerifySessionRequest) => {
    return verifySession(request);
  });

  ipcMain.handle('fs:get-default-download-directory', async () => {
    return app.getPath('downloads');
  });

  ipcMain.handle('fs:get-available-space', async (_event, targetDir: string) => {
    return getAvailableSpace(targetDir);
  });

  ipcMain.handle('fs:choose-directory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory']
    });

    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle('fs:scan-downloads', async (_event, request: ScanDownloadRequest) => {
    return scanDownloadDirectory(request);
  });

  ipcMain.handle('download:start', async (event, request: DownloadStartRequest) => {
    validateDownloadStartRequest(request);

    const job: DownloadJob = {
      id: randomUUID(),
      request,
      abortController: new AbortController(),
      sender: event.sender,
      heartbeatTimer: null
    };

    jobs.set(job.id, job);
    void runDownloadJob(job).finally(() => jobs.delete(job.id));
    return { jobId: job.id };
  });

  ipcMain.handle('download:cancel', async (_event, jobId: string) => {
    const job = jobs.get(jobId);
    if (job) {
      job.abortController.abort();
      sendDownloadEvent(job, { status: 'cancelled', message: 'Download cancelled.' });
    }
  });

  ipcMain.handle('help:submit', async (_event, request: HelpRequest) => {
    return submitHelpRequest(request);
  });
}

async function getAvailableSpace(targetDir: string): Promise<{ availableBytes: number; path: string }> {
  if (!targetDir || typeof targetDir !== 'string') {
    throw new Error('A download directory is required.');
  }

  const existingPath = await findExistingAncestor(targetDir);
  const result = await statfs(existingPath);
  return {
    availableBytes: result.bavail * result.bsize,
    path: existingPath
  };
}

async function findExistingAncestor(targetDir: string): Promise<string> {
  let candidate = path.resolve(targetDir);

  while (true) {
    try {
      await stat(candidate);
      return candidate;
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        throw new Error(`Download directory does not exist: ${targetDir}`);
      }

      candidate = parent;
    }
  }
}

async function completeSignIn(request: AuthCompleteRequest): Promise<{ token: string; username: string | null }> {
  if (!request?.host || !request.sessionId) {
    throw new Error('A host and session id are required.');
  }

  assertHttpUrl(request.host);
  const token = await exchangeSessionForToken(request.host, request.sessionId);
  const verification = await verifyToken(request.host, token);

  if (!verification.valid) {
    throw new Error(verification.errorMessage || 'Token verification failed.');
  }

  return {
    token,
    username: verification.username || null
  };
}

async function exchangeSessionForToken(host: string, sessionId: string): Promise<string> {
  const url = new URL(`${trimTrailingSlash(host)}/api/ras/getToken`);
  url.searchParams.set('sessionId', sessionId);

  const response = await fetchWithTimeout(url.toString());
  const token = (await response.text()).trim();

  if (!response.ok) {
    throw new Error(token || `Token exchange failed with HTTP ${response.status}.`);
  }

  if (!token || token.toLowerCase().includes('invalid') || token.toLowerCase().includes('expired')) {
    throw new Error(token || 'Session is invalid or expired.');
  }

  return token;
}

async function verifyToken(host: string, token: string): Promise<{ valid: boolean; username: string | null; errorMessage: string | null }> {
  const response = await fetchWithTimeout(`${trimTrailingSlash(host)}/api/ras/verifyToken`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Token verification failed with HTTP ${response.status}${detail ? ` ${detail}` : ''}`);
  }

  return response.json() as Promise<{ valid: boolean; username: string | null; errorMessage: string | null }>;
}

async function verifySession(request: AuthVerifySessionRequest): Promise<{ valid: boolean; username: string | null; errorMessage: string | null }> {
  if (!request?.host || !request.token || !request.sessionId) {
    throw new Error('A host, token, and session id are required.');
  }

  assertHttpUrl(request.host);

  const response = await fetchWithTimeout(`${trimTrailingSlash(request.host)}/api/ras/verifySession`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${request.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ jSessionId: request.sessionId })
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Session verification failed with HTTP ${response.status}${detail ? ` ${detail}` : ''}`);
  }

  return response.json() as Promise<{ valid: boolean; username: string | null; errorMessage: string | null }>;
}

async function scanDownloadDirectory(request: ScanDownloadRequest): Promise<unknown[]> {
  if (!request?.targetDir || !Array.isArray(request.files)) {
    throw new Error('A download directory and file list are required.');
  }

  return Promise.all(request.files.map(async (file) => {
    try {
      const filePath = resolveInside(request.targetDir, file.downloadAlias);
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
  const { files, fileConcurrency = DEFAULT_FILE_CONCURRENCY } = job.request;

  try {
    await mkdir(job.request.targetDir, { recursive: true });
    await refreshJobAuthToken(job);
    await verifySessionForJob(job);
    startDownloadHeartbeat(job);

    for (const file of files) {
      sendDownloadEvent(job, {
        packageFileId: file.packageFileId,
        downloadAlias: file.downloadAlias,
        status: 'queued',
        receivedBytes: 0,
        totalBytes: file.fileSize
      });
    }

    await runLimited(files, clamp(fileConcurrency, 1, 6), async (file) => {
      if (job.abortController.signal.aborted) {
        throw new Error('Download cancelled.');
      }

      await downloadOneFile(job, file);
    });

    sendDownloadEvent(job, { status: 'job-complete', message: 'Download complete.' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Download failed.';
    sendDownloadEvent(job, { status: job.abortController.signal.aborted ? 'cancelled' : 'error', message });
  } finally {
    if (job.heartbeatTimer) {
      clearInterval(job.heartbeatTimer);
      job.heartbeatTimer = null;
    }
  }
}

function startDownloadHeartbeat(job: DownloadJob): void {
  if (!job.request.sessionId) {
    return;
  }

  job.heartbeatTimer = setInterval(() => {
    void refreshJobAuthToken(job)
      .then(() => verifySessionForJob(job))
      .catch((error) => {
        const message = error instanceof Error ? error.message : 'Session heartbeat failed.';
        sendDownloadEvent(job, { status: 'error', message });
        job.abortController.abort();
      });
  }, HEARTBEAT_INTERVAL_MS);
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
  sendDownloadEvent(job, { status: 'heartbeat', message: 'Authentication token refreshed.' });
}

async function verifySessionForJob(job: DownloadJob): Promise<void> {
  const { host, authToken, sessionId } = job.request;
  if (!sessionId) {
    return;
  }

  const response = await fetch(`${trimTrailingSlash(host)}/api/ras/verifySession`, {
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

  sendDownloadEvent(job, { status: 'heartbeat', message: 'Session verified.' });
}

async function downloadOneFile(job: DownloadJob, file: NativeFileInput): Promise<void> {
  const finalPath = resolveInside(job.request.targetDir, file.downloadAlias);
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

  sendDownloadEvent(job, {
    packageFileId: file.packageFileId,
    downloadAlias: file.downloadAlias,
    status: 'fetching-token',
    receivedBytes: 0,
    totalBytes: file.fileSize
  });

  const downloadToken = await fetchDownloadToken(job, file);
  const s3Location = parseS3Uri(downloadToken.source_uri);
  const client = new S3Client({
    region: DEFAULT_AWS_REGION,
    credentials: {
      accessKeyId: downloadToken.access_key,
      secretAccessKey: downloadToken.secret_key,
      sessionToken: downloadToken.session_token
    },
    requestHandler: new (await import('@smithy/node-http-handler')).NodeHttpHandler({
      httpsAgent: new https.Agent({
        keepAlive: true,
        maxSockets: Math.max(16, (job.request.chunkConcurrency || DEFAULT_CHUNK_CONCURRENCY) * 4)
      })
    })
  });

  const totalBytes = file.fileSize > 0
    ? file.fileSize
    : await fetchObjectSize(client, s3Location.bucket, s3Location.key, job.abortController.signal);

  const tempPath = `${finalPath}.part`;
  await rm(tempPath, { force: true });

  sendDownloadEvent(job, {
    packageFileId: file.packageFileId,
    downloadAlias: file.downloadAlias,
    status: 'downloading',
    receivedBytes: 0,
    totalBytes,
    path: finalPath
  });

  if (totalBytes === 0) {
    const handle = await open(tempPath, 'w');
    await handle.close();
  } else {
    await downloadS3Object(job, client, s3Location.bucket, s3Location.key, tempPath, file, totalBytes);
  }

  await rm(finalPath, { force: true });
  await rename(tempPath, finalPath);

  sendDownloadEvent(job, {
    packageFileId: file.packageFileId,
    downloadAlias: file.downloadAlias,
    status: 'complete',
    receivedBytes: totalBytes,
    totalBytes,
    path: finalPath
  });
}

async function fetchDownloadToken(job: DownloadJob, file: NativeFileInput): Promise<DownloadTokenResponse> {
  await refreshJobAuthToken(job);

  const url = `${trimTrailingSlash(job.request.host)}/api/package/${job.request.packageId}/files/${file.packageFileId}/download_token`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${job.request.authToken}`
    },
    signal: job.abortController.signal
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Download token failed for ${file.downloadAlias}: HTTP ${response.status}${detail ? ` ${detail}` : ''}`);
  }

  return response.json() as Promise<DownloadTokenResponse>;
}

async function downloadS3Object(
  job: DownloadJob,
  client: S3Client,
  bucket: string,
  key: string,
  tempPath: string,
  file: NativeFileInput,
  totalBytes: number
): Promise<void> {
  const handle = await open(tempPath, 'w');
  await handle.truncate(totalBytes);
  await handle.close();

  const chunks = createChunks(totalBytes, CHUNK_SIZE_BYTES);
  const emitProgress = createProgressEmitter(job, file, totalBytes);

  await runLimited(chunks, clamp(job.request.chunkConcurrency || DEFAULT_CHUNK_CONCURRENCY, 1, 8), async (chunk) => {
    if (job.abortController.signal.aborted) {
      throw new Error('Download cancelled.');
    }

    const response = await client.send(new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      Range: `bytes=${chunk.start}-${chunk.end}`
    }), { abortSignal: job.abortController.signal });

    const body = toReadable(response.Body);
    body.on('data', (buffer: Buffer) => emitProgress(buffer.length));

    const writeStream = fs.createWriteStream(tempPath, {
      flags: 'r+',
      start: chunk.start
    });

    await pipeline(body, writeStream, { signal: job.abortController.signal });
  });
}

async function fetchObjectSize(client: S3Client, bucket: string, key: string, abortSignal: AbortSignal): Promise<number> {
  const response = await client.send(new HeadObjectCommand({
    Bucket: bucket,
    Key: key
  }), { abortSignal });

  return response.ContentLength ?? 0;
}

function createProgressEmitter(job: DownloadJob, file: NativeFileInput, totalBytes: number): (bytes: number) => void {
  let receivedBytes = 0;
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

async function submitHelpRequest(request: HelpRequest): Promise<{ ok: boolean; status: number; message: string }> {
  if (!ZENDESK_TOKEN || ZENDESK_TOKEN === 'REPLACE_WITH_ZENDESK_TOKEN') {
    throw new Error('NDA_DM_ZENDESK_TOKEN is not configured.');
  }

  const payload = {
    ticket: {
      subject: `Download Manager Help Request from ${request.email}`,
      requester: {
        name: request.name,
        email: request.email
      },
      comment: {
        html_body: [
          `<p><strong>NAME</strong><br>${escapeHtml(request.name)}</p>`,
          `<p><strong>USERNAME</strong><br>${escapeHtml(request.username)}</p>`,
          `<p><strong>MESSAGE</strong><br>${escapeHtml(request.message).replace(/\n/g, '<br>')}</p>`
        ].join('')
      },
      custom_fields: []
    }
  };

  const response = await fetch('https://ndar.zendesk.com/hc/requests', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ZENDESK_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Zendesk request failed with HTTP ${response.status}${detail ? ` ${detail}` : ''}`);
  }

  return {
    ok: true,
    status: response.status,
    message: 'Help request sent.'
  };
}

function validateDownloadStartRequest(request: DownloadStartRequest): void {
  if (!request) {
    throw new Error('Download request is required.');
  }

  assertHttpUrl(request.host);

  if (!request.authToken) {
    throw new Error('An authentication token is required.');
  }

  if (!request.targetDir) {
    throw new Error('A download directory is required.');
  }

  if (!Array.isArray(request.files) || request.files.length === 0) {
    throw new Error('At least one file is required.');
  }
}

function assertHttpUrl(value: string): void {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Only http and https URLs are supported.');
  }
}

function resolveInside(baseDir: string, relativeName: string): string {
  const base = path.resolve(baseDir);
  const cleaned = relativeName
    .replace(/\0/g, '')
    .replace(/^[a-zA-Z]:/, '')
    .replace(/^[/\\]+/, '');
  const candidate = path.resolve(base, cleaned);

  if (candidate !== base && !candidate.startsWith(`${base}${path.sep}`)) {
    throw new Error(`Unsafe file path: ${relativeName}`);
  }

  return candidate;
}

async function statIfExists(filePath: string): Promise<fs.Stats | null> {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
}

function parseS3Uri(sourceUri: string): { bucket: string; key: string } {
  const match = sourceUri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    throw new Error(`Unsupported S3 URI: ${sourceUri}`);
  }

  return {
    bucket: match[1],
    key: match[2]
  };
}

function createChunks(totalBytes: number, chunkSize: number): Array<{ start: number; end: number }> {
  const chunks: Array<{ start: number; end: number }> = [];

  for (let start = 0; start < totalBytes; start += chunkSize) {
    chunks.push({
      start,
      end: Math.min(start + chunkSize - 1, totalBytes - 1)
    });
  }

  return chunks;
}

async function runLimited<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]);
    }
  });

  await Promise.all(runners);
}

function toReadable(body: unknown): NodeJS.ReadableStream {
  if (body instanceof Readable) {
    return body;
  }

  if (body && typeof (body as { pipe?: unknown }).pipe === 'function') {
    return body as NodeJS.ReadableStream;
  }

  throw new Error('S3 response did not include a readable body.');
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), AUTH_REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...init,
      signal: abortController.signal
    });
  } catch (error) {
    if (abortController.signal.aborted) {
      throw new Error('RAS request timed out.');
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
