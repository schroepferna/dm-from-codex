import { DownloadEvent } from './models/native-api.models';
import { UiFile, UiPackage } from './models/package.models';

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) {
    return 'Unknown';
  }

  if (bytes === 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exponent);
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) {
    return 'Unknown';
  }

  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

export function formatDateOnly(value: string | null | undefined): string {
  if (!value) {
    return 'Unknown';
  }

  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit'
  }).format(new Date(value));
}

export function localStatusLabel(file: UiFile): string {
  if (file.downloadStatus === 'paused') {
    return 'Paused';
  }

  if (file.downloadStatus === 'queued') {
    return 'Queued';
  }

  if (file.downloadStatus === 'downloading') {
    return 'Downloading...';
  }

  if (file.downloadStatus === 'fetching-token') {
    return 'Preparing';
  }

  if (file.downloadStatus === 'complete' || file.downloadStatus === 'skipped') {
    return 'Downloaded';
  }

  if (file.downloadStatus === 'error') {
    return 'Failed';
  }

  switch (file.localStatus) {
    case 'downloaded':
      return 'Downloaded';
    case 'partial':
      return 'Partial';
    case 'missing':
      return 'Not downloaded';
    default:
      return 'Unknown';
  }
}

export function isFileDownloadActive(file: UiFile): boolean {
  return file.downloadStatus === 'queued'
    || file.downloadStatus === 'fetching-token'
    || file.downloadStatus === 'downloading';
}

export function isFileDownloadComplete(file: UiFile): boolean {
  return file.downloadStatus === 'complete'
    || file.downloadStatus === 'skipped'
    || file.localStatus === 'downloaded';
}

export function downloadIndicatorLabel(file: UiFile): string {
  if (isFileDownloadComplete(file)) {
    return 'Download complete';
  }

  if (isFileDownloadActive(file)) {
    return 'Download in progress';
  }

  return 'Not downloaded';
}

export function progressPercent(file: UiFile): number {
  if (file.downloadStatus === 'complete' || file.downloadStatus === 'skipped' || file.localStatus === 'downloaded') {
    return 100;
  }

  const total = file.totalBytes || file.file_size;
  if (!file.receivedBytes || !total) {
    return 0;
  }

  return Math.min(100, Math.round((file.receivedBytes / total) * 100));
}

export function isTerminalJob(job: DownloadEvent): boolean {
  return job.status === 'job-complete' || job.status === 'error' || job.status === 'cancelled';
}

export function trackPackage(_index: number, pkg: UiPackage): number {
  return pkg.id;
}

export function trackFile(_index: number, file: UiFile): number {
  return file.package_file_id;
}
