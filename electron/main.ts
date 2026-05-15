import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  AUTH_CALLBACK_TTL_MS,
  PROTOCOL
} from './constants';
import {
  AuthCompleteRequest,
  AuthVerifySessionRequest,
  DownloadStartRequest,
  HelpRequest,
  ScanDownloadRequest,
  ShowPackageRequest
} from './models';
import { submitHelpRequest } from './help';
import {
  completeSignIn,
  verifySession
} from './auth-api';
import { assertHttpUrl } from './utils';
import {
  getAvailableSpace,
  showItemInFolder,
  showPackageInFolder
} from './native-fs';
import {
  attachWebContentsLogging,
  configureAppLogging
} from './logging';
import {
  cancelAllDownloadJobs,
  cancelDownloadJob,
  pauseDownloadJobById,
  resumeDownloadJobById,
  scanDownloadDirectory,
  startDownloadJob
} from './download-manager';

let mainWindow: BrowserWindow | null = null;
let authWindow: BrowserWindow | null = null;
const authWindows = new Set<BrowserWindow>();
let pendingAuthCallback: { url: string; sessionId: string } | null = null;
let authFlowCompleted = false;
let authCancellationNotified = false;

configureAppLogging();

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

  cancelAllDownloadJobs();

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
  attachWebContentsLogging(mainWindow.webContents, 'main-window');

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

  attachWebContentsLogging(authWindow.webContents, 'auth-window');
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
    attachWebContentsLogging(childWindow.webContents, 'auth-child-window');
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
    return startDownloadJob(event.sender, request);
  });

  ipcMain.handle('download:pause', async (_event, jobId: string) => {
    pauseDownloadJobById(jobId);
  });

  ipcMain.handle('download:resume', async (_event, jobId: string) => {
    resumeDownloadJobById(jobId);
  });

  ipcMain.handle('download:cancel', async (_event, jobId: string) => {
    cancelDownloadJob(jobId);
  });

  ipcMain.handle('help:submit', async (_event, request: HelpRequest) => {
    return submitHelpRequest(request);
  });
}

