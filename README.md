# NDA Download Manager

Desktop-only download manager for NIMH Data Archive (NDA) packages. The renderer is built with Angular and runs inside the Electron shell; using the Angular dev server directly in a browser is not a supported app mode.

## What The App Does

- Signs users in with NIH Research Auth Service (RAS) through the Electron desktop shell.
- Handles `nda-dm://` protocol callbacks from the RAS sign-in flow.
- Lists packages that are ready to download in `My Packages`.
- Lists packages available in `Shared Packages`.
- Adds shared packages to `My Packages`.
- Displays package files with file name, size, creation date, local download status, download progress state, and file explorer actions.
- Lets users select a download directory and remembers the last selected directory in local storage.
- Scans the selected download directory to detect missing, partial, and already-downloaded files.
- Switches package row actions between download and show behavior when package files are downloaded.
- Supports downloading an entire package or only selected files.
- Skips complete local files before starting download work.
- Downloads files from S3 with token prefetching, parallel file/chunk work, disk-space checks, and progress events from Electron.
- Supports pause, resume, and cancel controls for active download jobs.
- Opens downloaded files or completed package folders in the system file explorer.
- Provides a help request modal that sends support requests through the Electron main process.

## Prerequisites

- Node.js compatible with the versions required by Angular 21 and Electron 42.
- npm.
- Network access to the selected NDA environment.
- A desktop environment that can run Electron.

Install dependencies:

```powershell
npm.cmd install
```

## Start The App

All start commands build the Electron main process, start Angular on `127.0.0.1:4200`, wait for the renderer, and then launch Electron.

Default environment:

```powershell
npm.cmd run start
```

Stage environment:

```powershell
npm.cmd run start:stage
```

Revengers environment:

```powershell
npm.cmd run start:revengers
```

The local Angular URL is a development implementation detail. Use the Electron window for normal app testing.

## Environment Configuration

The API host and renderer Zendesk token are compiled from Angular environment files. There is no runtime environment selector in the UI.

| Command | Angular configuration | Environment file | API host |
| --- | --- | --- | --- |
| `npm.cmd run start` | `development` | `src/environments/environment.ts` | `https://nda.nih.gov` |
| `npm.cmd run start:stage` | `stage` | `src/environments/environment.stage.ts` | `https://stage.nimhda.org` |
| `npm.cmd run start:revengers` | `revengers` | `src/environments/environment.revengers.ts` | `https://revengers.nimhda.org` |

Angular selects non-default environment files through `fileReplacements` in `angular.json`.

Do not log or document the actual Zendesk token value. `NDA_DM_ZENDESK_TOKEN` is still available as a local fallback if the compiled environment token is blank.

## Common Commands

Build the Angular renderer:

```powershell
npm.cmd run build:renderer
```

Build the Electron main process:

```powershell
npm.cmd run build:electron
```

Build both renderer and Electron:

```powershell
npm.cmd run build
```

Run lint:

```powershell
npm.cmd run lint
```

Create a packaged desktop build:

```powershell
npm.cmd run package
```

Launch Electron against an already-running local renderer at `127.0.0.1:4200`:

```powershell
npm.cmd run electron
```

## App Workflow

1. Start the app for the desired environment.
2. Sign in with RAS.
3. Wait for packages to load.
4. Optionally add packages from `Shared Packages` to `My Packages`.
5. Choose a download directory from the account menu.
6. Select a package from `My Packages`.
7. Scan the download directory to refresh local file status.
8. Download the package from the package row action, or select individual files and use `Download Selected`.
9. Use pause, resume, or cancel controls while a download is active.
10. Use `Show` actions to open completed files or package folders in the system file explorer.

## Notes

- The Electron main process owns desktop-only behavior such as protocol handling, file system access, directory selection, showing files in the system file explorer, and S3 download work.
- The renderer communicates with Electron through the preload bridge.
- Complete files are not selectable for download.
- The selected package list pane can be resized by dragging the splitter between the package and file panes.
