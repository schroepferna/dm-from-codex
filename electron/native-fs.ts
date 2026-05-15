import { shell } from 'electron';
import { stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { ShowPackageRequest } from './models';
import { ensurePackageTargetDir } from './paths';
import { stringOrEmpty } from './utils';

export async function getAvailableSpace(targetDir: string): Promise<{ availableBytes: number; path: string }> {
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

export async function showItemInFolder(itemPath: string): Promise<void> {
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

export async function showPackageInFolder(request: ShowPackageRequest): Promise<void> {
  if (!request?.targetDir) {
    throw new Error('A download directory is required.');
  }

  if (!stringOrEmpty(request.packageName).trim()) {
    throw new Error('A package name is required.');
  }

  const packageDir = await ensurePackageTargetDir(request.targetDir, request.packageId, request.packageName);
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
