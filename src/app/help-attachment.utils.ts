import { HELP_MAX_ATTACHMENT_BYTES } from './app.constants';
import { formatBytes } from './formatting.utils';
import { HelpAttachment } from './models/native-api.models';

export async function toHelpAttachment(file: File): Promise<HelpAttachment> {
  if (file.size > HELP_MAX_ATTACHMENT_BYTES) {
    throw new Error(`${file.name} is larger than ${formatBytes(HELP_MAX_ATTACHMENT_BYTES)}.`);
  }

  const dataBase64 = await fileToBase64(file);
  return {
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    size: file.size,
    dataBase64
  };
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}
