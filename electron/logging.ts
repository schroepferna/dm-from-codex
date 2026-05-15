import { app } from 'electron';
import type { WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';

type ConsoleMethod = 'debug' | 'error' | 'info' | 'log' | 'warn';
type ConsoleWriter = (...args: unknown[]) => void;

const LOG_FILE_NAME = 'main.log';
const CONSOLE_METHODS: readonly ConsoleMethod[] = ['debug', 'error', 'info', 'log', 'warn'];

const loggedWebContents = new WeakSet<WebContents>();
let logStream: fs.WriteStream | null = null;
let consoleLoggingConfigured = false;

export function configureAppLogging(): string {
  const logsDir = getAppLogsDirectory();
  fs.mkdirSync(logsDir, { recursive: true });
  app.setAppLogsPath(logsDir);
  configureConsoleFileLogging(path.join(logsDir, LOG_FILE_NAME));

  return logsDir;
}

export function attachWebContentsLogging(webContents: WebContents, label: string): void {
  if (loggedWebContents.has(webContents)) {
    return;
  }

  loggedWebContents.add(webContents);
  webContents.on('console-message', (details, legacyLevel, legacyMessage, legacyLine, legacySourceId) => {
    const level = details.level ?? legacyLevelToName(legacyLevel);
    const message = details.message ?? legacyMessage;
    const lineNumber = details.lineNumber ?? legacyLine;
    const sourceId = details.sourceId ?? legacySourceId;
    const source = sourceId ? ` (${sourceId}${lineNumber ? `:${lineNumber}` : ''})` : '';

    writeLogLine(`${label}:${level}`, [`${message}${source}`]);
  });
}

function getAppLogsDirectory(): string {
  if (!app.isPackaged) {
    return path.join(process.cwd(), 'logs');
  }

  return path.join(app.getPath('userData'), 'logs');
}

function configureConsoleFileLogging(logFilePath: string): void {
  if (consoleLoggingConfigured) {
    return;
  }

  logStream = fs.createWriteStream(logFilePath, { flags: 'a' });
  logStream.on('error', () => {
    logStream = null;
  });

  const writableConsole = console as unknown as Record<ConsoleMethod, ConsoleWriter>;
  for (const method of CONSOLE_METHODS) {
    const original = writableConsole[method].bind(console);
    writableConsole[method] = (...args: unknown[]) => {
      writeLogLine(method, args);
      original(...args);
    };
  }

  process.on('uncaughtExceptionMonitor', (error) => {
    writeLogLine('error', ['Uncaught exception.', error]);
  });

  process.on('unhandledRejection', (reason) => {
    writeLogLine('error', ['Unhandled rejection.', reason]);
  });

  app.on('will-quit', () => {
    logStream?.end();
    logStream = null;
  });

  consoleLoggingConfigured = true;
}

function writeLogLine(level: string, args: readonly unknown[]): void {
  if (!logStream) {
    return;
  }

  const timestamp = new Date().toISOString();
  const message = util.format(...args);
  logStream.write(`[${timestamp}] ${level.toUpperCase()} ${message}\n`);
}

function legacyLevelToName(level: number): Electron.WebContentsConsoleMessageEventParams['level'] {
  switch (level) {
    case 0:
      return 'debug';
    case 2:
      return 'warning';
    case 3:
      return 'error';
    case 1:
    default:
      return 'info';
  }
}
