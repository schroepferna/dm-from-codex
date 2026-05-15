import { NameSortDirection } from './app.types';
import { UiFile, UiPackage } from './models/package.models';

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function nextSortDirection(direction: NameSortDirection): NameSortDirection {
  return direction === 'asc' ? 'desc' : 'asc';
}

export function sortPackagesByName(packages: UiPackage[], direction: NameSortDirection): UiPackage[] {
  const multiplier = direction === 'asc' ? 1 : -1;

  return [...packages].sort((left, right) => {
    const nameCompare = nameCollator.compare(left.name, right.name);
    if (nameCompare !== 0) {
      return nameCompare * multiplier;
    }

    return left.id - right.id;
  });
}

export function sortFilesByName(files: UiFile[], direction: NameSortDirection): UiFile[] {
  const multiplier = direction === 'asc' ? 1 : -1;

  return [...files].sort((left, right) => {
    const nameCompare = nameCollator.compare(left.download_alias, right.download_alias);
    if (nameCompare !== 0) {
      return nameCompare * multiplier;
    }

    return left.package_file_id - right.package_file_id;
  });
}
