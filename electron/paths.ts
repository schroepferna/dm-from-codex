import fs from 'node:fs';
import { rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { stringOrEmpty } from './utils';

export function resolveInside(baseDir: string, relativeName: string): string {
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

export async function ensurePackageTargetDir(baseDir: string, packageId: number, packageName: string): Promise<string> {
  const targetDir = resolvePackageTargetDir(baseDir, packageId, packageName);
  if (await statIfExists(targetDir)) {
    return targetDir;
  }

  const legacyDir = resolveLegacyPackageTargetDir(baseDir, packageId);
  if (legacyDir !== targetDir && await statIfExists(legacyDir)) {
    try {
      await rename(legacyDir, targetDir);
    } catch (error) {
      if (await statIfExists(targetDir)) {
        return targetDir;
      }

      throw error;
    }
  }

  return targetDir;
}

export function resolvePackageTargetDir(baseDir: string, packageId: number, packageName: string): string {
  const normalizedPackageId = Number(packageId);
  if (!Number.isFinite(normalizedPackageId)) {
    throw new Error('A valid package id is required.');
  }

  return resolveInside(baseDir, packageTargetFolderName(normalizedPackageId, packageName));
}

export function resolveLegacyPackageTargetDir(baseDir: string, packageId: number): string {
  const normalizedPackageId = Number(packageId);
  if (!Number.isFinite(normalizedPackageId)) {
    throw new Error('A valid package id is required.');
  }

  return resolveInside(baseDir, `package_${Math.trunc(normalizedPackageId)}`);
}

export function packageTargetFolderName(packageId: number, packageName: string): string {
  const safePackageName = sanitizePathSegment(packageName) || 'unnamed';
  return `package_${safePackageName}_${Math.trunc(packageId)}`;
}

export function sanitizePathSegment(value: string): string {
  return stringOrEmpty(value)
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '');
}

export async function statIfExists(filePath: string): Promise<fs.Stats | null> {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
}
