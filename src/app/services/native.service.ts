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
  ScanDownloadRequest,
  ScanDownloadResult,
  ShowPackageRequest
} from '../models/native-api.models';

@Injectable({ providedIn: 'root' })
export class NativeService {
  get isDesktop(): boolean {
    return Boolean(window.ndaDm);
  }

  openAuthUrl(url: string): Promise<void> {
    if (window.ndaDm) {
      return window.ndaDm.openAuthUrl(url);
    }

    window.open(url, '_blank', 'noopener,noreferrer');
    return Promise.resolve();
  }

  completeSignIn(request: AuthCompleteRequest): Promise<AuthCompleteResponse> {
    if (!window.ndaDm) {
      return Promise.reject(new Error('RAS sign-in requires the desktop app.'));
    }

    return window.ndaDm.completeSignIn(request);
  }

  verifySession(request: AuthVerifySessionRequest): Promise<AuthVerifySessionResponse> {
    if (!window.ndaDm) {
      return Promise.reject(new Error('Session verification requires the desktop app.'));
    }

    return window.ndaDm.verifySession(request);
  }

  getDefaultDownloadDirectory(): Promise<string> {
    if (window.ndaDm) {
      return window.ndaDm.getDefaultDownloadDirectory();
    }

    return Promise.resolve('');
  }

  getAvailableSpace(targetDir: string): Promise<AvailableSpaceResult> {
    if (window.ndaDm) {
      return window.ndaDm.getAvailableSpace(targetDir);
    }

    return Promise.resolve({
      availableBytes: Number.MAX_SAFE_INTEGER,
      path: targetDir
    });
  }

  chooseDownloadDirectory(): Promise<string | null> {
    if (window.ndaDm) {
      return window.ndaDm.chooseDownloadDirectory();
    }

    const value = window.prompt('Download directory');
    return Promise.resolve(value?.trim() || null);
  }

  scanDownloadDirectory(request: ScanDownloadRequest): Promise<ScanDownloadResult[]> {
    if (!window.ndaDm) {
      return Promise.resolve(request.files.map((file) => ({
        packageFileId: file.packageFileId,
        downloadAlias: file.downloadAlias,
        exists: false,
        complete: false,
        size: null,
        modifiedAt: null,
        path: null
      })));
    }

    return window.ndaDm.scanDownloadDirectory(request);
  }

  showItemInFolder(path: string): Promise<void> {
    if (!window.ndaDm) {
      return Promise.reject(new Error('Showing files requires the desktop app.'));
    }

    return window.ndaDm.showItemInFolder(path);
  }

  showPackageInFolder(request: ShowPackageRequest): Promise<void> {
    if (!window.ndaDm) {
      return Promise.reject(new Error('Showing packages requires the desktop app.'));
    }

    return window.ndaDm.showPackageInFolder(request);
  }

  startDownloadJob(request: DownloadStartRequest): Promise<DownloadStartResult> {
    if (!window.ndaDm) {
      return Promise.reject(new Error('Downloads require the desktop app.'));
    }

    return window.ndaDm.startDownloadJob(request);
  }

  pauseDownloadJob(jobId: string): Promise<void> {
    if (!window.ndaDm) {
      return Promise.resolve();
    }

    return window.ndaDm.pauseDownloadJob(jobId);
  }

  resumeDownloadJob(jobId: string): Promise<void> {
    if (!window.ndaDm) {
      return Promise.resolve();
    }

    return window.ndaDm.resumeDownloadJob(jobId);
  }

  cancelDownloadJob(jobId: string): Promise<void> {
    if (!window.ndaDm) {
      return Promise.resolve();
    }

    return window.ndaDm.cancelDownloadJob(jobId);
  }

  sendHelpRequest(request: HelpRequest): Promise<HelpResponse> {
    if (!window.ndaDm) {
      return Promise.reject(new Error('Help requests require the desktop app.'));
    }

    return window.ndaDm.sendHelpRequest(request);
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
