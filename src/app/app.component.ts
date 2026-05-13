import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, NgZone, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subject, takeUntil } from 'rxjs';
import {
  AuthState,
  MyPackageDto,
  SharedPackageDto,
  UiFile,
  UiPackage
} from './models/package.models';
import { DownloadEvent, NativeFileInput } from './models/native-api.models';
import { AuthService } from './services/auth.service';
import { DownloadService } from './services/download.service';
import { HelpService } from './services/help.service';
import { NativeService } from './services/native.service';
import { PackageService } from './services/package.service';

const DOWNLOAD_DIR_STORAGE_KEY = 'nda-download-manager.downloadDir';

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

  authState: AuthState;
  activeTab: 'mine' | 'shared' = 'mine';
  myPackages: UiPackage[] = [];
  sharedPackages: UiPackage[] = [];
  selectedPackage: UiPackage | null = null;
  files: UiFile[] = [];
  downloadDirectory = window.localStorage.getItem(DOWNLOAD_DIR_STORAGE_KEY) || '';
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

  private readonly destroyed$ = new Subject<void>();
  private readonly latestJobEvents = new Map<string, DownloadEvent>();
  private readonly jobFileIds = new Map<string, Set<number>>();
  private readonly pausedJobIds = new Set<string>();
  private completingSessionId: string | null = null;
  private readonly handleBeforeUnload = () => {
    this.clearTransientErrors();
    this.auth.clearAuthCache();
  };
  private readonly handlePageShow = () => {
    this.clearTransientErrors();
    this.changeDetector.detectChanges();
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
    this.pausedJobIds.clear();
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

      this.myPackages = myPackages.map((item) => normalizeMyPackage(item));
      this.sharedPackages = sharedPackages.map((item) => normalizeSharedPackage(item));

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
        this.sharedPackages = sharedPackages.map((item) => normalizeSharedPackage(item));
        this.changeDetector.detectChanges();
      });

    void sharedPackagesPromise.catch((error) => {
      this.errorMessage = errorMessage(error);
      this.changeDetector.detectChanges();
    });

    try {
      const myPackages = await this.packages.getMyPackages(state.host, state.token);
      this.myPackages = myPackages.map((item) => normalizeMyPackage(item));

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
      this.files = files.map((file) => ({
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
      }));
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
    this.changeDetector.detectChanges();

    try {
      const associated = await this.packages.associateSharedPackage(this.authState.host, this.authState.token, pkg.id);
      const normalized = normalizeMyPackage(associated);
      this.myPackages = [normalized, ...this.myPackages.filter((item) => item.id !== normalized.id)];
      this.sharedPackages = this.sharedPackages.filter((item) => item.id !== normalized.id);
      this.activeTab = 'mine';
      this.changeDetector.detectChanges();
      await this.selectPackage(normalized);
      this.infoMessage = 'Package added to My Packages.';
      this.changeDetector.detectChanges();
    } catch (error) {
      this.errorMessage = errorMessage(error);
    } finally {
      this.associatingPackageId = null;
      this.changeDetector.detectChanges();
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
      return;
    }

    this.scanning = true;

    try {
      const results = await this.native.scanDownloadDirectory({
        targetDir: this.downloadDirectory,
        packageId: this.selectedPackage.id,
        files: this.files.map((file) => toNativeFile(file))
      });
      const byFileId = new Map(results.map((result) => [result.packageFileId, result]));

      this.files = this.files.map((file) => {
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
      });
    } catch (error) {
      this.errorMessage = errorMessage(error);
    } finally {
      this.scanning = false;
      this.changeDetector.detectChanges();
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
    await this.startDownload(this.files.filter((file) => file.selected && this.canSelectFileForDownload(file)));
  }

  async downloadPackage(): Promise<void> {
    await this.startDownload(this.files.filter((file) => this.canSelectFileForDownload(file)));
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

  async showPackageInFolder(): Promise<void> {
    if (!this.downloadDirectory || !this.selectedPackage) {
      return;
    }

    try {
      await this.scanDownloads();
      if (!this.canShowPackageDownload()) {
        return;
      }

      await this.native.showPackageInFolder({
        targetDir: this.downloadDirectory,
        packageId: this.selectedPackage.id
      });
    } catch (error) {
      this.errorMessage = errorMessage(error);
    }
  }

  async cancelJob(jobId: string): Promise<void> {
    await this.downloads.cancel(jobId);
  }

  async pauseJob(jobId: string): Promise<void> {
    try {
      await this.downloads.pause(jobId);
    } catch (error) {
      this.errorMessage = errorMessage(error);
    }
  }

  async resumeJob(jobId: string): Promise<void> {
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
    this.helpForm.username = this.authState.username || this.helpForm.username;
  }

  closeHelp(): void {
    this.showHelp = false;
  }

  async submitHelp(): Promise<void> {
    this.clearMessages();

    if (!this.helpForm.name.trim() || !this.helpForm.email.trim() || !this.helpForm.message.trim()) {
      this.errorMessage = 'Name, email, and message are required.';
      return;
    }

    this.sendingHelp = true;

    try {
      await this.help.submit({
        name: this.helpForm.name.trim(),
        username: this.helpForm.username.trim(),
        email: this.helpForm.email.trim(),
        message: this.helpForm.message.trim()
      });
      this.showHelp = false;
      this.infoMessage = 'Help request sent.';
    } catch (error) {
      this.errorMessage = errorMessage(error);
    } finally {
      this.sendingHelp = false;
    }
  }

  formatBytes(bytes: number | null | undefined): string {
    if (bytes === null || bytes === undefined) {
      return 'Unknown';
    }

    if (bytes === 0) {
      return '0 B';
    }

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, exponent);
    return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
  }

  formatDate(value: string | null | undefined): string {
    if (!value) {
      return 'Unknown';
    }

    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(value));
  }

  formatDateOnly(value: string | null | undefined): string {
    if (!value) {
      return 'Unknown';
    }

    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit'
    }).format(new Date(value));
  }

  localStatusLabel(file: UiFile): string {
    if (file.downloadStatus === 'paused') {
      return 'Paused';
    }

    if (file.downloadStatus === 'queued') {
      return 'Queued';
    }

    if (file.downloadStatus === 'downloading') {
      return 'Downloading...';
    }

    if (file.downloadStatus === 'fetching-token') {
      return 'Preparing';
    }

    if (file.downloadStatus === 'complete' || file.downloadStatus === 'skipped') {
      return 'Downloaded';
    }

    if (file.downloadStatus === 'error') {
      return 'Failed';
    }

    switch (file.localStatus) {
      case 'downloaded':
        return 'Downloaded';
      case 'partial':
        return 'Partial';
      case 'missing':
        return 'Not downloaded';
      default:
        return 'Unknown';
    }
  }

  isFileDownloadActive(file: UiFile): boolean {
    return file.downloadStatus === 'queued'
      || file.downloadStatus === 'fetching-token'
      || file.downloadStatus === 'downloading';
  }

  isFileDownloadComplete(file: UiFile): boolean {
    return file.downloadStatus === 'complete'
      || file.downloadStatus === 'skipped'
      || file.localStatus === 'downloaded';
  }

  downloadIndicatorLabel(file: UiFile): string {
    if (this.isFileDownloadComplete(file)) {
      return 'Download complete';
    }

    if (this.isFileDownloadActive(file)) {
      return 'Download in progress';
    }

    return 'Not downloaded';
  }

  progressPercent(file: UiFile): number {
    if (file.downloadStatus === 'complete' || file.downloadStatus === 'skipped' || file.localStatus === 'downloaded') {
      return 100;
    }

    const total = file.totalBytes || file.file_size;
    if (!file.receivedBytes || !total) {
      return 0;
    }

    return Math.min(100, Math.round((file.receivedBytes / total) * 100));
  }

  trackPackage(_index: number, pkg: UiPackage): number {
    return pkg.id;
  }

  trackFile(_index: number, file: UiFile): number {
    return file.package_file_id;
  }

  private async startDownload(files: UiFile[]): Promise<void> {
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
      this.latestJobEvents.set(result.jobId, {
        jobId: result.jobId,
        packageId: this.selectedPackage.id,
        packageName: this.selectedPackage.name,
        status: 'queued',
        message: startMessage
      });
      this.syncJobRows();
      this.infoMessage = startMessage;
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
        this.pausedJobIds.delete(jobId);
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
    } else if (event.isPaused === false || event.status === 'job-complete' || event.status === 'error' || event.status === 'cancelled') {
      this.pausedJobIds.delete(event.jobId);
    }

    const previous = this.latestJobEvents.get(event.jobId);
    this.latestJobEvents.set(event.jobId, {
      ...previous,
      ...event
    });
    this.syncJobRows();

    if (event.packageFileId !== undefined) {
      this.files = this.files.map((file) => {
        if (file.package_file_id !== event.packageFileId) {
          return file;
        }

        const completed = event.status === 'complete' || event.status === 'skipped';
        const totalBytes = event.totalBytes ?? file.totalBytes ?? file.file_size;

        return {
          ...file,
          downloadStatus: event.status,
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

    if (event.status === 'error') {
      this.jobFileIds.delete(event.jobId);
      this.errorMessage = event.message || 'Download failed.';
    }

    if (event.status === 'cancelled') {
      this.jobFileIds.delete(event.jobId);
      this.infoMessage = event.message || 'Download cancelled.';
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
      }

      this.latestJobEvents.delete(event.jobId);
      this.syncJobRows();
      this.infoMessage = null;
      void this.scanDownloads();
    }
  }

  private syncJobRows(): void {
    this.jobRows = Array.from(this.latestJobEvents.values())
      .filter((job) => job.status !== 'job-complete')
      .reverse()
      .slice(0, 8);
  }

  private clearMessages(): void {
    this.errorMessage = null;
    this.infoMessage = null;
  }
}

function normalizeMyPackage(item: MyPackageDto): UiPackage {
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

function normalizeSharedPackage(item: SharedPackageDto): UiPackage {
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

function normalizeNumericId(value: unknown, label: string): number {
  const id = Number(value);
  if (!Number.isFinite(id)) {
    throw new Error(`Package response is missing ${label}.`);
  }

  return id;
}

function toNativeFile(file: UiFile): NativeFileInput {
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

function validatePackageId(packageId: number, packageName: string): void {
  if (!Number.isFinite(Number(packageId))) {
    throw new Error(`Package ${packageName || 'selected package'} is missing a package id.`);
  }
}

function formatDownloadStartMessage(files: UiFile[], packageId: number): string {
  const fileName = files.length === 1
    ? files[0].download_alias
    : `${files[0].download_alias} and ${files.length - 1} more`;
  return `Starting to downloading ${fileName} in package ${packageId}...`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
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
