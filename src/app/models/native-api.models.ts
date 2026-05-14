export interface NativeFileInput {
  packageFileId: number;
  downloadAlias: string;
  fileSize: number;
}

export interface ScanDownloadRequest {
  targetDir: string;
  packageId: number;
  files: NativeFileInput[];
}

export interface ScanDownloadResult {
  packageFileId: number;
  downloadAlias: string;
  exists: boolean;
  complete: boolean;
  size: number | null;
  modifiedAt: string | null;
  path: string | null;
  error?: string;
}

export interface AvailableSpaceResult {
  availableBytes: number;
  path: string;
}

export interface ShowPackageRequest {
  targetDir: string;
  packageId: number;
}

export interface DownloadStartRequest {
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

export interface DownloadStartResult {
  jobId: string;
}

export interface DownloadEvent {
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

export interface AuthCallbackPayload {
  url: string;
  sessionId: string;
}

export interface AuthCancelledPayload {
  message: string;
}

export interface AuthCompleteRequest {
  host: string;
  sessionId: string;
}

export interface AuthCompleteResponse {
  token: string;
  username: string | null;
}

export interface AuthVerifySessionRequest {
  host: string;
  token: string;
  sessionId: string;
}

export interface AuthVerifySessionResponse {
  valid: boolean;
  username: string | null;
  errorMessage: string | null;
}

export interface HelpRequest {
  name: string;
  username: string;
  email: string;
  message: string;
  zendeskToken?: string;
}

export interface HelpResponse {
  ok: boolean;
  status: number;
  message: string;
}

export interface NdaDesktopBridge {
  openAuthUrl(url: string): Promise<void>;
  openExternalUrl(url: string): Promise<void>;
  getPendingAuthCallback(): Promise<AuthCallbackPayload | null>;
  completeSignIn(request: AuthCompleteRequest): Promise<AuthCompleteResponse>;
  verifySession(request: AuthVerifySessionRequest): Promise<AuthVerifySessionResponse>;
  getDefaultDownloadDirectory(): Promise<string>;
  getAvailableSpace(targetDir: string): Promise<AvailableSpaceResult>;
  chooseDownloadDirectory(): Promise<string | null>;
  scanDownloadDirectory(request: ScanDownloadRequest): Promise<ScanDownloadResult[]>;
  showItemInFolder(path: string): Promise<void>;
  showPackageInFolder(request: ShowPackageRequest): Promise<void>;
  startDownloadJob(request: DownloadStartRequest): Promise<DownloadStartResult>;
  pauseDownloadJob(jobId: string): Promise<void>;
  resumeDownloadJob(jobId: string): Promise<void>;
  cancelDownloadJob(jobId: string): Promise<void>;
  sendHelpRequest(request: HelpRequest): Promise<HelpResponse>;
  onAuthCallback(callback: (payload: AuthCallbackPayload) => void): () => void;
  onAuthCancelled(callback: (payload: AuthCancelledPayload) => void): () => void;
  onDownloadEvent(callback: (event: DownloadEvent) => void): () => void;
}

declare global {
  interface Window {
    ndaDm?: NdaDesktopBridge;
  }
}
