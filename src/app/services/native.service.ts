import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import {
  AuthCallbackPayload,
  AuthCompleteRequest,
  AuthCompleteResponse,
  AuthVerifySessionRequest,
  AuthVerifySessionResponse,
  AvailableSpaceResult,
  DownloadEvent,
  DownloadStartRequest,
  DownloadStartResult,
  HelpRequest,
  HelpResponse,
  NdaDesktopBridge,
  ScanDownloadRequest,
  ScanDownloadResult,
  ShowPackageRequest
} from '../models/native-api.models';

@Injectable({ providedIn: 'root' })
export class NativeService {
  private get desktopBridge(): NdaDesktopBridge {
    if (!window.ndaDm) {
      throw new Error('The NDA Download Manager must be run in the Electron desktop app.');
    }

    return window.ndaDm;
  }

  get isDesktop(): boolean {
    return Boolean(window.ndaDm);
  }

  openAuthUrl(url: string): Promise<void> {
    return this.desktopBridge.openAuthUrl(url);
  }

  completeSignIn(request: AuthCompleteRequest): Promise<AuthCompleteResponse> {
    return this.desktopBridge.completeSignIn(request);
  }

  verifySession(request: AuthVerifySessionRequest): Promise<AuthVerifySessionResponse> {
    return this.desktopBridge.verifySession(request);
  }

  getDefaultDownloadDirectory(): Promise<string> {
    return this.desktopBridge.getDefaultDownloadDirectory();
  }

  getAvailableSpace(targetDir: string): Promise<AvailableSpaceResult> {
    return this.desktopBridge.getAvailableSpace(targetDir);
  }

  chooseDownloadDirectory(): Promise<string | null> {
    return this.desktopBridge.chooseDownloadDirectory();
  }

  scanDownloadDirectory(request: ScanDownloadRequest): Promise<ScanDownloadResult[]> {
    return this.desktopBridge.scanDownloadDirectory(request);
  }

  showItemInFolder(path: string): Promise<void> {
    return this.desktopBridge.showItemInFolder(path);
  }

  showPackageInFolder(request: ShowPackageRequest): Promise<void> {
    return this.desktopBridge.showPackageInFolder(request);
  }

  startDownloadJob(request: DownloadStartRequest): Promise<DownloadStartResult> {
    return this.desktopBridge.startDownloadJob(request);
  }

  pauseDownloadJob(jobId: string): Promise<void> {
    return this.desktopBridge.pauseDownloadJob(jobId);
  }

  resumeDownloadJob(jobId: string): Promise<void> {
    return this.desktopBridge.resumeDownloadJob(jobId);
  }

  cancelDownloadJob(jobId: string): Promise<void> {
    return this.desktopBridge.cancelDownloadJob(jobId);
  }

  sendHelpRequest(request: HelpRequest): Promise<HelpResponse> {
    return this.desktopBridge.sendHelpRequest(request);
  }

  authCallbacks(): Observable<AuthCallbackPayload> {
    return new Observable((subscriber) => {
      if (!window.ndaDm) {
        subscriber.complete();
        return undefined;
      }

      const unsubscribe = window.ndaDm.onAuthCallback((payload) => subscriber.next(payload));

      void window.ndaDm.getPendingAuthCallback()
        .then((payload) => {
          if (payload) {
            subscriber.next(payload);
          }
        })
        .catch((error) => subscriber.error(error));

      return () => unsubscribe();
    });
  }

  downloadEvents(): Observable<DownloadEvent> {
    return new Observable((subscriber) => {
      if (!window.ndaDm) {
        subscriber.complete();
        return undefined;
      }

      const unsubscribe = window.ndaDm.onDownloadEvent((event) => subscriber.next(event));
      return () => unsubscribe();
    });
  }
}
