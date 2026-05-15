import { WebContents } from 'electron';
import { PART_MANIFEST_VERSION } from './constants';

export interface NativeFileInput {
  packageFileId: number;
  downloadAlias: string;
  fileSize: number;
}

export interface ScanDownloadRequest {
  targetDir: string;
  packageId: number;
  packageName: string;
  files: NativeFileInput[];
}

export interface ShowPackageRequest {
  targetDir: string;
  packageId: number;
  packageName: string;
}

export interface AuthCompleteRequest {
  host: string;
  sessionId: string;
}

export interface AuthVerifySessionRequest {
  host: string;
  token: string;
  sessionId: string;
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

export interface PresignedDownloadUrlResponse {
  package_file_id: number;
  downloadURL: string;
}

export interface DirectDownloadSource {
  sourceHost: string;
  sourcePath: string;
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

export interface DownloadJob {
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

export type DownloadUrlResult =
  | { ok: true; url: PresignedDownloadUrlResponse }
  | { ok: false; error: unknown };

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

export interface DownloadChunk {
  index: number;
  start: number;
  end: number;
}

export interface PartManifest {
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

export interface PartialDownloadState {
  manifestPath: string;
  completedChunks: Set<number>;
  completedBytes: number;
}

export interface HelpRequest {
  name: string;
  username: string;
  email: string;
  message: string;
  attachments?: HelpAttachment[];
  host?: string;
  packageId?: number | null;
  packageName?: string | null;
  packageSource?: string | null;
  fileCount?: number | null;
  zendeskToken?: string;
}

export interface HelpAttachment {
  name: string;
  mimeType: string;
  size: number;
  dataBase64: string;
}

export interface ZendeskTicketInfo {
  id?: string;
  url?: string;
}
