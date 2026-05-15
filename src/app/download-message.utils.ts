import { UiFile } from './models/package.models';

export function formatDownloadStartMessage(files: UiFile[], packageId: number): string {
  const fileName = files.length === 1
    ? files[0].download_alias
    : `${files[0].download_alias} and ${files.length - 1} more`;
  return `Starting to downloading ${fileName} in package ${packageId}...`;
}
