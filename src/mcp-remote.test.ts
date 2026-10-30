import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Config, DEFAULTS, deepMerge } from "./config.ts";
import { Environment } from "./env.ts";
import { roomMcpConfig } from "./mcp.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-mcp-remote-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("remote (url) MCP servers", () => {
  test("a stdio server still emits command/args/env and no url", () => {
    const cfg = roomMcpConfig([
      { name: "local", command: "node", args: ["server.js"], env: { K: "V" } },
    ]);
    expect(cfg.mcpServers.local).toEqual({
      command: "node",
      args: ["server.js"],
      env: { K: "V" },
    });
  });

  test("a url server emits url + type and NEVER a command", () => {
    const cfg = roomMcpConfig([{ name: "hf", url: "https://huggingface.co/mcp" }]);
    expect(cfg.mcpServers.hf).toEqual({ url: "https://huggingface.co/mcp", type: "http" });
    // The regression this guards: `command: ""` made clients spawn an empty binary.
    expect(cfg.mcpServers.hf).not.toHaveProperty("command");
  });

  test("type defaults to http and honours sse", () => {
    const cfg = roomMcpConfig([
      { name: "a", url: "https://x/mcp" },
      { name: "b", url: "https://y/mcp", type: "sse" },
    ]);
    expect(cfg.mcpServers.a.type).toBe("http");
    expect(cfg.mcpServers.b.type).toBe("sse");
  });

  test("headers are carried and stringified", () => {
    const cfg = roomMcpConfig([
      { name: "authed", url: "https://z/mcp", headers: { Authorization: "Bearer x" } },
    ]);
    expect(cfg.mcpServers.authed.headers).toEqual({ Authorization: "Bearer x" });
  });

  test("a url server ignores stale command/args/env rather than merging them", () => {
    const cfg = roomMcpConfig([
      { name: "mixed", url: "https://w/mcp", command: "node", args: ["x"], env: { A: "B" } },
    ]);
    expect(cfg.mcpServers.mixed.command).toBeUndefined();
    expect(cfg.mcpServers.mixed.args).toBeUndefined();
    expect(cfg.mcpServers.mixed.env).toBeUndefined();
  });

  test("an empty url is treated as stdio, not a remote server", () => {
    const cfg = roomMcpConfig([{ name: "blank", url: "", command: "node" }]);
    expect(cfg.mcpServers.blank.url).toBeUndefined();
    expect(cfg.mcpServers.blank.command).toBe("node");
  });

  test("mixed rooms keep both transports side by side", () => {
    const cfg = roomMcpConfig([
      { name: "local", command: "node", args: ["s.js"] },
      { name: "remote", url: "https://huggingface.co/mcp" },
    ]);
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(["local", "remote"]);
    expect(cfg.mcpServers.local.command).toBe("node");
    expect(cfg.mcpServers.remote.url).toBe("https://huggingface.co/mcp");
  });
});
