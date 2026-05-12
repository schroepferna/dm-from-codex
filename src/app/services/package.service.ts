import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  MyPackageDto,
  PackageFileDto,
  PackageFilesResponse,
  SharedPackageDto
} from '../models/package.models';
import { bearerHeaders, trimTrailingSlash } from './auth.service';

@Injectable({ providedIn: 'root' })
export class PackageService {
  private readonly fileCache = new Map<string, PackageFileDto[]>();

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
  }

  private async fetchAndCacheFiles(host: string, token: string, packageId: number): Promise<PackageFileDto[]> {
    const response = await firstValueFrom(this.http.get<PackageFilesResponse>(
      `${trimTrailingSlash(host)}/api/package/${packageId}/files`,
      { headers: bearerHeaders(token) }
    ));

    this.fileCache.set(this.fileCacheKey(host, packageId), response.results);
    return response.results;
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
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return 'An unexpected error occurred.';
}
