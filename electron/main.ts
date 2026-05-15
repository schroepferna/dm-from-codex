import { app, BrowserWindow, dialog, ipcMain, net, shell, WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const PROTOCOL = 'nda-dm';
const DEFAULT_FILE_CONCURRENCY = 2;
const DEFAULT_URL_BATCH_CONCURRENCY = 4;
const BATCH_PRESIGNED_URL_LIMIT = 50;
const DEFAULT_CHUNK_CONCURRENCY = 4;
const CHUNK_SIZE_BYTES = 64 * 1024 * 1024;
const PART_MANIFEST_VERSION = 1;
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const AUTH_CALLBACK_TTL_MS = 5 * 60 * 1000;
const AUTH_REQUEST_TIMEOUT_MS = 30000;
const DISK_SPACE_TIMEOUT_MS = 15000;
const ZENDESK_TOKEN = process.env['NDA_DM_ZENDESK_TOKEN'] || '';
const ZENDESK_REQUEST_URL = 'https://ndar.zendesk.com/api/v2/requests.json';

interface NativeFileInput {
  packageFileId: number;
  downloadAlias: string;
  fileSize: number;
}

interface ScanDownloadRequest {
  targetDir: string;
  packageId: number;
  files: NativeFileInput[];
}

interface ShowPackageRequest {
  targetDir: string;
  packageId: number;
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
  tokenConcurrency?: number;
  chunkConcurrency?: number;
}

interface PresignedDownloadUrlResponse {
  package_file_id: number;
  downloadURL: string;
}

interface DirectDownloadSource {
  sourceHost: string;
  sourcePath: string;
}

interface DownloadEvent {
  jobId: string;
  packageId: number;
  packageName: string;
  packageFileId?: number;
  downloadAlias?: string;
  status: 'queued' | 'fetching-token' | 'downloading' | 'paused' | 'skipped' | 'complete' | 'error' | 'cancelled' | 'job-complete' | 'heartbeat';
  isPaused?: boolean;
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
  paused: boolean;
  pauseWaiters: Array<() => void>;
  activeFiles: Map<number, NativeFileInput>;
  downloadUrls: Map<number, Promise<DownloadUrlResult>>;
}

type DownloadUrlResult =
  | { ok: true; url: PresignedDownloadUrlResponse }
  | { ok: false; error: unknown };

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

interface DownloadChunk {
  index: number;
  start: number;
  end: number;
}

interface PartManifest {
  version: typeof PART_MANIFEST_VERSION;
  packageFileId: number;
  downloadAlias: string;
  fileSize: number;
  chunkSize: number;
  sourceHost: string;
  sourcePath: string;
  completedChunks: number[];
  updatedAt: string;
}

interface PartialDownloadState {
  manifestPath: string;
  completedChunks: Set<number>;
  completedBytes: number;
}

interface HelpRequest {
  name: string;
  username: string;
  email: string;
  message: string;
  zendeskToken?: string;
}

let mainWindow: BrowserWindow | null = null;
let authWindow: BrowserWindow | null = null;
const authWindows = new Set<BrowserWindow>();
let pendingAuthCallback: { url: string; sessionId: string } | null = null;
let authFlowCompleted = false;
let authCancellationNotified = false;
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
    icon: getAppIconPath(),
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

function getAppIconPath(): string {
  return path.join(__dirname, '..', 'assets', 'ndaicon.ico');
}

async function openPrivateAuthWindow(authUrl: string): Promise<void> {
  closeAuthWindow();
  authFlowCompleted = false;
  authCancellationNotified = false;

  const authPartition = `auth-${randomUUID()}`;
  authWindow = new BrowserWindow({
    width: 1040,
    height: 780,
    minWidth: 760,
    minHeight: 620,
    parent: mainWindow ?? undefined,
    title: 'RAS Sign In',
    backgroundColor: '#ffffff',
    webPreferences: {
      partition: authPartition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  configureAuthWindow(authWindow, authPartition);

  const currentWindow = authWindow;
  void currentWindow.loadURL(authUrl).catch((error) => {
    if (!currentWindow.isDestroyed()) {
      notifyAuthCancelled(error instanceof Error ? error.message : 'Sign-in page failed to load.');
      currentWindow.close();
    }
  });
}

function configureAuthWindow(window: BrowserWindow, authPartition: string): void {
  authWindows.add(window);

  window.on('closed', () => {
    authWindows.delete(window);
    if (authWindow === window) {
      authWindow = null;
    }

    if (authWindows.size === 0 && !authFlowCompleted && !pendingAuthCallback) {
      notifyAuthCancelled('Sign-in was not completed.');
    }
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (handleAuthNavigation(url)) {
      event.preventDefault();
    }
  });

  window.webContents.on('will-redirect', (event, url) => {
    if (handleAuthNavigation(url)) {
      event.preventDefault();
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (handleAuthNavigation(url)) {
      return { action: 'deny' };
    }

    try {
      assertHttpUrl(url);
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          parent: window,
          width: 940,
          height: 700,
          title: 'RAS Sign In',
          webPreferences: {
            partition: authPartition,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
          }
        }
      };
    } catch {
      return { action: 'deny' };
    }
  });

  window.webContents.on('did-create-window', (childWindow) => {
    configureAuthWindow(childWindow, authPartition);
  });
}

function handleAuthNavigation(url: string): boolean {
  const callbackUrl = normalizeProtocolUrl(url);
  if (!callbackUrl) {
    return false;
  }

  if (!handleAuthCallback(callbackUrl)) {
    notifyAuthCancelled('Sign-in did not return a session.');
  }
  closeAuthWindow();
  return true;
}

function notifyAuthCancelled(message: string): void {
  if (authFlowCompleted || authCancellationNotified) {
    return;
  }

  authCancellationNotified = true;

  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('auth:cancelled', { message });
  }
}

function closeAuthWindow(): void {
  if (authWindows.size === 0) {
    return;
  }

  authWindow = null;

  for (const window of Array.from(authWindows)) {
    if (!window.isDestroyed()) {
      window.close();
    }
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

function handleAuthCallback(rawUrl: string): boolean {
  const sessionId = extractSessionId(rawUrl);

  if (!sessionId) {
    console.warn('Received an auth callback without a session id.');
    return false;
  }

  console.info('Received RAS auth callback.');
  authFlowCompleted = true;
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

  return true;
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
    await openPrivateAuthWindow(authUrl);
  });

  ipcMain.handle('auth:get-pending-callback', async () => {
    const callback = pendingAuthCallback;
    pendingAuthCallback = null;
    return callback;
  });

  ipcMain.handle('shell:open-external-url', async (_event, url: string) => {
    assertHttpUrl(url);
    await shell.openExternal(url);
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

  ipcMain.handle('fs:show-item', async (_event, itemPath: string) => {
    return showItemInFolder(itemPath);
  });

  ipcMain.handle('fs:show-package', async (_event, request: ShowPackageRequest) => {
    return showPackageInFolder(request);
  });

  ipcMain.handle('download:start', async (event, request: DownloadStartRequest) => {
    validateDownloadStartRequest(request);
    console.info(
      `Starting download job for package ${request.packageId}; files ${request.files.map((file) => file.packageFileId).join(', ')}.`
    );

    const job: DownloadJob = {
      id: randomUUID(),
      request,
      abortController: new AbortController(),
      sender: event.sender,
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
  });

  ipcMain.handle('download:pause', async (_event, jobId: string) => {
    const job = jobs.get(jobId);
    if (job) {
      pauseDownloadJob(job);
    }
  });

  ipcMain.handle('download:resume', async (_event, jobId: string) => {
    const job = jobs.get(jobId);
    if (job) {
      resumeDownloadJob(job);
    }
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

async function showItemInFolder(itemPath: string): Promise<void> {
  if (!itemPath || typeof itemPath !== 'string') {
    throw new Error('A file or folder path is required.');
  }

  const resolvedPath = path.resolve(itemPath);
  const itemStat = await stat(resolvedPath);

  if (itemStat.isDirectory()) {
    const error = await shell.openPath(resolvedPath);
    if (error) {
      throw new Error(error);
    }
    return;
  }

  shell.showItemInFolder(resolvedPath);
}

async function showPackageInFolder(request: ShowPackageRequest): Promise<void> {
  if (!request?.targetDir) {
    throw new Error('A download directory is required.');
  }

  const packageDir = resolvePackageTargetDir(request.targetDir, request.packageId);
  await showItemInFolder(packageDir);
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
  if (!request?.targetDir || !Number.isFinite(Number(request.packageId)) || !Array.isArray(request.files)) {
    throw new Error('A download directory, package id, and file list are required.');
  }

  const packageTargetDir = resolvePackageTargetDir(request.targetDir, Number(request.packageId));
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

    const packageTargetDir = resolvePackageTargetDir(job.request.targetDir, job.request.packageId);
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

    await runLimited(filesToDownload, clamp(fileConcurrency, 1, 6), async (file) => {
      await waitForResume(job);

      if (job.abortController.signal.aborted) {
        throw new Error('Download cancelled.');
      }

      await downloadOneFile(job, file);
    });
    await urlPrefetch;

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
    const finalPath = resolveInside(resolvePackageTargetDir(job.request.targetDir, job.request.packageId), file.downloadAlias);
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
    const finalPath = resolveInside(resolvePackageTargetDir(job.request.targetDir, job.request.packageId), file.downloadAlias);
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

function formatBytes(bytes: number): string {
  if (bytes === 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exponent);
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
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

  const finalPath = resolveInside(resolvePackageTargetDir(job.request.targetDir, job.request.packageId), file.downloadAlias);
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

async function submitHelpRequest(request: HelpRequest): Promise<{ ok: boolean; status: number; message: string }> {
  const zendeskToken = typeof request.zendeskToken === 'string' && request.zendeskToken.trim()
    ? request.zendeskToken.trim()
    : ZENDESK_TOKEN;

  if (!zendeskToken || zendeskToken === 'REPLACE_WITH_ZENDESK_TOKEN') {
    throw new Error('Zendesk token is not configured.');
  }

  const commentBody = [
    `NAME`,
    request.name,
    '',
    `USERNAME`,
    request.username,
    '',
    `MESSAGE`,
    request.message
  ].join('\n');

  const payload = {
    request: {
      subject: `Download Manager Help Request from ${request.email}`,
      requester: {
        name: request.name,
        email: request.email
      },
      comment: {
        body: commentBody
      },
      custom_fields: []
    }
  };

  let response: Response;
  try {
    response = await fetchWithTimeout(ZENDESK_REQUEST_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${zendeskToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }, 'Help request timed out.');
  } catch (error) {
    throw new Error(helpSubmissionErrorMessage(error));
  }

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

function helpSubmissionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message === 'Help request timed out.') {
    return message;
  }

  if (!message || message === 'fetch failed') {
    return 'Help request could not be sent. Check your network connection or VPN and try again.';
  }

  return `Help request could not be sent. ${message}`;
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

function resolvePackageTargetDir(baseDir: string, packageId: number): string {
  const normalizedPackageId = Number(packageId);
  if (!Number.isFinite(normalizedPackageId)) {
    throw new Error('A valid package id is required.');
  }

  return resolveInside(baseDir, `package_${Math.trunc(normalizedPackageId)}`);
}

async function statIfExists(filePath: string): Promise<fs.Stats | null> {
  try {
    return await stat(filePath);
  } catch {
    return null;
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

  if (body && typeof (body as { getReader?: unknown }).getReader === 'function') {
    return Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
  }

  throw new Error('Download response did not include a readable body.');
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMessage = 'RAS request timed out.'): Promise<Response> {
  const abortController = new AbortController();
  const upstreamSignal = init.signal;
  let timedOut = false;

  const abortFromUpstream = () => {
    abortController.abort(upstreamSignal?.reason);
  };

  if (upstreamSignal?.aborted) {
    abortFromUpstream();
  } else {
    upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, AUTH_REQUEST_TIMEOUT_MS);

  try {
    return await net.fetch(url, {
      ...init,
      signal: abortController.signal
    });
  } catch (error) {
    if (timedOut) {
      throw new Error(timeoutMessage);
    }

    throw error;
  } finally {
    upstreamSignal?.removeEventListener('abort', abortFromUpstream);
    clearTimeout(timer);
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
