import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { BehaviorSubject, firstValueFrom, timeout } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthState, VerifyResponse } from '../models/package.models';
import { NativeService } from './native.service';

const AUTH_STORAGE_KEY = 'nda-download-manager.auth';
const SESSION_ID_STORAGE_KEY = 'nda-download-manager.sessionId';
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const AUTH_REQUEST_TIMEOUT_MS = 30000;
const CONFIGURED_HOST = trimTrailingSlash(environment.apiHost);

@Injectable({ providedIn: 'root' })
export class AuthService {
  private heartbeatTimer: number | null = null;
  private readonly stateSubject = new BehaviorSubject<AuthState>(this.loadStoredState());
  readonly state$ = this.stateSubject.asObservable();

  constructor(
    private readonly http: HttpClient,
    private readonly native: NativeService
  ) {
    if (this.stateSubject.value.authenticated) {
      this.startHeartbeat();
    }
  }

  get snapshot(): AuthState {
    return this.stateSubject.value;
  }

  async signIn(): Promise<void> {
    const host = this.snapshot.host;
    const callback = 'nda-dm://';
    await this.native.openAuthUrl(`${trimTrailingSlash(host)}/api/ras/signin?callback=${callback}`);
  }

  async completeSignIn(sessionId: string): Promise<AuthState> {
    sessionId = sessionId.trim();
    if (!sessionId) {
      throw new Error('Session id is required.');
    }

    try {
      this.setState({
        host: this.snapshot.host,
        sessionId,
        token: null,
        username: null,
        authenticated: false,
        lastVerifiedAt: null
      });

      const host = this.snapshot.host;
      const storedSessionId = this.loadStoredSessionId();
      if (!storedSessionId) {
        throw new Error('Stored session id is required.');
      }

      const token = await this.exchangeSessionForToken(host, storedSessionId);

      this.setState({
        host,
        sessionId: storedSessionId,
        token,
        username: null,
        authenticated: false,
        lastVerifiedAt: null
      });

      const verification = await this.verifyToken(host, token);

      if (!verification.valid) {
        throw new Error(verification.errorMessage || 'Token verification failed.');
      }

      const sessionVerification = await this.verifySessionWithAuth(host, token, storedSessionId);

      if (!sessionVerification.valid) {
        throw new Error(sessionVerification.errorMessage || 'Session is invalid or expired.');
      }

      const next: AuthState = {
        host,
        sessionId: storedSessionId,
        token,
        username: sessionVerification.username || verification.username,
        authenticated: true,
        lastVerifiedAt: new Date().toISOString()
      };

      this.setState(next);
      this.startHeartbeat();
      return next;
    } catch (error) {
      this.signOut();
      throw error;
    }
  }

  async verifyCurrentToken(): Promise<boolean> {
    const { host, token } = this.snapshot;

    if (!token) {
      return false;
    }

    const verification = await this.verifyToken(host, token);
    const valid = verification.valid === true;

    if (!valid) {
      this.signOut();
      return false;
    }

    this.setState({
      ...this.snapshot,
      username: verification.username || this.snapshot.username,
      lastVerifiedAt: new Date().toISOString()
    });
    return true;
  }

  async refreshToken(): Promise<AuthState> {
    const { host, sessionId } = this.snapshot;

    if (!sessionId) {
      throw new Error('Session id is required.');
    }

    const token = await this.exchangeSessionForToken(host, sessionId);
    const verification = await this.verifyToken(host, token);

    if (!verification.valid) {
      throw new Error(verification.errorMessage || 'Token verification failed.');
    }

    const next: AuthState = {
      ...this.snapshot,
      host,
      sessionId,
      token,
      username: verification.username || this.snapshot.username,
      authenticated: true,
      lastVerifiedAt: new Date().toISOString()
    };

    this.setState(next);
    return next;
  }

  async verifySession(): Promise<boolean> {
    const { host, sessionId, token } = this.snapshot;

    if (!sessionId || !token) {
      return false;
    }

    const response = await this.verifySessionWithAuth(host, token, sessionId);

    if (!response.valid) {
      this.signOut();
      return false;
    }

    this.setState({
      ...this.snapshot,
      username: response.username || this.snapshot.username,
      lastVerifiedAt: new Date().toISOString()
    });
    return true;
  }

