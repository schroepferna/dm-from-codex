import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, NgZone, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subject, takeUntil } from 'rxjs';
import {
  AuthState,
  UiFile,
  UiPackage
} from './models/package.models';
import { AuthCancelledPayload, DownloadEvent, HelpAttachment, NativeFileInput } from './models/native-api.models';
import {
  DOWNLOAD_DIR_STORAGE_KEY,
  HELP_EMAIL_PATTERN,
  HELP_MAX_ATTACHMENTS,
  HELP_SUBMIT_TIMEOUT_MS,
  LOGIN_GOV_CREATE_ACCOUNT_URL,
  MIN_FILE_PANE_WIDTH,
  MIN_PACKAGE_PANE_WIDTH,
  PACKAGE_PANE_WIDTH_STORAGE_KEY,
  PANE_RESIZER_WIDTH,
  RAS_NEWS_URL
} from './app.constants';
import { DownloadMode, DownloadTargetSummary, NameSortDirection, PackageDownloadSummary, PackageListSource } from './app.types';
import { withTimeout } from './async.utils';
import { formatDownloadStartMessage } from './download-message.utils';
import { errorMessage, isAbortMessage } from './error.utils';
import {
  downloadIndicatorLabel,
  formatBytes,
  formatDate,
  formatDateOnly,
  isFileDownloadActive,
  isFileDownloadComplete,
  localStatusLabel,
  progressPercent,
  trackFile,
  trackPackage
} from './formatting.utils';
import { toHelpAttachment } from './help-attachment.utils';
import { normalizeMyPackage, normalizeSharedPackage, toNativeFile, validatePackageId } from './package-mappers';
import { clampPackagePaneWidth, readStoredPackagePaneWidth } from './pane-resize.utils';
import { nextSortDirection, sortFilesByName, sortPackagesByName } from './sort.utils';
import { AuthService } from './services/auth.service';
import { DownloadService } from './services/download.service';
import { HelpService } from './services/help.service';
import { NativeService } from './services/native.service';
import { PackageService } from './services/package.service';

