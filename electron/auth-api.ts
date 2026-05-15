import { AuthCompleteRequest, AuthVerifySessionRequest } from './models';
import { assertHttpUrl, fetchWithTimeout, trimTrailingSlash } from './utils';

export async function completeSignIn(request: AuthCompleteRequest): Promise<{ token: string; username: string | null }> {
  if (!request?.host || !request.sessionId) {
    throw new Error('A host and session id are required.');
  }

  assertHttpUrl(request.host);
  const token = await exchangeSessionForToken(request.host, request.sessionId);
  const verification = await verifyToken(request.host, token);

  if (!verification.valid) {
    throw new Error(verification.errorMessage || 'Token verification failed.');
  }

  return {
    token,
    username: verification.username || null
  };
}

export async function exchangeSessionForToken(host: string, sessionId: string): Promise<string> {
  const url = new URL(`${trimTrailingSlash(host)}/api/ras/getToken`);
  url.searchParams.set('sessionId', sessionId);

  const response = await fetchWithTimeout(url.toString());
  const token = (await response.text()).trim();

  if (!response.ok) {
    throw new Error(token || `Token exchange failed with HTTP ${response.status}.`);
  }

  if (!token || token.toLowerCase().includes('invalid') || token.toLowerCase().includes('expired')) {
    throw new Error(token || 'Session is invalid or expired.');
  }

  return token;
}

export async function verifyToken(host: string, token: string): Promise<{ valid: boolean; username: string | null; errorMessage: string | null }> {
  const response = await fetchWithTimeout(`${trimTrailingSlash(host)}/api/ras/verifyToken`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Token verification failed with HTTP ${response.status}${detail ? ` ${detail}` : ''}`);
  }

  return response.json() as Promise<{ valid: boolean; username: string | null; errorMessage: string | null }>;
}

export async function verifySession(request: AuthVerifySessionRequest): Promise<{ valid: boolean; username: string | null; errorMessage: string | null }> {
  if (!request?.host || !request.token || !request.sessionId) {
    throw new Error('A host, token, and session id are required.');
  }

  assertHttpUrl(request.host);

  const response = await fetchWithTimeout(`${trimTrailingSlash(request.host)}/api/ras/verifySession`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${request.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ jSessionId: request.sessionId })
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Session verification failed with HTTP ${response.status}${detail ? ` ${detail}` : ''}`);
  }

  return response.json() as Promise<{ valid: boolean; username: string | null; errorMessage: string | null }>;
}
