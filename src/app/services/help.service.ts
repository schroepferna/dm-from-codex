import { Injectable } from '@angular/core';
import { HelpRequest, HelpResponse } from '../models/native-api.models';
import { NativeService } from './native.service';

@Injectable({ providedIn: 'root' })
export class HelpService {
  constructor(private readonly native: NativeService) {}

  submit(request: HelpRequest): Promise<HelpResponse> {
    return this.native.sendHelpRequest(request);
  }
}
