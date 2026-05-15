import { app } from 'electron';
import {
  HELP_MAX_ATTACHMENT_BYTES,
  HELP_MAX_ATTACHMENTS,
  HELP_REQUEST_TIMEOUT_MS,
  HELP_RESPONSE_READ_TIMEOUT_MS,
  ZENDESK_API_TOKEN_USER,
  ZENDESK_TICKET_SUBJECT,
  ZENDESK_TICKET_URL,
  ZENDESK_TOKEN,
  ZENDESK_UPLOAD_URL
} from './constants';
import { HelpAttachment, HelpRequest, ZendeskTicketInfo } from './models';
import {
  escapeHtml,
  fetchWithTimeout,
  formatBytes,
  multilineHtml,
  stringOrEmpty,
  stringOrNoneHtml,
  withTimeout
} from './utils';

export async function submitHelpRequest(request: HelpRequest): Promise<{ ok: boolean; status: number; message: string; ticketId?: string; ticketUrl?: string }> {
  const zendeskToken = typeof request.zendeskToken === 'string' && request.zendeskToken.trim()
    ? request.zendeskToken.trim()
    : ZENDESK_TOKEN;

  if (!zendeskToken || zendeskToken === 'REPLACE_WITH_ZENDESK_TOKEN') {
    throw new Error('Zendesk token is not configured.');
  }

  const helpRequest = normalizeHelpRequest(request);
  const uploadTokens = helpRequest.attachments?.length
    ? await uploadHelpAttachments(helpRequest.attachments, zendeskToken)
    : [];
  const comment: { html_body: string; uploads?: string[] } = {
    html_body: getInitialHelpComment(helpRequest)
  };

  if (uploadTokens.length > 0) {
    comment.uploads = uploadTokens;
  }

  const createPayload = {
    ticket: {
      subject: ZENDESK_TICKET_SUBJECT,
      requester: {
        name: helpRequest.name,
        email: helpRequest.email
      },
      comment
    }
  };

  let createResponse: Response;
  try {
    console.info('Submitting Zendesk help request.');
    createResponse = await fetchWithTimeout(ZENDESK_TICKET_URL, {
      method: 'POST',
      headers: zendeskHeaders(zendeskToken),
      body: JSON.stringify(createPayload)
    }, 'Help request timed out.', HELP_REQUEST_TIMEOUT_MS);
  } catch (error) {
    throw new Error(helpSubmissionErrorMessage(error));
  }

  if (!createResponse.ok) {
    const detail = await readResponseText(createResponse);
    throw new Error(`Zendesk ticket creation failed with HTTP ${createResponse.status}${detail ? ` ${detail}` : ''}`);
  }

  const ticketInfo = await readZendeskTicketInfo(createResponse).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Zendesk ticket created, but ticket details could not be read: ${message}`);
    return {} as ZendeskTicketInfo;
  });
  const ticketId = ticketInfo.id;
  const ticketUrl = ticketInfo.url || (ticketId ? getZendeskTicketUrl(ticketId) : undefined);

  if (ticketId) {
    console.info(`Zendesk help request created. Ticket ${ticketId}.`);
    void appendHelpRequestDetails(ticketId, helpRequest, zendeskToken).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Zendesk ticket detail update failed: ${message}`);
    });
  } else {
    console.info('Zendesk help request created.');
  }

  return {
    ok: true,
    status: createResponse.status,
    message: ticketId
      ? `Successfully created Zendesk ticket. Ticket ID is ${ticketId}`
      : 'Successfully created Zendesk ticket.',
    ticketId,
    ticketUrl
  };
}

async function appendHelpRequestDetails(ticketId: string, helpRequest: HelpRequest, zendeskToken: string): Promise<void> {
  const detailPayload = {
    ticket: {
      comment: {
        public: false,
        html_body: getHelpDetailComment(helpRequest)
      }
    }
  };

  let detailResponse: Response;
  try {
    detailResponse = await fetchWithTimeout(getZendeskTicketUrl(ticketId), {
      method: 'PUT',
      headers: zendeskHeaders(zendeskToken),
      body: JSON.stringify(detailPayload)
    }, 'Help request timed out.', HELP_REQUEST_TIMEOUT_MS);
  } catch (error) {
    throw new Error(helpSubmissionErrorMessage(error));
  }

  if (!detailResponse.ok) {
    const detail = await readResponseText(detailResponse);
    throw new Error(`Zendesk ticket detail update failed with HTTP ${detailResponse.status}${detail ? ` ${detail}` : ''}`);
  }
}

