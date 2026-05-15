export interface DownloadTargetSummary {
  isPackage: boolean;
  packageName: string;
  fileNames: string[];
}

export interface PackageDownloadSummary {
  fileCount: number;
  downloadableCount: number;
  allFilesDownloaded: boolean;
}

export type NameSortDirection = 'asc' | 'desc';
export type PackageListSource = 'mine' | 'shared';
export type DownloadMode = 'package' | 'selection';
