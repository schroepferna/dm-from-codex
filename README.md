# NDA Download Manager

Desktop-only download manager for NDA packages. The renderer is Angular 21 and must run inside the Electron shell; browser-only execution is not supported.

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

The development start command builds the Electron main process, starts the Angular dev server on `127.0.0.1:4200`, and launches Electron against that local renderer. The Angular server is an implementation detail for desktop development, not a supported browser mode.

The app registers the `nda-dm://` protocol for RAS callbacks in Electron.

## Runtime Configuration

The API host and renderer Zendesk token value are compiled from Angular environment files. The default app and production build use:

- `https://nda.nih.gov`

Developer-only hosts require an explicit Angular configuration:

```powershell
npm.cmd run start:stage
npm.cmd run start:revengers
```

Angular 21 selects these environment files with `--configuration`/`-c` (for example, `ng serve -c stage`).

The configured hosts and `zendeskToken` values live in `src/environments/environment*.ts`; there is no runtime host selector in the UI. Do not document or log the actual Zendesk token value.

Zendesk help request submission is performed by the Electron main process. The renderer passes the compiled environment-file `zendeskToken` to that desktop IPC path. `NDA_DM_ZENDESK_TOKEN` remains available as a local fallback if the environment-file token is blank.