function normalizeHelpRequest(request: HelpRequest): HelpRequest {
  const normalized = {
    ...request,
    name: stringOrEmpty(request.name).trim(),
    username: stringOrEmpty(request.username).trim(),
    email: stringOrEmpty(request.email).trim(),
    message: stringOrEmpty(request.message).trim(),
    attachments: normalizeHelpAttachments(request.attachments)
  };

  if (!normalized.name || !normalized.email || !normalized.message) {
    throw new Error('Name, email, and message are required.');
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized.email)) {
    throw new Error('A valid email address is required.');
  }

  return normalized;
}

function normalizeHelpAttachments(attachments: HelpAttachment[] | undefined): HelpAttachment[] {
  if (attachments === undefined) {
    return [];
  }

  if (!Array.isArray(attachments)) {
    throw new Error('Help request attachments are invalid.');
  }

  if (attachments.length > HELP_MAX_ATTACHMENTS) {
    throw new Error(`Attach up to ${HELP_MAX_ATTACHMENTS} files.`);
  }

  return attachments.map((attachment) => {
    const name = sanitizeZendeskFilename(attachment?.name);
    const mimeType = stringOrEmpty(attachment?.mimeType).trim() || 'application/octet-stream';
    const dataBase64 = stringOrEmpty(attachment?.dataBase64).trim();
    const size = Number(attachment?.size);

    if (!name || !dataBase64) {
      throw new Error('Help request attachments are invalid.');
    }

    if (!Number.isFinite(size) || size < 0 || size > HELP_MAX_ATTACHMENT_BYTES) {
      throw new Error(`${name} is larger than ${formatBytes(HELP_MAX_ATTACHMENT_BYTES)}.`);
    }

    return {
      name,
      mimeType,
      size,
      dataBase64
    };
  });
}

function sanitizeZendeskFilename(value: string | null | undefined): string {
  return stringOrEmpty(value)
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .replace(/^\.+$/, '')
    .slice(0, 180);
}

async function uploadHelpAttachments(attachments: HelpAttachment[], zendeskToken: string): Promise<string[]> {
  const uploadTokens: string[] = [];

  for (const attachment of attachments) {
    const token = await uploadHelpAttachment(attachment, zendeskToken);
    uploadTokens.push(token);
  }

  return uploadTokens;
}

async function uploadHelpAttachment(attachment: HelpAttachment, zendeskToken: string): Promise<string> {
  const buffer = Buffer.from(attachment.dataBase64, 'base64');
  if (buffer.length === 0 || buffer.length > HELP_MAX_ATTACHMENT_BYTES) {
    throw new Error(`${attachment.name} is larger than ${formatBytes(HELP_MAX_ATTACHMENT_BYTES)}.`);
  }

  const url = new URL(ZENDESK_UPLOAD_URL);
  url.searchParams.set('filename', attachment.name);

  let response: Response;
  try {
    console.info(`Uploading Zendesk help attachment ${attachment.name}.`);
    response = await fetchWithTimeout(url.toString(), {
      method: 'POST',
      headers: zendeskUploadHeaders(zendeskToken, attachment.mimeType),
      body: buffer
    }, 'Help request attachment upload timed out.', HELP_REQUEST_TIMEOUT_MS);
  } catch (error) {
    throw new Error(helpSubmissionErrorMessage(error));
  }

  if (!response.ok) {
    const detail = await readResponseText(response);
    throw new Error(`Zendesk attachment upload failed with HTTP ${response.status}${detail ? ` ${detail}` : ''}`);
  }

  return readZendeskUploadToken(response, attachment.name);
}

