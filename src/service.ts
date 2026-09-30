/**
 * service.ts — Render launchd / systemd definitions for Harbor's long-running
 * pieces, so an operator can run them under a supervisor instead of a terminal.
 *
 *   serve       Harbor Server (`harbor serve`)
 *   watcher     the beacon watcher in the foreground (`harbor watch`)
 *   system-one  the System One router daemon — a program that is NOT in this
 *               repository, so the operator supplies its command line
 *
 * This only RENDERS. It never installs, loads, or starts anything: a service
 * definition is something an operator should read before it runs at every boot.
 * `harbor service print` writes it to stdout; `--write` puts it at the standard
 * per-user path and prints the commands to activate it.
 *
 * Absolute program paths are required. launchd starts jobs with a minimal PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`) and systemd's ExecStart demands an absolute
 * path, so a bare `harbor` would work in a shell and fail as a service — the
 * classic "works on my terminal" bug, caught here at render time instead.
 */
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type ServiceUnit = "serve" | "watcher" | "system-one";
export type ServiceTarget = "launchd" | "systemd";
export const SERVICE_UNITS: readonly ServiceUnit[] = ["serve", "watcher", "system-one"];
export const SERVICE_TARGETS: readonly ServiceTarget[] = ["launchd", "systemd"];

export class ServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceError";
  }
}

export interface ServiceOptions {
  unit: ServiceUnit;
  target: ServiceTarget;
  /** Absolute path to the harbor executable (serve, watcher). */
  harborBin?: string;
  /** Extra arguments placed between the executable and the subcommand (e.g. the CLI script for `bun`). */
  harborPrefixArgs?: string[];
  /** Full argv of the System One daemon (required for `system-one`; first element absolute). */
  command?: string[];
  /** `launchd` Label / systemd unit name stem. Default `harbor-<unit>`. */
  label?: string;
  /** Extra environment for the service. */
  env?: Record<string, string>;
  /** Working directory. */
  workingDir?: string;
  /** Harbor Server settings (unit `serve`). */
  dataDir?: string;
  host?: string;
  port?: number;
  /** Home directory used for log/install paths (default: the current user's). */
  home?: string;
}

export interface RenderedService {
  /** File name, e.g. `dev.harbor.serve.plist` / `harbor-serve.service`. */
  filename: string;
  content: string;
  /** Standard per-user install location. */
  installPath: string;
  /** What to run to activate it (printed, never executed). */
  activate: string[];
}

const DESCRIPTIONS: Record<ServiceUnit, string> = {
  serve: "Harbor Server (authenticated HTTP MCP)",
  watcher: "Harbor beacon watcher",
  "system-one": "System One router daemon (Harbor Turn-Sieve)",
};

/** Split a command line into argv, honoring single and double quotes. No expansion. */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < line.length && /["\\]/.test(line[i + 1] as string)) cur += line[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (quote) throw new ServiceError(`unterminated ${quote} in command`);
  if (has || cur) out.push(cur);
  return out;
}

