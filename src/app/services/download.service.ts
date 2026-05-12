import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { DownloadEvent, DownloadStartRequest, DownloadStartResult } from '../models/native-api.models';
import { NativeService } from './native.service';

@Injectable({ providedIn: 'root' })
export class DownloadService {
  readonly events$: Observable<DownloadEvent>;

  constructor(private readonly native: NativeService) {
    this.events$ = this.native.downloadEvents();
  }

  start(request: DownloadStartRequest): Promise<DownloadStartResult> {
    return this.native.startDownloadJob(request);
  }

  pause(jobId: string): Promise<void> {
    return this.native.pauseDownloadJob(jobId);
  }

  resume(jobId: string): Promise<void> {
    return this.native.resumeDownloadJob(jobId);
  }

  cancel(jobId: string): Promise<void> {
    return this.native.cancelDownloadJob(jobId);
  }
}
