import { NativeFileInput } from './models/native-api.models';
import { MyPackageDto, SharedPackageDto, UiFile, UiPackage } from './models/package.models';

export function normalizeMyPackage(item: MyPackageDto): UiPackage {
  const id = normalizeNumericId(item.package_id, 'package id');

  return {
    id,
    name: item.description || `Package ${id}`,
    description: item.source_package_description || item.description || '',
    fileCount: item.file_count,
    fileSize: item.total_package_size,
    createdDate: item.created_date,
    source: 'mine',
    status: item.status,
    raw: item
  };
}

export function normalizeSharedPackage(item: SharedPackageDto): UiPackage {
  const id = normalizeNumericId(item.packageId, 'shared package id');

  return {
    id,
    name: item.packageName,
    description: item.packageDescription,
    fileCount: item.fileCount,
    fileSize: item.fileSize,
    createdDate: item.createdDate,
    source: 'shared',
    raw: item
  };
}

export function toNativeFile(file: UiFile): NativeFileInput {
  const packageFileId = Number(file.package_file_id);
  const fileSize = Number(file.file_size);

  if (!Number.isFinite(packageFileId)) {
    throw new Error(`File ${file.download_alias || 'selected file'} is missing a package file id.`);
  }

  if (!file.download_alias) {
    throw new Error(`File ${packageFileId} is missing a download alias.`);
  }

  return {
    packageFileId,
    downloadAlias: file.download_alias,
    fileSize: Number.isFinite(fileSize) ? fileSize : 0
  };
}

export function validatePackageId(packageId: number, packageName: string): void {
  if (!Number.isFinite(Number(packageId))) {
    throw new Error(`Package ${packageName || 'selected package'} is missing a package id.`);
  }
}

function normalizeNumericId(value: unknown, label: string): number {
  const id = Number(value);
  if (!Number.isFinite(id)) {
    throw new Error(`Package response is missing ${label}.`);
  }

  return id;
}