  signOut(): void {
    this.stopHeartbeat();
    const signedOutState: AuthState = {
      host: this.snapshot.host,
      sessionId: null,
      token: null,
      username: null,
      authenticated: false,
      lastVerifiedAt: null
    };

    this.stateSubject.next({
      ...signedOutState,
      host: CONFIGURED_HOST
    });
    this.clearAuthCache();
  }

  clearAuthCache(): void {
    this.clearStoredAuth();
  }

  private async exchangeSessionForToken(host: string, sessionId: string): Promise<string> {
    const token = await firstValueFrom(this.http.get(
      `${trimTrailingSlash(host)}/api/ras/getToken`,
      {
        params: { sessionId },
        responseType: 'text'
      }
    ).pipe(timeout(AUTH_REQUEST_TIMEOUT_MS)));

    const trimmed = token.trim();
    if (!trimmed || trimmed.toLowerCase().includes('invalid') || trimmed.toLowerCase().includes('expired')) {
      throw new Error(trimmed || 'Session is invalid or expired.');
    }

    return trimmed;
  }

  private verifyToken(host: string, token: string): Promise<VerifyResponse> {
    return firstValueFrom(this.http.post<VerifyResponse>(
      `${trimTrailingSlash(host)}/api/ras/verifyToken`,
      null,
      { headers: bearerHeaders(token) }
    ).pipe(timeout(AUTH_REQUEST_TIMEOUT_MS)));
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      void this.keepSessionAlive();
    }, HEARTBEAT_INTERVAL_MS);
  }

  private async keepSessionAlive(): Promise<void> {
    const { host, sessionId, token } = this.snapshot;
    if (!sessionId || !token) {
      return;
    }

    try {
      const sessionVerification = await this.verifySessionWithAuth(host, token, sessionId);
      if (!sessionVerification.valid) {
        this.signOut();
        return;
      }

      this.setState({
        ...this.snapshot,
        username: sessionVerification.username || this.snapshot.username,
        lastVerifiedAt: new Date().toISOString()
      });
    } catch (error) {
      console.warn('Session keep-alive failed.', error);
    }
  }

  private verifySessionWithAuth(host: string, token: string, sessionId: string): Promise<VerifyResponse> {
    return this.native.isDesktop
      ? this.native.verifySession({ host, token, sessionId })
      : firstValueFrom(this.http.post<VerifyResponse>(
        `${trimTrailingSlash(host)}/api/ras/verifySession`,
        { jSessionId: sessionId },
        { headers: bearerHeaders(token) }
      ).pipe(timeout(AUTH_REQUEST_TIMEOUT_MS)));
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private setState(state: AuthState): void {
    const next = {
      ...state,
      host: CONFIGURED_HOST
    };
    this.stateSubject.next(next);
    this.storeSessionId(next.sessionId);
    window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(next));
  }

  private storeSessionId(sessionId: string | null): void {
    if (sessionId) {
      window.localStorage.setItem(SESSION_ID_STORAGE_KEY, sessionId);
      return;
    }

    window.localStorage.removeItem(SESSION_ID_STORAGE_KEY);
  }

  private clearStoredAuth(): void {
    window.localStorage.removeItem(AUTH_STORAGE_KEY);
    window.localStorage.removeItem(SESSION_ID_STORAGE_KEY);
  }

  private loadStoredState(): AuthState {
    const fallback: AuthState = {
      host: CONFIGURED_HOST,
      sessionId: null,
      token: null,
      username: null,
      authenticated: false,
      lastVerifiedAt: null
    };

    this.clearAuthCache();
    return fallback;
  }

  private loadStoredSessionId(): string | null {
    const sessionId = window.localStorage.getItem(SESSION_ID_STORAGE_KEY);
    return sessionId && sessionId !== 'null' ? sessionId : null;
  }
}

export function bearerHeaders(token: string): HttpHeaders {
  return new HttpHeaders({
    Authorization: `Bearer ${token}`
  });
}

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
