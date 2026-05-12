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
  private completingSessionId: string | null = null;
  private readonly clearAuthCacheOnExit = () => this.auth.clearAuthCache();

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
    window.addEventListener('beforeunload', this.clearAuthCacheOnExit);
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
        this.zone.run(() => this.handleDownloadEvent(event));
      });

    if (this.authState.authenticated) {
      this.initialPackageLoad = true;
      void this.refreshPackages().finally(() => {
        this.initialPackageLoad = false;
      });
    }
  }

  ngOnDestroy(): void {
    window.removeEventListener('beforeunload', this.clearAuthCacheOnExit);
    this.auth.clearAuthCache();
    this.packages.clearFileCache();
    this.destroyed$.next();
    this.destroyed$.complete();
  }

  get selectedFileCount(): number {
    return this.files.filter((file) => file.selected).length;
  }

  get allFilesSelected(): boolean {
    return this.files.length > 0 && this.files.every((file) => file.selected);
  }

  get selectedFilesSize(): number {
    return this.files
      .filter((file) => file.selected)
      .reduce((total, file) => total + file.file_size, 0);
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
    this.auth.signOut();
    this.packages.clearFileCache();
    this.myPackages = [];
    this.sharedPackages = [];
    this.selectedPackage = null;
    this.files = [];
    this.initialPackageLoad = false;
    this.infoMessage = 'Signed out.';
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
      await this.preloadPackageFiles(state);

      if (!this.selectedPackage && this.myPackages.length > 0) {
        void this.selectPackage(this.myPackages[0]);
      }
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
      try {
        await this.preloadPackageFiles(state);
      } catch (error) {
        this.errorMessage = errorMessage(error);
      }

      if (!this.selectedPackage && this.myPackages.length > 0) {
        void this.selectPackage(this.myPackages[0]);
      }

      this.changeDetector.detectChanges();
    } catch (error) {
      this.errorMessage = errorMessage(error);
    } finally {
      this.loadingPackages = false;
      this.changeDetector.detectChanges();
    }
  }

  private preloadPackageFiles(state: AuthState): Promise<void> {
    if (!state.token || this.myPackages.length === 0) {
      return Promise.resolve();
    }

    return this.packages.preloadFilesForPackages(
      state.host,
      state.token,
      this.myPackages.map((pkg) => pkg.id)
    );
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

    try {
      const associated = await this.packages.associateSharedPackage(this.authState.host, this.authState.token, pkg.id);
      const normalized = normalizeMyPackage(associated);
      this.myPackages = [normalized, ...this.myPackages.filter((item) => item.id !== normalized.id)];
      this.activeTab = 'mine';
      await this.selectPackage(normalized);
      this.infoMessage = 'Package added to My Packages.';
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
    if (!this.downloadDirectory || this.files.length === 0) {
      return;
    }

    this.scanning = true;

    try {
      const results = await this.native.scanDownloadDirectory({
        targetDir: this.downloadDirectory,
        files: this.files.map((file) => toNativeFile(file))
      });
      const byFileId = new Map(results.map((result) => [result.packageFileId, result]));

      this.files = this.files.map((file) => {
        const result = byFileId.get(file.package_file_id);
        if (!result) {
          return file;
        }

        return {
          ...file,
          localStatus: result.exists ? (result.complete ? 'downloaded' : 'partial') : 'missing',
          localSize: result.size,
          localModifiedAt: result.modifiedAt
        };
      });
    } catch (error) {
      this.errorMessage = errorMessage(error);
    } finally {
      this.scanning = false;
    }
  }

  toggleAllFiles(): void {
    const selected = !this.allFilesSelected;
    this.files = this.files.map((file) => ({ ...file, selected }));
  }

  toggleFile(file: UiFile): void {
    file.selected = !file.selected;
  }

  async downloadSelected(): Promise<void> {
    await this.startDownload(this.files.filter((file) => file.selected));
  }

  async downloadPackage(): Promise<void> {
    await this.startDownload(this.files);
  }

  async cancelJob(jobId: string): Promise<void> {
    await this.downloads.cancel(jobId);
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

  localStatusLabel(file: UiFile): string {
    if (file.downloadStatus === 'downloading') {
      return 'Downloading';
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

    if (!this.selectedPackage || !this.authState.token) {
      this.errorMessage = 'Select a package and sign in first.';
      return;
    }

    if (!this.downloadDirectory) {
      this.errorMessage = 'Select a download directory.';
      return;
    }

    if (files.length === 0) {
      this.errorMessage = 'Select at least one file.';
      return;
    }

    this.startingDownload = true;

    try {
      await this.ensureEnoughDiskSpace(files);
      const currentAuth = await this.auth.refreshToken();
      if (!currentAuth.token) {
        throw new Error('Sign in is required.');
      }

      const result = await this.downloads.start({
        host: currentAuth.host,
        authToken: currentAuth.token,
        sessionId: currentAuth.sessionId,
        packageId: this.selectedPackage.id,
        packageName: this.selectedPackage.name,
        targetDir: this.downloadDirectory,
        files: files.map((file) => toNativeFile(file)),
        fileConcurrency: 2,
        chunkConcurrency: 4
      });

      this.latestJobEvents.set(result.jobId, {
        jobId: result.jobId,
        packageId: this.selectedPackage.id,
        packageName: this.selectedPackage.name,
        status: 'queued',
        message: `${files.length} file${files.length === 1 ? '' : 's'} queued.`
      });
      this.syncJobRows();
      this.infoMessage = 'Download started.';
    } catch (error) {
      this.errorMessage = errorMessage(error);
    } finally {
      this.startingDownload = false;
    }
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

  private async ensureEnoughDiskSpace(files: UiFile[]): Promise<void> {
    const requiredBytes = files.reduce((total, file) => total + file.file_size, 0);
    const space = await this.native.getAvailableSpace(this.downloadDirectory);

    if (space.availableBytes >= requiredBytes) {
      return;
    }

    throw new Error(
      `Not enough disk space in ${this.downloadDirectory}. ` +
      `Required ${this.formatBytes(requiredBytes)}, available ${this.formatBytes(space.availableBytes)}.`
    );
  }

  private handleDownloadEvent(event: DownloadEvent): void {
    const previous = this.latestJobEvents.get(event.jobId);
    this.latestJobEvents.set(event.jobId, {
      ...previous,
      ...event
    });
    this.syncJobRows();

    if (event.packageFileId) {
      this.files = this.files.map((file) => {
        if (file.package_file_id !== event.packageFileId) {
          return file;
        }

        return {
          ...file,
          downloadStatus: event.status,
          receivedBytes: event.receivedBytes ?? file.receivedBytes,
          totalBytes: event.totalBytes ?? file.totalBytes,
          localStatus: event.status === 'complete' || event.status === 'skipped' ? 'downloaded' : file.localStatus,
          localSize: event.status === 'complete' || event.status === 'skipped' ? (event.totalBytes ?? file.file_size) : file.localSize,
          errorMessage: event.status === 'error' ? event.message || 'Download failed.' : file.errorMessage
        };
      });
    }

    if (event.status === 'job-complete') {
      void this.scanDownloads();
    }
  }

  private syncJobRows(): void {
    this.jobRows = Array.from(this.latestJobEvents.values()).reverse().slice(0, 8);
  }

  private clearMessages(): void {
    this.errorMessage = null;
    this.infoMessage = null;
  }
}

function normalizeMyPackage(item: MyPackageDto): UiPackage {
  return {
    id: item.package_id,
    name: item.description || `Package ${item.package_id}`,
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
  return {
    id: item.packageId,
    name: item.packageName,
    description: item.packageDescription,
    fileCount: item.fileCount,
    fileSize: item.fileSize,
    createdDate: item.createdDate,
    source: 'shared',
    raw: item
  };
}

function toNativeFile(file: UiFile): NativeFileInput {
  return {
    packageFileId: file.package_file_id,
    downloadAlias: file.download_alias,
    fileSize: file.file_size
  };
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
