# NDA Download Manager

Desktop download manager for NDA packages. The renderer is Angular 21 and the desktop shell is Electron.

## Development

```powershell
npm.cmd install
npm.cmd start
```

The app registers the `nda-dm://` protocol for RAS callbacks in Electron. In browser-only development, paste the callback session id into the fallback field.

## Runtime Configuration

The API host is compiled from Angular environment files. The default app and production build use:

- `https://nda.nih.gov`

Developer-only hosts require an explicit Angular configuration:

```powershell
npm.cmd run start:web:stage
npm.cmd run start:web:revengers
npm.cmd run start:stage
npm.cmd run start:revengers
```

Angular 21 selects these environment files with `--configuration`/`-c` (for example, `ng serve -c stage`).

The configured hosts live in `src/environments/environment*.ts`; there is no runtime host selector in the UI.

Set `NDA_DM_ZENDESK_TOKEN` before launching the app to enable Zendesk help request submission from the Electron main process.
