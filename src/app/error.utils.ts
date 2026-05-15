export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return cleanErrorMessage(error.message);
  }

  if (typeof error === 'string' && error.trim()) {
    return cleanErrorMessage(error);
  }

  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const directMessage = cleanStringValue(record['message']);
    const nestedMessage = cleanStringValue(record['error'])
      || cleanStringValue((record['error'] as Record<string, unknown> | null)?.['message'])
      || cleanStringValue((record['error'] as Record<string, unknown> | null)?.['errorMessage']);

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

export function isAbortMessage(message: string | null | undefined): boolean {
  if (!message) {
    return false;
  }

  const normalized = message.toLowerCase();
  return normalized.includes('abort') || normalized.includes('cancel');
}

function cleanStringValue(value: unknown): string | null {
  const message = stringValue(value);
  return message ? cleanErrorMessage(message) : null;
}

function cleanErrorMessage(message: string): string {
  return message
    .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
    .trim();
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
