# NDA Download Manager

Desktop download manager for NDA packages. The renderer is Angular 21 and the desktop shell is Electron.

## Features

- RAS sign-in through the Electron desktop shell, including `nda-dm://` protocol callback handling.
- My Packages and Shared Packages views.
- Shared package association into My Packages.
- Package file listing with size, creation date, local status, and download status.
- Download directory selection with the last selected directory persisted in local storage.
- Local download scanning to detect missing, partial, and already-downloaded files.
- Downloaded files are shown as complete and cannot be selected for download again.
- Package-level and selected-file downloads.
- Existing complete files are skipped before download work starts.
- Parallel S3 downloads with progress events, disk-space checks, and token prefetching.
- Pause, resume, and cancel controls for active desktop download jobs.
- Show downloaded files or completed package folders in the system file explorer.
- Help request modal that submits support requests to Zendesk from the Electron main process.

## Development

```powershell
npm.cmd install
npm.cmd start
```

The app registers the `nda-dm://` protocol for RAS callbacks in Electron. In browser-only development, paste the callback session id into the fallback field.

## Runtime Configuration

The API host and renderer Zendesk token value are compiled from Angular environment files. The default app and production build use:

- `https://nda.nih.gov`

Developer-only hosts require an explicit Angular configuration:

```powershell
npm.cmd run start:web:stage
npm.cmd run start:web:revengers
npm.cmd run start:stage
npm.cmd run start:revengers
```

Angular 21 selects these environment files with `--configuration`/`-c` (for example, `ng serve -c stage`).

The configured hosts and `zendeskToken` values live in `src/environments/environment*.ts`; there is no runtime host selector in the UI. Do not document or log the actual Zendesk token value.

Zendesk help request submission is currently performed by the Electron main process. Set `NDA_DM_ZENDESK_TOKEN` before launching the desktop app to enable that submission path, and keep it in sync with the environment-file `zendeskToken` value.