@Component({
  selector: 'nda-root',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements OnInit, OnDestroy {
  readonly isDesktop: boolean;
  readonly downloadIndicatorLabel = downloadIndicatorLabel;
  readonly formatBytes = formatBytes;
  readonly formatDate = formatDate;
  readonly formatDateOnly = formatDateOnly;
  readonly isFileDownloadActive = isFileDownloadActive;
  readonly isFileDownloadComplete = isFileDownloadComplete;
  readonly localStatusLabel = localStatusLabel;
  readonly progressPercent = progressPercent;
  readonly trackFile = trackFile;
  readonly trackPackage = trackPackage;

  authState: AuthState;
  activeTab: 'mine' | 'shared' = 'mine';
  myPackageNameSortDirection: NameSortDirection = 'asc';
  sharedPackageNameSortDirection: NameSortDirection = 'asc';
  fileNameSortDirection: NameSortDirection = 'asc';
  myPackages: UiPackage[] = [];
  sharedPackages: UiPackage[] = [];
  selectedPackage: UiPackage | null = null;
  files: UiFile[] = [];
  downloadDirectory = window.localStorage.getItem(DOWNLOAD_DIR_STORAGE_KEY) || '';
  packagePaneWidth = readStoredPackagePaneWidth();
  jobRows: DownloadEvent[] = [];
  showHelp = false;
  helpForm = {
    name: '',
    username: '',
    email: '',
    message: ''
  };

  loadingAuth = false;
  loadingPackages = false;
  initialPackageLoad = false;
  loadingFiles = false;
  scanning = false;
  associatingPackageId: number | null = null;
  startingDownload = false;
  sendingHelp = false;
  errorMessage: string | null = null;
  infoMessage: string | null = null;
  helpErrorMessage: string | null = null;
  helpStatusMessage: string | null = null;
  helpAttachments: HelpAttachment[] = [];

  private readonly destroyed$ = new Subject<void>();
  private readonly latestJobEvents = new Map<string, DownloadEvent>();
  private readonly jobFileIds = new Map<string, Set<number>>();
  private readonly jobDownloadTargets = new Map<string, DownloadTargetSummary>();
  private readonly packageDownloadSummaries = new Map<number, PackageDownloadSummary>();
  private readonly pausedJobIds = new Set<string>();
  private readonly cancelledJobIds = new Set<string>();
  private completingSessionId: string | null = null;
  private paneResizeBounds: { left: number; maxWidth: number } | null = null;
  private readonly handleBeforeUnload = () => {
    this.clearTransientErrors();
    this.auth.clearAuthCache();
  };
  private readonly handlePageShow = () => {
    this.clearTransientErrors();
    this.changeDetector.detectChanges();
  };
  private readonly handlePaneResizeMove = (event: PointerEvent) => {
    this.updatePackagePaneWidth(event.clientX);
  };
  private readonly handlePaneResizeEnd = () => {
    window.removeEventListener('pointermove', this.handlePaneResizeMove);
    window.removeEventListener('pointerup', this.handlePaneResizeEnd);
    this.paneResizeBounds = null;
  };

  constructor(
    private readonly auth: AuthService,
    private readonly packages: PackageService,
    private readonly native: NativeService,
    private readonly downloads: DownloadService,
    private readonly help: HelpService,
    private readonly zone: NgZone,
    private readonly changeDetector: ChangeDetectorRef
  ) {
    this.isDesktop = this.native.isDesktop;
    this.authState = this.auth.snapshot;
  }

  ngOnInit(): void {
    this.clearTransientErrors();
    window.addEventListener('beforeunload', this.handleBeforeUnload);
    window.addEventListener('pageshow', this.handlePageShow);
    void this.setDefaultDownloadDirectory();

    this.auth.state$
      .pipe(takeUntil(this.destroyed$))
      .subscribe((state) => {
        this.authState = state;
        this.helpForm.username = state.username || this.helpForm.username;
      });

    this.native.authCallbacks()
      .pipe(takeUntil(this.destroyed$))
      .subscribe((payload) => {
        this.zone.run(() => void this.completeSignIn(payload.sessionId));
      });

    this.native.authCancellations()
      .pipe(takeUntil(this.destroyed$))
      .subscribe((payload) => {
        this.zone.run(() => this.handleAuthCancelled(payload));
      });

    this.downloads.events$
      .pipe(takeUntil(this.destroyed$))
      .subscribe((event) => {
        this.zone.run(() => {
          this.handleDownloadEvent(event);
          this.changeDetector.detectChanges();
        });
      });

    if (this.authState.authenticated) {
      this.initialPackageLoad = true;
      void this.refreshPackages().finally(() => {
        this.initialPackageLoad = false;
      });
    }
  }

  ngOnDestroy(): void {
    window.removeEventListener('beforeunload', this.handleBeforeUnload);
    window.removeEventListener('pageshow', this.handlePageShow);
    this.handlePaneResizeEnd();
    this.auth.clearAuthCache();
    this.packages.clearFileCache();
    this.destroyed$.next();
    this.destroyed$.complete();
  }

  get selectedFileCount(): number {
    return this.files.filter((file) => file.selected && this.canSelectFileForDownload(file)).length;
  }

  get allFilesSelected(): boolean {
    const selectableFiles = this.files.filter((file) => this.canSelectFileForDownload(file));
    return selectableFiles.length > 0 && selectableFiles.every((file) => file.selected);
  }

  get downloadableFileCount(): number {
    return this.files.filter((file) => this.canSelectFileForDownload(file)).length;
  }

  get selectedFilesSize(): number {
    return this.files
      .filter((file) => file.selected && this.canSelectFileForDownload(file))
      .reduce((total, file) => total + file.file_size, 0);
  }

  get downloadInProgress(): boolean {
    return this.startingDownload || this.jobRows.some((job) => !this.isTerminalJob(job));
  }

  get paneGridColumns(): string {
    return `minmax(${MIN_PACKAGE_PANE_WIDTH}px, ${this.packagePaneWidth}px) ${PANE_RESIZER_WIDTH}px minmax(0, 1fr)`;
  }

  startPaneResize(event: PointerEvent, grid: HTMLElement): void {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }

    event.preventDefault();
    const rect = grid.getBoundingClientRect();
    const maxWidth = Math.max(MIN_PACKAGE_PANE_WIDTH, rect.width - MIN_FILE_PANE_WIDTH - PANE_RESIZER_WIDTH);
    this.paneResizeBounds = {
      left: rect.left,
      maxWidth
    };
    this.updatePackagePaneWidth(event.clientX);
    window.addEventListener('pointermove', this.handlePaneResizeMove);
    window.addEventListener('pointerup', this.handlePaneResizeEnd, { once: true });
  }

  resizePaneWithKeyboard(event: KeyboardEvent, grid: HTMLElement): void {
    let nextWidth = this.packagePaneWidth;

    if (event.key === 'ArrowLeft') {
      nextWidth -= 24;
    } else if (event.key === 'ArrowRight') {
      nextWidth += 24;
    } else if (event.key === 'Home') {
      nextWidth = MIN_PACKAGE_PANE_WIDTH;
    } else if (event.key === 'End') {
      nextWidth = this.maxPackagePaneWidth(grid);
    } else {
      return;
    }

    event.preventDefault();
    this.setPackagePaneWidth(nextWidth, this.maxPackagePaneWidth(grid));
  }

  async startSignIn(): Promise<void> {
    this.clearMessages();
    this.loadingAuth = true;

    try {
      await this.auth.signIn();
      this.infoMessage = 'Browser sign-in started.';
    } catch (error) {
      this.errorMessage = errorMessage(error);
    } finally {
      this.loadingAuth = false;
    }
  }

  async completeSignIn(sessionId: string): Promise<void> {
    sessionId = sessionId.trim();

    if (!sessionId) {
      this.errorMessage = 'Session id is required.';
      this.loadingAuth = false;
      this.completingSessionId = null;
      this.changeDetector.detectChanges();
      return;
    }

    if (this.completingSessionId === sessionId || (this.authState.authenticated && this.authState.sessionId === sessionId)) {
      return;
    }

    this.clearMessages();
    this.loadingAuth = true;
    this.completingSessionId = sessionId;
    this.infoMessage = 'Completing RAS sign-in.';

    try {
      const signedInState = await this.auth.completeSignIn(sessionId);
      this.authState = signedInState;
      this.loadingAuth = false;
      this.initialPackageLoad = true;
      this.infoMessage = 'Loading packages.';
      this.changeDetector.detectChanges();
      await this.loadPackagesAfterSignIn(signedInState);
      this.infoMessage = this.myPackages.length === 0 ? 'No packages found.' : 'Signed in.';
    } catch (error) {
      this.errorMessage = errorMessage(error);
    } finally {
      this.loadingAuth = false;
      this.initialPackageLoad = false;
      this.loadingPackages = false;
      this.completingSessionId = null;
      this.changeDetector.detectChanges();
    }
  }

  signOut(): void {
    for (const job of this.jobRows) {
      if (!this.isTerminalJob(job)) {
        void this.downloads.cancel(job.jobId);
      }
    }

    this.auth.signOut();
    this.packages.clearFileCache();
    this.activeTab = 'mine';
    this.myPackages = [];
    this.sharedPackages = [];
    this.selectedPackage = null;
    this.files = [];
    this.jobRows = [];
    this.latestJobEvents.clear();
    this.jobFileIds.clear();
    this.jobDownloadTargets.clear();
    this.packageDownloadSummaries.clear();
    this.pausedJobIds.clear();
    this.cancelledJobIds.clear();
    this.showHelp = false;
    this.helpForm = {
      name: '',
      username: '',
      email: '',
      message: ''
    };
    this.loadingAuth = false;
    this.loadingPackages = false;
    this.initialPackageLoad = false;
    this.loadingFiles = false;
    this.scanning = false;
    this.associatingPackageId = null;
    this.startingDownload = false;
    this.sendingHelp = false;
    this.helpErrorMessage = null;
    this.helpStatusMessage = null;
    this.helpAttachments = [];
    this.completingSessionId = null;
    this.clearMessages();
  }

  async refreshPackages(state: AuthState = this.authState): Promise<void> {
    this.clearMessages();

    if (!state.token) {
      return;
    }

    this.loadingPackages = true;

    try {
      const [myPackages, sharedPackages] = await Promise.all([
        this.packages.getMyPackages(state.host, state.token),
        this.packages.getSharedPackages(state.host, state.token)
      ]);

      this.setMyPackages(myPackages.map((item) => normalizeMyPackage(item)));
      this.setSharedPackages(sharedPackages.map((item) => normalizeSharedPackage(item)));

      if (!this.selectedPackage && this.myPackages.length > 0) {
        void this.selectPackage(this.myPackages[0]);
      }

      this.preloadPackageFilesInBackground(state, this.selectedPackage?.id);
    } catch (error) {
      this.errorMessage = errorMessage(error);
    } finally {
      this.loadingPackages = false;
    }
  }

  private async loadPackagesAfterSignIn(state: AuthState): Promise<void> {
    this.clearMessages();

    if (!state.token) {
      return;
    }

    this.loadingPackages = true;

    const sharedPackagesPromise = this.packages.getSharedPackages(state.host, state.token)
      .then((sharedPackages) => {
        this.setSharedPackages(sharedPackages.map((item) => normalizeSharedPackage(item)));
        this.changeDetector.detectChanges();
      });

    void sharedPackagesPromise.catch((error) => {
      this.errorMessage = errorMessage(error);
      this.changeDetector.detectChanges();
    });

    try {
      const myPackages = await this.packages.getMyPackages(state.host, state.token);
      this.setMyPackages(myPackages.map((item) => normalizeMyPackage(item)));

      if (!this.selectedPackage && this.myPackages.length > 0) {
        void this.selectPackage(this.myPackages[0]);
      }

      this.preloadPackageFilesInBackground(state, this.selectedPackage?.id);
      this.changeDetector.detectChanges();
    } catch (error) {
      this.errorMessage = errorMessage(error);
    } finally {
      this.loadingPackages = false;
      this.changeDetector.detectChanges();
    }
  }

  private preloadPackageFiles(state: AuthState, excludePackageId?: number): Promise<void> {
    if (!state.token || this.myPackages.length === 0) {
      return Promise.resolve();
    }

    const packageIds = this.myPackages
      .map((pkg) => pkg.id)
      .filter((packageId) => packageId !== excludePackageId);

    return this.packages.preloadFilesForPackages(
      state.host,
      state.token,
      packageIds,
      6
    );
  }

  private preloadPackageFilesInBackground(state: AuthState, excludePackageId?: number): void {
    void this.preloadPackageFiles(state, excludePackageId).catch((error) => {
      console.warn('Background package file preload failed.', error);
    });
  }

  async selectPackage(pkg: UiPackage): Promise<void> {
    if (pkg.source !== 'mine') {
      return;
    }

    this.selectedPackage = pkg;
    this.files = [];
    this.loadingFiles = true;
    this.clearMessages();

    try {
      if (!this.authState.token) {
        throw new Error('Sign in is required.');
      }

      const files = await this.packages.getFiles(this.authState.host, this.authState.token, pkg.id);
      this.setFiles(files.map((file) => ({
        ...file,
        selected: false,
        localStatus: 'unknown',
        localSize: null,
        localModifiedAt: null,
        localPath: null,
        downloadStatus: null,
        receivedBytes: 0,
        totalBytes: file.file_size,
        errorMessage: null
      })));
      this.updatePackageDownloadSummary(pkg.id);
      await this.scanDownloads();
    } catch (error) {
      this.errorMessage = errorMessage(error);
    } finally {
      this.loadingFiles = false;
    }
  }

  async associatePackage(pkg: UiPackage): Promise<void> {
    this.clearMessages();

    if (!this.authState.token) {
      this.errorMessage = 'Sign in is required.';
      return;
    }

    this.associatingPackageId = pkg.id;
    this.infoMessage = `Adding ${pkg.name} to my packages...`;

    try {
      const associated = await this.packages.associateSharedPackage(this.authState.host, this.authState.token, pkg.id);
      const normalized = normalizeMyPackage(associated);
      this.setMyPackages([normalized, ...this.myPackages.filter((item) => item.id !== normalized.id)]);
      this.activeTab = 'mine';
      await this.selectPackage(normalized);
      this.infoMessage = `${normalized.name} is added to My Packages`;
    } catch (error) {
      this.errorMessage = errorMessage(error);
    } finally {
      this.associatingPackageId = null;
    }
  }

  async chooseDownloadDirectory(): Promise<void> {
    this.clearMessages();

    try {
      const selected = await this.native.chooseDownloadDirectory();
      if (!selected) {
        return;
      }

      this.downloadDirectory = selected;
      window.localStorage.setItem(DOWNLOAD_DIR_STORAGE_KEY, selected);
      await this.scanDownloads();
    } catch (error) {
      this.errorMessage = errorMessage(error);
    }
  }

  async scanDownloads(): Promise<void> {
    if (!this.downloadDirectory || !this.selectedPackage || this.files.length === 0) {
      if (this.selectedPackage) {
        this.updatePackageDownloadSummary(this.selectedPackage.id);
        this.changeDetector.detectChanges();
      }
      return;
    }

    this.scanning = true;

    try {
      const results = await this.native.scanDownloadDirectory({
        targetDir: this.downloadDirectory,
        packageId: this.selectedPackage.id,
        packageName: this.selectedPackage.name,
        files: this.files.map((file) => toNativeFile(file))
      });
      const byFileId = new Map(results.map((result) => [result.packageFileId, result]));

      this.setFiles(this.files.map((file) => {
        const result = byFileId.get(file.package_file_id);
        if (!result) {
          return {
            ...file,
            localStatus: 'missing',
            localSize: null,
            localModifiedAt: null,
            localPath: null
          };
        }

        const downloaded = result.exists && result.complete;
        return {
          ...file,
          selected: downloaded ? false : file.selected,
          localStatus: result.exists ? (result.complete ? 'downloaded' : 'partial') : 'missing',
          localSize: result.size,
          localModifiedAt: result.modifiedAt,
          localPath: downloaded ? result.path : null,
          downloadStatus: downloaded ? 'complete' : file.downloadStatus === 'downloading' || file.downloadStatus === 'fetching-token' || file.downloadStatus === 'queued'
            ? file.downloadStatus
            : null
        };
      }));
      this.updatePackageDownloadSummary(this.selectedPackage.id);
    } catch (error) {
      this.errorMessage = errorMessage(error);
    } finally {
      this.zone.run(() => {
        this.scanning = false;
        if (this.selectedPackage) {
          this.updatePackageDownloadSummary(this.selectedPackage.id);
        }
        this.changeDetector.detectChanges();
      });
    }
  }

  toggleAllFiles(): void {
    const selected = !this.allFilesSelected;
    this.files = this.files.map((file) => this.canSelectFileForDownload(file)
      ? { ...file, selected }
      : { ...file, selected: false });
  }

  toggleFile(file: UiFile): void {
    if (!this.canSelectFileForDownload(file)) {
      file.selected = false;
      return;
    }

    file.selected = !file.selected;
  }

  async downloadSelected(): Promise<void> {
    await this.startDownload(
      this.files.filter((file) => file.selected && this.canSelectFileForDownload(file)),
      'selection'
    );
  }

  async runPackageAction(pkg: UiPackage): Promise<void> {
    if (this.packageActionLabel(pkg) === 'Show') {
      await this.showPackageInFolder(pkg);
      return;
    }

    await this.downloadPackage(pkg);
  }

  packageActionLabel(pkg: UiPackage): 'Download' | 'Show' {
    return this.isPackageFullyDownloaded(pkg) ? 'Show' : 'Download';
  }

  isPackageActionDisabled(pkg: UiPackage): boolean {
    if (this.downloadInProgress) {
      return true;
    }

    const summary = this.packageDownloadSummaries.get(pkg.id);
    return summary?.fileCount === 0;
  }

  async downloadPackage(pkg: UiPackage | null = this.selectedPackage): Promise<void> {
    if (!pkg || pkg.source !== 'mine') {
      this.errorMessage = 'Select a package and sign in first.';
      return;
    }

    if (this.downloadInProgress) {
      this.errorMessage = 'A download is already in progress.';
      return;
    }

    if (!this.downloadDirectory) {
      this.errorMessage = 'Select a download directory.';
      return;
    }

    if (this.selectedPackage?.id !== pkg.id) {
      await this.selectPackage(pkg);
    }

    if (this.errorMessage) {
      return;
    }

    if (this.selectedPackage?.id !== pkg.id) {
      return;
    }

    if (this.canShowPackageDownload()) {
      await this.showPackageInFolder(pkg);
      return;
    }

    await this.startDownload(
      this.files.filter((file) => this.canSelectFileForDownload(file)),
      'package'
    );
  }

  canShowFile(file: UiFile): boolean {
    return file.localStatus === 'downloaded' && Boolean(file.localPath);
  }

  canSelectFileForDownload(file: UiFile): boolean {
    return !this.isFileDownloadComplete(file);
  }

  canShowPackageDownload(): boolean {
    return Boolean(this.selectedPackage)
      && this.files.length > 0
      && this.files.every((file) => this.canShowFile(file));
  }

  isPackageFullyDownloaded(pkg: UiPackage): boolean {
    return this.packageDownloadSummaries.get(pkg.id)?.allFilesDownloaded === true;
  }

  togglePackageNameSort(source: PackageListSource): void {
    if (source === 'mine') {
      this.myPackageNameSortDirection = nextSortDirection(this.myPackageNameSortDirection);
      this.setMyPackages(this.myPackages);
      return;
    }

    this.sharedPackageNameSortDirection = nextSortDirection(this.sharedPackageNameSortDirection);
    this.setSharedPackages(this.sharedPackages);
  }

  packageNameSortLabel(source: PackageListSource): string {
    const direction = source === 'mine' ? this.myPackageNameSortDirection : this.sharedPackageNameSortDirection;
    return direction === 'asc' ? 'A-Z' : 'Z-A';
  }

  packageNameSortAriaLabel(source: PackageListSource): string {
    const direction = source === 'mine' ? this.myPackageNameSortDirection : this.sharedPackageNameSortDirection;
    const nextDirection = direction === 'asc' ? 'descending' : 'ascending';
    return `Sort ${source === 'mine' ? 'My Packages' : 'Shared Packages'} by package name ${nextDirection}`;
  }

  toggleFileNameSort(): void {
    this.fileNameSortDirection = nextSortDirection(this.fileNameSortDirection);
    this.setFiles(this.files);
  }

  fileNameSortLabel(): string {
    return this.fileNameSortDirection === 'asc' ? 'A-Z' : 'Z-A';
  }

  fileNameSortAriaLabel(): string {
    const nextDirection = this.fileNameSortDirection === 'asc' ? 'descending' : 'ascending';
    return `Sort package files by file name ${nextDirection}`;
  }

  async showFileInFolder(file: UiFile): Promise<void> {
    try {
      await this.scanDownloads();
      const current = this.files.find((item) => item.package_file_id === file.package_file_id);
      if (!current || !this.canShowFile(current) || !current.localPath) {
        return;
      }

      await this.native.showItemInFolder(current.localPath);
    } catch (error) {
      this.errorMessage = errorMessage(error);
    }
  }

  async showPackageInFolder(pkg: UiPackage | null = this.selectedPackage): Promise<void> {
    if (!this.downloadDirectory || !pkg) {
      return;
    }

    try {
      if (this.selectedPackage?.id !== pkg.id) {
        await this.selectPackage(pkg);
      }

      if (this.errorMessage || this.selectedPackage?.id !== pkg.id) {
        return;
      }

      await this.scanDownloads();
      if (!this.canShowPackageDownload()) {
        return;
      }

      await this.native.showPackageInFolder({
        targetDir: this.downloadDirectory,
        packageId: pkg.id,
        packageName: pkg.name
      });
    } catch (error) {
      this.errorMessage = errorMessage(error);
    }
  }

  get activeDownloadPaused(): boolean {
    const job = this.activeDownloadJob();
    return Boolean(job && this.isJobPaused(job));
  }

  canPauseActiveDownload(): boolean {
    const job = this.activeDownloadJob();
    return Boolean(job && (this.canPauseJob(job) || this.canResumeJob(job)));
  }

  canCancelActiveDownload(): boolean {
    const job = this.activeDownloadJob();
    return Boolean(job && this.canCancelJob(job));
  }

  async togglePauseActiveDownload(): Promise<void> {
    const job = this.activeDownloadJob();
    if (!job) {
      return;
    }

    if (this.isJobPaused(job)) {
      await this.resumeJob(job.jobId);
      return;
    }

    await this.pauseJob(job.jobId);
  }

  async cancelActiveDownload(): Promise<void> {
    const job = this.activeDownloadJob();
    if (!job) {
      return;
    }

    await this.cancelJob(job.jobId);
  }

  async cancelJob(jobId: string): Promise<void> {
    this.infoMessage = this.formatDownloadActionMessage('Cancel', jobId);
    this.cancelledJobIds.add(jobId);
    this.pausedJobIds.delete(jobId);
    this.clearJobFilesForCancel(jobId);
    this.markJobRowStatus(jobId, 'cancelled');

    try {
      await this.downloads.cancel(jobId);
    } catch (error) {
      this.errorMessage = errorMessage(error);
    }
  }

  async pauseJob(jobId: string): Promise<void> {
    this.infoMessage = this.formatDownloadActionMessage('Pause', jobId);
    this.pausedJobIds.add(jobId);
    this.applyPausedStatusToJobFiles(jobId);
    this.markJobRowStatus(jobId, 'paused');

    try {
      await this.downloads.pause(jobId);
    } catch (error) {
      this.pausedJobIds.delete(jobId);
      this.errorMessage = errorMessage(error);
    }
  }

  async resumeJob(jobId: string): Promise<void> {
    this.infoMessage = null;

    try {
      await this.downloads.resume(jobId);
    } catch (error) {
      this.errorMessage = errorMessage(error);
    }
  }

  isJobPaused(job: DownloadEvent): boolean {
    return this.pausedJobIds.has(job.jobId);
  }

  isTerminalJob(job: DownloadEvent): boolean {
    return job.status === 'job-complete' || job.status === 'error' || job.status === 'cancelled';
  }

  canPauseJob(job: DownloadEvent): boolean {
    return this.isDesktop && !this.isTerminalJob(job) && !this.isJobPaused(job);
  }

  canResumeJob(job: DownloadEvent): boolean {
    return this.isDesktop && !this.isTerminalJob(job) && this.isJobPaused(job);
  }

  canCancelJob(job: DownloadEvent): boolean {
    return this.isDesktop && !this.isTerminalJob(job);
  }

  jobStatusLabel(job: DownloadEvent): string {
    return this.isJobPaused(job) ? 'paused' : job.status;
  }

  openHelp(): void {
    this.showHelp = true;
    this.helpErrorMessage = null;
    this.helpStatusMessage = null;
    this.helpForm.username = this.authState.username || this.helpForm.username;
  }

  async openLoginGovCreateAccount(): Promise<void> {
    this.clearMessages();

    try {
      await this.native.openExternalUrl(LOGIN_GOV_CREATE_ACCOUNT_URL);
    } catch (error) {
      this.errorMessage = errorMessage(error);
    }
  }

  async openRasNews(event: MouseEvent): Promise<void> {
    event.preventDefault();
    this.clearMessages();

    try {
      await this.native.openExternalUrl(RAS_NEWS_URL);
    } catch (error) {
      this.errorMessage = errorMessage(error);
    }
  }

  closeHelp(): void {
    this.showHelp = false;
    this.helpErrorMessage = null;
    this.helpStatusMessage = null;
  }

  helpEmailInvalid(): boolean {
    const email = this.helpForm.email.trim();
    return email.length > 0 && !HELP_EMAIL_PATTERN.test(email);
  }

  async addHelpAttachments(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const selectedFiles = Array.from(input.files ?? []);
    input.value = '';

    if (selectedFiles.length === 0) {
      return;
    }

    this.helpErrorMessage = null;

    if (this.helpAttachments.length + selectedFiles.length > HELP_MAX_ATTACHMENTS) {
      this.helpErrorMessage = `Attach up to ${HELP_MAX_ATTACHMENTS} files.`;
      return;
    }

    try {
      const attachments = await Promise.all(selectedFiles.map((file) => toHelpAttachment(file)));
      this.helpAttachments = [...this.helpAttachments, ...attachments];
    } catch (error) {
      this.helpErrorMessage = errorMessage(error);
    } finally {
      this.changeDetector.detectChanges();
    }
  }

  removeHelpAttachment(index: number): void {
    this.helpAttachments = this.helpAttachments.filter((_attachment, attachmentIndex) => attachmentIndex !== index);
  }

  async submitHelp(): Promise<void> {
    this.clearMessages();
    this.helpErrorMessage = null;
    this.helpStatusMessage = null;

    const name = this.helpForm.name.trim();
    const username = this.helpForm.username.trim();
    const email = this.helpForm.email.trim();
    const message = this.helpForm.message.trim();

    if (!name || !email || !message) {
      this.errorMessage = 'Name, email, and message are required.';
      this.helpErrorMessage = this.errorMessage;
      return;
    }

    if (!HELP_EMAIL_PATTERN.test(email)) {
      this.errorMessage = 'Enter a valid email address.';
      this.helpErrorMessage = this.errorMessage;
      return;
    }

    this.sendingHelp = true;
    this.helpStatusMessage = 'Sending Help Request...';

    try {
      const result = await withTimeout(this.help.submit({
        name,
        username,
        email,
        message,
        attachments: this.helpAttachments,
        host: this.authState.host,
        packageId: this.selectedPackage?.id ?? null,
        packageName: this.selectedPackage?.name ?? null,
        packageSource: this.selectedPackage?.source ?? null,
        fileCount: this.selectedPackage?.fileCount ?? (this.files.length || null)
      }), HELP_SUBMIT_TIMEOUT_MS, 'Help request timed out. Please try again.');
      this.showHelp = false;
      this.helpAttachments = [];
      this.helpStatusMessage = null;
      this.infoMessage = result.ticketId
        ? `Successfully created Zendesk ticket. Ticket ID is ${result.ticketId}`
        : 'Successfully created Zendesk ticket. Ticket ID is unavailable.';
    } catch (error) {
      this.errorMessage = errorMessage(error);
      this.helpErrorMessage = this.errorMessage;
      this.helpStatusMessage = null;
    } finally {
      this.sendingHelp = false;
      this.changeDetector.detectChanges();
    }
  }

  private setMyPackages(packages: UiPackage[]): void {
    this.myPackages = sortPackagesByName(packages, this.myPackageNameSortDirection);
  }

  private setSharedPackages(packages: UiPackage[]): void {
    this.sharedPackages = sortPackagesByName(packages, this.sharedPackageNameSortDirection);
  }

  private setFiles(files: UiFile[]): void {
    this.files = sortFilesByName(files, this.fileNameSortDirection);
  }

  private async startDownload(files: UiFile[], mode: DownloadMode): Promise<void> {
    this.clearMessages();
    const filesToDownload = files.filter((file) => this.canSelectFileForDownload(file));

    if (!this.selectedPackage || !this.authState.token) {
      this.errorMessage = 'Select a package and sign in first.';
      return;
    }

    if (!this.downloadDirectory) {
      this.errorMessage = 'Select a download directory.';
      return;
    }

    if (filesToDownload.length === 0) {
      this.errorMessage = 'Select at least one file that has not been downloaded.';
      return;
    }

    if (this.downloadInProgress) {
      this.errorMessage = 'A download is already in progress.';
      return;
    }

    let nativeFiles: NativeFileInput[];
    try {
      nativeFiles = filesToDownload.map((file) => toNativeFile(file));
      validatePackageId(this.selectedPackage.id, this.selectedPackage.name);
    } catch (error) {
      this.errorMessage = errorMessage(error);
      return;
    }

    this.clearPreviousDownloadErrors();
    this.startingDownload = true;
    this.infoMessage = `Preparing ${filesToDownload.length} file${filesToDownload.length === 1 ? '' : 's'} for download.`;
    this.files = this.files.map((file) => filesToDownload.some((selected) => selected.package_file_id === file.package_file_id)
      ? {
          ...file,
          downloadStatus: 'queued',
          receivedBytes: 0,
          totalBytes: file.file_size,
          errorMessage: null
        }
      : file);

    try {
      const startMessage = formatDownloadStartMessage(filesToDownload, this.selectedPackage.id);
      this.infoMessage = startMessage;
      const result = await withTimeout(this.downloads.start({
        host: this.authState.host,
        authToken: this.authState.token,
        sessionId: this.authState.sessionId,
        packageId: this.selectedPackage.id,
        packageName: this.selectedPackage.name,
        targetDir: this.downloadDirectory,
        files: nativeFiles,
        fileConcurrency: 2,
        tokenConcurrency: 8,
        chunkConcurrency: 4
      }), 15000, 'Starting the download job timed out before Electron acknowledged it.');

      this.jobFileIds.set(result.jobId, new Set(nativeFiles.map((file) => file.packageFileId)));
      this.jobDownloadTargets.set(result.jobId, {
        isPackage: mode === 'package',
        packageName: this.selectedPackage.name,
        fileNames: nativeFiles.map((file) => file.downloadAlias)
      });
      if (!this.latestJobEvents.has(result.jobId)) {
        this.latestJobEvents.set(result.jobId, {
          jobId: result.jobId,
          packageId: this.selectedPackage.id,
          packageName: this.selectedPackage.name,
          status: 'queued',
          message: startMessage
        });
      }
      this.applyCurrentJobStateToFiles(result.jobId);
      this.syncJobRows();
      if (!this.pausedJobIds.has(result.jobId) && !this.cancelledJobIds.has(result.jobId) && this.latestJobEvents.get(result.jobId)?.status !== 'cancelled') {
        this.infoMessage = startMessage;
      }
    } catch (error) {
      this.errorMessage = errorMessage(error);
    } finally {
      this.startingDownload = false;
    }
  }

  private clearPreviousDownloadErrors(): void {
    let removedJobError = false;

    for (const [jobId, event] of this.latestJobEvents) {
      if (event.status === 'error') {
        this.latestJobEvents.delete(jobId);
        this.jobFileIds.delete(jobId);
        this.jobDownloadTargets.delete(jobId);
        this.pausedJobIds.delete(jobId);
        this.cancelledJobIds.delete(jobId);
        removedJobError = true;
      }
    }

    if (removedJobError) {
      this.syncJobRows();
    }

    this.files = this.files.map((file) => file.downloadStatus === 'error'
      ? {
          ...file,
          downloadStatus: null,
          receivedBytes: 0,
          totalBytes: file.file_size,
          errorMessage: null
        }
      : file);
  }

  private clearTransientErrors(): void {
    this.errorMessage = null;
    this.clearPreviousDownloadErrors();
  }

  private async setDefaultDownloadDirectory(): Promise<void> {
    if (this.downloadDirectory) {
      return;
    }

    try {
      const defaultDirectory = await this.native.getDefaultDownloadDirectory();
      if (!defaultDirectory) {
        return;
      }

      this.downloadDirectory = defaultDirectory;
      window.localStorage.setItem(DOWNLOAD_DIR_STORAGE_KEY, defaultDirectory);
      this.changeDetector.detectChanges();
    } catch (error) {
      this.errorMessage = errorMessage(error);
    }
  }

  private handleDownloadEvent(event: DownloadEvent): void {
    if (event.isPaused === true) {
      this.pausedJobIds.add(event.jobId);
    } else if (
      (event.isPaused === false && event.packageFileId === undefined)
      || event.status === 'job-complete'
      || (event.status === 'error' && event.packageFileId === undefined)
      || event.status === 'cancelled'
    ) {
      this.pausedJobIds.delete(event.jobId);
    }

    if (event.status === 'cancelled') {
      this.cancelledJobIds.add(event.jobId);
    }

    this.updateJobRow(event);
    this.syncJobRows();

    if (event.packageFileId === undefined) {
      this.applyJobEventToFiles(event);
    }

    if (event.packageFileId !== undefined) {
      this.files = this.files.map((file) => {
        if (file.package_file_id !== event.packageFileId) {
          return file;
        }

        const completed = event.status === 'complete' || event.status === 'skipped';
        const totalBytes = event.totalBytes ?? file.totalBytes ?? file.file_size;
        const downloadStatus = this.cancelledJobIds.has(event.jobId)
          ? null
          : this.pausedJobIds.has(event.jobId) && this.isActiveDownloadStatus(event.status)
            ? 'paused'
            : event.status;

        return {
          ...file,
          downloadStatus,
          receivedBytes: completed ? totalBytes : event.receivedBytes ?? file.receivedBytes,
          totalBytes,
          localStatus: completed ? 'downloaded' : file.localStatus,
          localSize: completed ? totalBytes : file.localSize,
          localPath: completed ? (event.path ?? file.localPath) : file.localPath,
          selected: completed ? false : file.selected,
          errorMessage: event.status === 'error' ? event.message || 'Download failed.' : file.errorMessage
        };
      });
    }

    if (event.status === 'error' && event.packageFileId === undefined) {
      this.jobFileIds.delete(event.jobId);
      this.jobDownloadTargets.delete(event.jobId);
      this.cancelledJobIds.delete(event.jobId);
      if (!isAbortMessage(event.message)) {
        this.errorMessage = this.formatPackageDownloadFailureMessage(event);
      }
    }

    if (event.status === 'cancelled') {
      this.jobFileIds.delete(event.jobId);
      this.jobDownloadTargets.delete(event.jobId);
    }

    if (event.status === 'job-complete') {
      const completedFileIds = this.jobFileIds.get(event.jobId);
      if (completedFileIds) {
        this.files = this.files.map((file) => {
          if (!completedFileIds.has(file.package_file_id)) {
            return file;
          }

          const totalBytes = file.totalBytes || file.file_size;
          return {
            ...file,
            downloadStatus: 'complete',
            receivedBytes: totalBytes,
            totalBytes,
            localStatus: 'downloaded',
            localSize: totalBytes,
            localPath: file.localPath,
            selected: false,
            errorMessage: null
          };
        });
        this.jobFileIds.delete(event.jobId);
        this.jobDownloadTargets.delete(event.jobId);
        this.cancelledJobIds.delete(event.jobId);
      }

      this.latestJobEvents.delete(event.jobId);
      this.syncJobRows();
      this.infoMessage = null;
      void this.scanDownloads();
    }

    if (this.selectedPackage) {
      this.updatePackageDownloadSummary(this.selectedPackage.id);
    }
  }

  private applyPausedStatusToJobFiles(jobId: string): void {
    const fileIds = this.jobFileIds.get(jobId);
    if (!fileIds) {
      return;
    }

    this.files = this.files.map((file) => fileIds.has(file.package_file_id) && !this.isFileDownloadComplete(file)
      ? { ...file, downloadStatus: 'paused' }
      : file);
  }

  private applyCurrentJobStateToFiles(jobId: string): void {
    const job = this.latestJobEvents.get(jobId);
    if (!job) {
      return;
    }

    if (this.pausedJobIds.has(jobId) || job.status === 'paused') {
      this.applyPausedStatusToJobFiles(jobId);
      return;
    }

    if (this.cancelledJobIds.has(jobId) || job.status === 'cancelled') {
      this.clearJobFilesForCancel(jobId);
      this.jobFileIds.delete(jobId);
      this.jobDownloadTargets.delete(jobId);
    }
  }

  private clearJobFilesForCancel(jobId: string): void {
    const fileIds = this.jobFileIds.get(jobId);
    if (!fileIds) {
      return;
    }

    this.files = this.files.map((file) => fileIds.has(file.package_file_id) && !this.isFileDownloadComplete(file)
      ? {
          ...file,
          downloadStatus: null,
          receivedBytes: 0,
          totalBytes: file.file_size,
          errorMessage: null
        }
      : file);
  }

  private formatDownloadActionMessage(action: 'Pause' | 'Cancel', jobId: string): string {
    const target = this.jobDownloadTargets.get(jobId);
    const job = this.latestJobEvents.get(jobId);
    const packageName = target?.packageName || job?.packageName || 'selected package';

    if (!target || target.isPackage) {
      return `${action} downloading Package ${packageName}`;
    }

    if (target.fileNames.length === 1) {
      return `${action} downloading file ${target.fileNames[0]}`;
    }

    const listedNames = target.fileNames.slice(0, 5).join(', ');
    const remainingCount = target.fileNames.length - 5;
    return `${action} downloading files ${listedNames}${remainingCount > 0 ? ` and ${remainingCount} more` : ''}`;
  }

  private formatPackageDownloadFailureMessage(event: DownloadEvent): string {
    return `Failed to download files in Package ${event.packageName} with ID ${event.packageId}`;
  }

  private markJobRowStatus(jobId: string, status: DownloadEvent['status']): void {
    const previous = this.latestJobEvents.get(jobId);
    if (!previous) {
      return;
    }

    this.latestJobEvents.set(jobId, {
      ...previous,
      status,
      isPaused: status === 'paused'
    });
    this.syncJobRows();
  }

  private updateJobRow(event: DownloadEvent): void {
    const previous = this.latestJobEvents.get(event.jobId);

    if (event.packageFileId === undefined) {
      this.latestJobEvents.set(event.jobId, {
        ...previous,
        ...event
      });
      return;
    }

    let status = previous?.status ?? event.status;
    let message = previous?.message ?? event.message;

    if (this.cancelledJobIds.has(event.jobId)) {
      status = 'cancelled';
      message = previous?.message ?? 'Download cancelled.';
    } else if (this.pausedJobIds.has(event.jobId)) {
      status = 'paused';
    } else if (this.isActiveDownloadStatus(event.status) || event.status === 'cancelled') {
      status = event.status;
      message = event.message ?? previous?.message;
    } else if (event.status === 'error') {
      status = previous && !this.isTerminalJob(previous) ? previous.status : 'downloading';
      message = previous?.message ?? event.message;
    } else if (!previous || previous.status === 'queued') {
      status = 'downloading';
    }

    this.latestJobEvents.set(event.jobId, {
      jobId: event.jobId,
      packageId: event.packageId,
      packageName: event.packageName,
      status,
      isPaused: this.pausedJobIds.has(event.jobId),
      message
    });
  }

  private handleAuthCancelled(_payload: AuthCancelledPayload): void {
    if (this.authState.authenticated) {
      return;
    }

    this.loadingAuth = false;
    this.initialPackageLoad = false;
    this.completingSessionId = null;
    this.clearMessages();
    this.changeDetector.detectChanges();
  }

  private applyJobEventToFiles(event: DownloadEvent): void {
    const fileIds = this.jobFileIds.get(event.jobId);
    if (!fileIds) {
      return;
    }

    if (event.status === 'paused') {
      this.files = this.files.map((file) => fileIds.has(file.package_file_id) && !this.isFileDownloadComplete(file)
        ? { ...file, downloadStatus: 'paused' }
        : file);
      return;
    }

    if (event.status === 'downloading' && event.isPaused === false) {
      this.files = this.files.map((file) => fileIds.has(file.package_file_id) && file.downloadStatus === 'paused'
        ? { ...file, downloadStatus: 'queued' }
        : file);
      return;
    }

    if (event.status === 'cancelled') {
      this.files = this.files.map((file) => fileIds.has(file.package_file_id) && !this.isFileDownloadComplete(file)
        ? {
            ...file,
            downloadStatus: null,
            receivedBytes: 0,
            totalBytes: file.file_size,
            errorMessage: null
          }
        : file);
      return;
    }

    if (event.status === 'error') {
      this.files = this.files.map((file) => fileIds.has(file.package_file_id) && !this.isFileDownloadComplete(file)
        ? {
            ...file,
            downloadStatus: 'error',
            errorMessage: event.message || 'Download failed.'
          }
        : file);
    }
  }

  private isActiveDownloadStatus(status: DownloadEvent['status']): boolean {
    return status === 'queued' || status === 'fetching-token' || status === 'downloading';
  }

  private syncJobRows(): void {
    this.jobRows = Array.from(this.latestJobEvents.values())
      .filter((job) => job.status !== 'job-complete')
      .reverse()
      .slice(0, 8);
  }

  private activeDownloadJob(): DownloadEvent | null {
    return this.jobRows.find((job) => !this.isTerminalJob(job)) ?? null;
  }

  private updatePackageDownloadSummary(packageId: number): void {
    this.packageDownloadSummaries.set(packageId, {
      fileCount: this.files.length,
      downloadableCount: this.files.filter((file) => this.canSelectFileForDownload(file)).length,
      allFilesDownloaded: this.files.length > 0 && this.files.every((file) => this.isFileDownloadComplete(file))
    });
  }

  private clearMessages(): void {
    this.errorMessage = null;
    this.infoMessage = null;
  }

  private updatePackagePaneWidth(clientX: number): void {
    if (!this.paneResizeBounds) {
      return;
    }

    this.setPackagePaneWidth(clientX - this.paneResizeBounds.left, this.paneResizeBounds.maxWidth);
  }

  private maxPackagePaneWidth(grid: HTMLElement): number {
    return Math.max(
      MIN_PACKAGE_PANE_WIDTH,
      grid.getBoundingClientRect().width - MIN_FILE_PANE_WIDTH - PANE_RESIZER_WIDTH
    );
  }

  private setPackagePaneWidth(width: number, maxWidth: number): void {
    this.packagePaneWidth = clampPackagePaneWidth(width, maxWidth);
    window.localStorage.setItem(PACKAGE_PANE_WIDTH_STORAGE_KEY, String(this.packagePaneWidth));
    this.changeDetector.detectChanges();
  }
}
