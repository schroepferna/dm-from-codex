import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  MyPackageDto,
  PackageFileDto,
  SharedPackageDto
} from '../models/package.models';
import { bearerHeaders, trimTrailingSlash } from './auth.service';

@Injectable({ providedIn: 'root' })
export class PackageService {
  private readonly fileCache = new Map<string, PackageFileDto[]>();
  private readonly fileRequests = new Map<string, Promise<PackageFileDto[]>>();

  constructor(private readonly http: HttpClient) {}

  getMyPackages(host: string, token: string): Promise<MyPackageDto[]> {
    return firstValueFrom(this.http.get<MyPackageDto[]>(
      `${trimTrailingSlash(host)}/api/package/mypackages`,
      { headers: bearerHeaders(token) }
    )).then((packages) => packages.filter((item) => item.status === 'Ready to Download'));
  }

  getSharedPackages(host: string, token: string): Promise<SharedPackageDto[]> {
    return firstValueFrom(this.http.get<SharedPackageDto[]>(
      `${trimTrailingSlash(host)}/api/package/sharedpackages`,
      { headers: bearerHeaders(token) }
    ));
  }

  associateSharedPackage(host: string, token: string, packageId: number): Promise<MyPackageDto> {
    return firstValueFrom(this.http.post<MyPackageDto>(
      `${trimTrailingSlash(host)}/api/package/${packageId}/associate`,
      null,
      { headers: bearerHeaders(token) }
    ));
  }

  async getFiles(host: string, token: string, packageId: number): Promise<PackageFileDto[]> {
    const key = this.fileCacheKey(host, packageId);
    const cached = this.fileCache.get(key);
    if (cached) {
      return cached;
    }

    return this.fetchAndCacheFiles(host, token, packageId);
  }

  async preloadFilesForPackages(
    host: string,
    token: string,
    packageIds: number[],
    concurrency = 4
  ): Promise<void> {
    const uniquePackageIds = Array.from(new Set(packageIds))
      .filter((packageId) => !this.fileCache.has(this.fileCacheKey(host, packageId)));
    const failures: string[] = [];

    await runLimited(uniquePackageIds, concurrency, async (packageId) => {
      try {
        await this.fetchAndCacheFiles(host, token, packageId);
      } catch (error) {
        failures.push(`Package ${packageId}: ${errorMessage(error)}`);
      }
    });

    if (failures.length > 0) {
      throw new Error(`Some package files could not be loaded. ${failures.join(' ')}`);
    }
  }

  clearFileCache(): void {
    this.fileCache.clear();
    this.fileRequests.clear();
  }

  private async fetchAndCacheFiles(host: string, token: string, packageId: number): Promise<PackageFileDto[]> {
    const key = this.fileCacheKey(host, packageId);
    const inFlight = this.fileRequests.get(key);
    if (inFlight) {
      return inFlight;
    }

    const request = firstValueFrom(this.http.get<unknown>(
      `${trimTrailingSlash(host)}/api/package/${packageId}/files`,
      { headers: bearerHeaders(token) }
    )).then((response) => {
      const files = normalizePackageFilesResponse(response);
      this.fileCache.set(key, files);
      return files;
    }).finally(() => {
      this.fileRequests.delete(key);
    });

    this.fileRequests.set(key, request);
    return request;
  }

  private fileCacheKey(host: string, packageId: number): string {
    return `${trimTrailingSlash(host)}:${packageId}`;
  }
}

async function runLimited<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workerCount = Math.min(Math.max(limit, 1), items.length);
  const runners = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]);
    }
  });

  await Promise.all(runners);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }

  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const directMessage = stringValue(record['message']);
    const nestedMessage = stringValue(record['error'])
      || stringValue((record['error'] as Record<string, unknown> | null)?.['message'])
      || stringValue((record['error'] as Record<string, unknown> | null)?.['errorMessage']);

    if (directMessage && nestedMessage && directMessage !== nestedMessage) {
      return `${directMessage}: ${nestedMessage}`;
    }

    if (directMessage) {
      return directMessage;
    }

    if (nestedMessage) {
      return nestedMessage;
    }

    const status = stringValue(record['status']);
    const statusText = stringValue(record['statusText']);
    if (status) {
      return `Request failed with HTTP ${status}${statusText ? ` ${statusText}` : ''}.`;
    }
  }

  return 'An unexpected error occurred.';
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}

function normalizePackageFilesResponse(response: unknown): PackageFileDto[] {
  if (Array.isArray(response)) {
    return response.map(normalizePackageFile);
  }

  if (response && typeof response === 'object') {
    const results = (response as Record<string, unknown>)['results'];
    if (Array.isArray(results)) {
      return results.map(normalizePackageFile);
    }
  }

  throw new Error('Package files response was empty or malformed.');
}

function normalizePackageFile(value: unknown): PackageFileDto {
  if (!value || typeof value !== 'object') {
    throw new Error('Package file response item was empty or malformed.');
  }

  const record = value as Record<string, unknown>;
  const packageFileId = readRequiredNumber(record, ['package_file_id', 'packageFileId'], 'package file id');
  const downloadAlias = readRequiredString(record, ['download_alias', 'downloadAlias'], 'download alias');
  const isAssociatedFile = readBoolean(record, ['is_associated_file', 'isAssociatedFile', 'associatedFile'], false);
  const isDataFile = readBoolean(record, ['is_data_file', 'isDataFile', 'dataFile'], false);
  const isDocumentFile = readBoolean(record, ['is_document_file', 'isDocumentFile', 'documentFile'], false);

  return {
    download_alias: downloadAlias,
    file_size: readNumber(record, ['file_size', 'fileSize'], 0),
    is_associated_file: isAssociatedFile,
    created_date: readString(record, ['created_date', 'createdDate'], ''),
    is_data_file: isDataFile,
    is_document_file: isDocumentFile,
    nda_file_type: readString(record, ['nda_file_type', 'ndaFileType'], ''),
    associatedFile: readBoolean(record, ['associatedFile', 'is_associated_file', 'isAssociatedFile'], isAssociatedFile),
    dataFile: readBoolean(record, ['dataFile', 'is_data_file', 'isDataFile'], isDataFile),
    documentFile: readBoolean(record, ['documentFile', 'is_document_file', 'isDocumentFile'], isDocumentFile),
    package_file_id: packageFileId
  };
}

function readRequiredNumber(record: Record<string, unknown>, keys: string[], label: string): number {
  const value = readNumber(record, keys, Number.NaN);
  if (!Number.isFinite(value)) {
    throw new Error(`Package file response is missing ${label}.`);
  }

  return value;
}

function readNumber(record: Record<string, unknown>, keys: string[], fallback: number): number {
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

function readRequiredString(record: Record<string, unknown>, keys: string[], label: string): string {
  const value = readString(record, keys, '');
  if (!value) {
    throw new Error(`Package file response is missing ${label}.`);
  }

  return value;
}

function readString(record: Record<string, unknown>, keys: string[], fallback: string): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return fallback;
}

function readBoolean(record: Record<string, unknown>, keys: string[], fallback: boolean): boolean {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'string' && value.trim()) {
      return value.trim().toLowerCase() === 'true';
    }
  }

  return fallback;
}