const xml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** Quote one word for a systemd ExecStart line (`%` and `$` are special there). */
function systemdWord(s: string): string {
  const esc = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$");
  return /[\s"'\\]/.test(s) || s === "" ? `"${esc}"` : esc;
}

/**
 * Refuse control characters (newline, NUL, ...) in anything rendered into a
 * service file. In a systemd unit a newline inside a value starts a NEW
 * directive — `KEY=value\nExecStartPre=/bin/sh -c ...` — so an unchecked value
 * would be command injection into something that runs at every boot.
 */
function assertPlain(s: string, what: string): void {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new ServiceError(`${what} contains a control character`);
}

function assertAbsolute(p: string, what: string): void {
  if (!isAbsolute(p)) {
    throw new ServiceError(
      `${what} must be an absolute path (got '${p}'): launchd and systemd do not search your shell PATH`,
    );
  }
}

/** The argv the supervisor will run. */
function argvFor(o: ServiceOptions): string[] {
  if (o.unit === "system-one") {
    if (!o.command || o.command.length === 0) {
      throw new ServiceError(
        "system-one needs --command: the router daemon is not part of this repository, " +
          'so Harbor cannot know how to start it (e.g. --command "/usr/local/bin/node /opt/system-one/server.js")',
      );
    }
    assertAbsolute(o.command[0] as string, "the system-one command's program");
    return o.command;
  }
  if (!o.harborBin) throw new ServiceError("--harbor-bin is required (absolute path to the harbor executable)");
  assertAbsolute(o.harborBin, "--harbor-bin");
  const sub = o.unit === "serve" ? ["serve"] : ["watch"];
  return [o.harborBin, ...(o.harborPrefixArgs ?? []), ...sub];
}

function envFor(o: ServiceOptions): Record<string, string> {
  const env: Record<string, string> = {};
  if (o.unit === "serve") {
    if (o.dataDir) {
      assertAbsolute(o.dataDir, "--data-dir");
      env.HARBOR_DATA_DIR = o.dataDir;
    }
    if (o.host) env.HARBOR_HOST = o.host;
    if (o.port !== undefined) env.HARBOR_PORT = String(o.port);
  }
  return { ...env, ...(o.env ?? {}) };
}

export function renderService(o: ServiceOptions): RenderedService {
  const argv = argvFor(o);
  const env = envFor(o);
  argv.forEach((a, i) => assertPlain(a, `argument ${i}`));
  for (const [k, v] of Object.entries(env)) assertPlain(`${k}=${v}`, `environment variable ${k}`);
  if (o.workingDir) assertPlain(o.workingDir, "--working-dir");
  if (o.label) assertPlain(o.label, "--label");
  const home = o.home ?? homedir();
  const stem = o.label ?? `harbor-${o.unit}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(stem)) {
    throw new ServiceError(`invalid label ${JSON.stringify(stem)} (letters, digits, '.', '_', '-')`);
  }
  for (const k of Object.keys(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new ServiceError(`invalid environment variable name: ${JSON.stringify(k)}`);
  }
  if (o.workingDir) assertAbsolute(o.workingDir, "--working-dir");

  if (o.target === "launchd") {
    const label = o.label ?? `dev.harbor.${o.unit}`;
    const logDir = join(home, "Library", "Logs");
    const filename = `${label}.plist`;
    const envBlock =
      Object.keys(env).length === 0
        ? ""
        : `  <key>EnvironmentVariables</key>\n  <dict>\n${Object.entries(env)
            .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
            .join("\n")}\n  </dict>\n`;
    const content =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
      `<plist version="1.0">\n<dict>\n` +
      `  <key>Label</key>\n  <string>${xml(label)}</string>\n` +
      `  <key>ProgramArguments</key>\n  <array>\n${argv.map((a) => `    <string>${xml(a)}</string>`).join("\n")}\n  </array>\n` +
      envBlock +
      (o.workingDir ? `  <key>WorkingDirectory</key>\n  <string>${xml(o.workingDir)}</string>\n` : "") +
      `  <key>RunAtLoad</key>\n  <true/>\n` +
      `  <key>KeepAlive</key>\n  <true/>\n` +
      `  <key>ThrottleInterval</key>\n  <integer>10</integer>\n` +
      `  <key>StandardOutPath</key>\n  <string>${xml(join(logDir, `${stem}.log`))}</string>\n` +
      `  <key>StandardErrorPath</key>\n  <string>${xml(join(logDir, `${stem}.log`))}</string>\n` +
      `</dict>\n</plist>\n`;
    const installPath = join(home, "Library", "LaunchAgents", filename);
    return {
      filename,
      content,
      installPath,
      activate: [
        `launchctl bootstrap gui/$(id -u) ${installPath}`,
        `launchctl kickstart -k gui/$(id -u)/${label}`,
        `# stop and remove later: launchctl bootout gui/$(id -u)/${label}`,
      ],
    };
  }

  // systemd (per-user unit)
  const filename = `${stem}.service`;
  const envLines = Object.entries(env).map(([k, v]) => `Environment=${systemdWord(`${k}=${v}`)}`);
  const content =
    `[Unit]\nDescription=${DESCRIPTIONS[o.unit]}\nAfter=network-online.target\nWants=network-online.target\n\n` +
    `[Service]\nType=simple\nExecStart=${argv.map(systemdWord).join(" ")}\n` +
    (o.workingDir ? `WorkingDirectory=${systemdWord(o.workingDir)}\n` : "") +
    (envLines.length ? envLines.join("\n") + "\n" : "") +
    `Restart=on-failure\nRestartSec=5\n` +
    `NoNewPrivileges=yes\nPrivateTmp=yes\n\n` +
    `[Install]\nWantedBy=default.target\n`;
  const installPath = join(home, ".config", "systemd", "user", filename);
  return {
    filename,
    content,
    installPath,
    activate: [
      `systemctl --user daemon-reload`,
      `systemctl --user enable --now ${filename}`,
      `# keep it running after logout: loginctl enable-linger $USER`,
    ],
  };
}