async function readZendeskUploadToken(response: Response, attachmentName: string): Promise<string> {
  const data = await withTimeout(
    response.json().catch(() => null),
    HELP_RESPONSE_READ_TIMEOUT_MS,
    'Zendesk response timed out.'
  ) as { upload?: { token?: string } } | null;
  const token = stringOrEmpty(data?.upload?.token).trim();

  if (!token) {
    throw new Error(`Zendesk upload response did not include an upload token for ${attachmentName}.`);
  }

  return token;
}

function zendeskHeaders(zendeskToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${zendeskToken}`,
    'Content-Type': 'application/json'
  };
}

function zendeskUploadHeaders(zendeskToken: string, contentType: string): Record<string, string> {
  const credential = Buffer.from(`${ZENDESK_API_TOKEN_USER}:${zendeskToken}`, 'utf8').toString('base64');
  return {
    Authorization: `Basic ${credential}`,
    'Content-Type': contentType || 'application/octet-stream'
  };
}

function getInitialHelpComment(request: HelpRequest): string {
  return `
    <p><strong>NAME </strong>${escapeHtml(request.name)}</p>
    <p><strong>USERNAME </strong>${stringOrNoneHtml(request.username)}</p>
    <p><strong>EMAIL </strong>${escapeHtml(request.email)}</p>
    <p><strong>MESSAGE </strong>${multilineHtml(request.message)}</p>
  `;
}

function getHelpDetailComment(request: HelpRequest): string {
  return `
    <h3>APP DETAILS</h3>
    <div>
      <p><strong>APP </strong>${escapeHtml(app.name)} v${escapeHtml(app.getVersion())}</p>
      <p><strong>HOST </strong>${stringOrNoneHtml(request.host)}</p>
      <p><strong>PLATFORM </strong>${escapeHtml(process.platform)} ${escapeHtml(process.arch)}</p>
      <p><strong>ELECTRON </strong>${stringOrNoneHtml(process.versions.electron)}</p>
      <p><strong>CHROME </strong>${stringOrNoneHtml(process.versions.chrome)}</p>
      <p><strong>NODE </strong>${stringOrNoneHtml(process.versions.node)}</p>
    </div>
    <h3>PACKAGE</h3>
    <div>
      <p><strong>PACKAGE ID </strong>${request.packageId == null ? 'none' : escapeHtml(String(request.packageId))}</p>
      <p><strong>PACKAGE NAME </strong>${stringOrNoneHtml(request.packageName)}</p>
      <p><strong>PACKAGE SOURCE </strong>${stringOrNoneHtml(request.packageSource)}</p>
      <p><strong>FILE COUNT </strong>${request.fileCount == null ? 'none' : escapeHtml(String(request.fileCount))}</p>
    </div>
  `;
}

function getZendeskTicketUrl(ticketId: string): string {
  return ZENDESK_TICKET_URL.replace('.json', `/${encodeURIComponent(ticketId)}.json`);
}

async function readZendeskTicketInfo(response: Response): Promise<ZendeskTicketInfo> {
  const data = await withTimeout(
    response.json().catch(() => null),
    HELP_RESPONSE_READ_TIMEOUT_MS,
    'Zendesk response timed out.'
  ) as { ticket?: { id?: string | number; url?: string } } | null;
  const ticketId = data?.ticket?.id;
  const ticketUrl = stringOrEmpty(data?.ticket?.url).trim();

  if ((ticketId === undefined || ticketId === null || `${ticketId}`.trim() === '') && !ticketUrl) {
    throw new Error('Zendesk ticket response did not include ticket details.');
  }

  return {
    id: ticketId === undefined || ticketId === null || `${ticketId}`.trim() === '' ? undefined : `${ticketId}`,
    url: ticketUrl || undefined
  };
}

async function readResponseText(response: Response): Promise<string> {
  return withTimeout(response.text(), HELP_RESPONSE_READ_TIMEOUT_MS, 'Zendesk response timed out.')
    .catch(() => '');
}

function helpSubmissionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message === 'Help request timed out.') {
    return message;
  }

  if (message === 'Help request attachment upload timed out.') {
    return message;
  }

  if (!message || message === 'fetch failed') {
    return 'Help request could not be sent. Check your network connection or VPN and try again.';
  }

  return `Help request could not be sent. ${message}`;
}
