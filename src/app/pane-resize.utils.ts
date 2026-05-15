import {
  DEFAULT_PACKAGE_PANE_WIDTH,
  MIN_PACKAGE_PANE_WIDTH,
  PACKAGE_PANE_WIDTH_STORAGE_KEY
} from './app.constants';

export function readStoredPackagePaneWidth(): number {
  const storedWidth = Number(window.localStorage.getItem(PACKAGE_PANE_WIDTH_STORAGE_KEY));
  return Number.isFinite(storedWidth)
    ? clampPackagePaneWidth(storedWidth)
    : DEFAULT_PACKAGE_PANE_WIDTH;
}

export function clampPackagePaneWidth(width: number, maxWidth = Number.POSITIVE_INFINITY): number {
  return Math.round(Math.min(Math.max(width, MIN_PACKAGE_PANE_WIDTH), maxWidth));
}
