import { net } from 'electron';
import { AUTH_REQUEST_TIMEOUT_MS } from './constants';

export function formatBytes(bytes: number): string {
  if (bytes === 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exponent);
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
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

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMessage = 'RAS request timed out.',
  timeoutMs = AUTH_REQUEST_TIMEOUT_MS
): Promise<Response> {
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
  }, timeoutMs);

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

export function assertHttpUrl(value: string): void {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Only http and https URLs are supported.');
  }
}

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function multilineHtml(value: string | null | undefined): string {
  return escapeHtml(value).replace(/\r?\n/g, '<br>');
}

export function stringOrNoneHtml(value: string | null | undefined): string {
  const text = stringOrEmpty(value).trim();
  return text ? escapeHtml(text) : 'none';
}

export function stringOrEmpty(value: string | null | undefined): string {
  return typeof value === 'string' ? value : '';
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
