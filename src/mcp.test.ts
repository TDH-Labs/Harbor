import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Config, DEFAULTS, deepMerge } from "./config.ts";
import { Environment } from "./env.ts";
import {
  checkCommand,
  checkEnvVars,
  extractEnvVars,
  generateRoomConfig,
  generateRoomConfigs,
  mergeConfigs,
  roomMcpConfig,
  roomsWithMcp,
  testConnect,
  validateAllRooms,
  validateRoom,
  validateServer,
  validateServerShape,
} from "./mcp.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-mcp-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function env(rooms: Record<string, unknown> = {}): Environment {
  const cfg = new Config(deepMerge(DEFAULTS, { skills: { rooms } }));
  return new Environment(dir, cfg);
}

// A generic example MCP server (filesystem) — de-personalized, no client servers.
const fsServer = {
  name: "filesystem",
  command: "echo", // a command guaranteed to exist on PATH for the test
  args: ["-y", "@modelcontextprotocol/server-filesystem"],
  env: { ALLOWED_DIR: "${WORKSPACE_DIR}" },
};

describe("extractEnvVars", () => {
  test("reads a nested env table (TOML env.KEY form)", () => {
    expect(extractEnvVars({ name: "x", command: "c", env: { TOKEN: "$GH" } } as any)).toEqual({
      TOKEN: "$GH",
    });
  });
  test("reads flat env.KEY keys too", () => {
    expect(extractEnvVars({ name: "x", command: "c", "env.TOKEN": "$GH" } as any)).toEqual({
      TOKEN: "$GH",
    });
  });
  test("no env → empty object", () => {
    expect(extractEnvVars({ name: "x", command: "c" } as any)).toEqual({});
  });
});

describe("checkCommand", () => {
  test("resolves a command on PATH", () => {
    const r = checkCommand("echo");
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("echo");
  });
  test("fails for a missing command", () => {
    expect(checkCommand("definitely-not-a-real-binary-xyz").ok).toBe(false);
  });
  test("checks an absolute path for executability", () => {
    expect(checkCommand("/bin/sh").ok).toBe(true);
    expect(checkCommand("/nonexistent/path/binary").ok).toBe(false);
  });
});

describe("checkEnvVars", () => {
  test("$VAR set / unset, literal, and ${VAR} forms", () => {
    const procEnv = { PRESENT: "yes" };
    const results = checkEnvVars(
      { A: "$PRESENT", B: "$MISSING", C: "literal", D: "${PRESENT}" },
      procEnv,
    );
    const byCheck = Object.fromEntries(results.map((r) => [r.check, r.ok]));
    expect(byCheck["env.A"]).toBe(true);
    expect(byCheck["env.B"]).toBe(false);
    expect(byCheck["env.C"]).toBe(true);
    expect(byCheck["env.D"]).toBe(true);
  });
});

describe("validateServerShape", () => {
  test("flags missing name and command", () => {
    expect(validateServerShape({ name: "x" } as any)).toEqual(["missing 'command'"]);
    expect(validateServerShape({ command: "c" } as any)).toEqual(["missing 'name'"]);
    expect(validateServerShape({ name: "x", command: "c" } as any)).toEqual([]);
  });
});

describe("validateServer", () => {
  test("passes command + env checks for a resolvable server (no connectivity)", async () => {
    const v = await validateServer(fsServer as any, { procEnv: { WORKSPACE_DIR: "/tmp" } });
    expect(v.server).toBe("filesystem");
    expect(v.ok).toBe(true);
    expect(v.checks.find((c) => c.check === "command_exists")!.ok).toBe(true);
    expect(v.checks.find((c) => c.check === "env.ALLOWED_DIR")!.ok).toBe(true);
    expect(v.checks.some((c) => c.check === "connectivity")).toBe(false);
  });

  test("fails when a referenced env var is unset", async () => {
    const v = await validateServer(fsServer as any, { procEnv: {} });
    expect(v.ok).toBe(false);
    expect(v.checks.find((c) => c.check === "env.ALLOWED_DIR")!.ok).toBe(false);
  });

  test("missing command → command_exists fails and connectivity is skipped", async () => {
    const v = await validateServer(
      { name: "broken", command: "definitely-not-a-real-binary-xyz" } as any,
      { connectivity: true },
    );
    expect(v.checks.find((c) => c.check === "command_exists")!.ok).toBe(false);
    const conn = v.checks.find((c) => c.check === "connectivity")!;
    expect(conn.ok).toBe(false);
    expect(conn.detail).toContain("skipped");
  });

  test("structural errors surface for a malformed server", async () => {
    const v = await validateServer({ args: [] } as any);
    expect(v.errors).toContain("missing 'name'");
    expect(v.errors).toContain("missing 'command'");
    expect(v.ok).toBe(false);
  });
});

describe("testConnect", () => {
  test("a fast-exiting command counts as runnable", async () => {
    const r = await testConnect("echo", ["hi"], {}, 2000);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("exited");
  });
  test("a spawn failure is a hard fail", async () => {
    const r = await testConnect("definitely-not-a-real-binary-xyz", [], {}, 2000);
    expect(r.ok).toBe(false);
  });
});

describe("validateRoom / validateAllRooms", () => {
  test("no_servers status when a room declares none", async () => {
    const e = env({ ops: { description: "Ops", skills: [] } });
    const v = await validateRoom(e, "ops");
    expect(v.status).toBe("no_servers");
  });

  test("ok status when all servers validate", async () => {
    const e = env({
      ops: { description: "Ops", skills: [], mcp: { servers: [fsServer] } },
    });
    const v = await validateRoom(e, "ops", { procEnv: { WORKSPACE_DIR: "/tmp" } });
    expect(v.status).toBe("ok");
    expect(v.servers).toHaveLength(1);
  });

  test("validateAllRooms covers every configured room", async () => {
    const e = env({
      a: { description: "A", skills: [], mcp: { servers: [fsServer] } },
      b: { description: "B", skills: [] },
    });
    const all = await validateAllRooms(e, { procEnv: { WORKSPACE_DIR: "/tmp" } });
    expect(all.map((r) => r.room).sort()).toEqual(["a", "b"]);
  });
});

describe("roomMcpConfig + generateRoomConfig(s)", () => {
  test("builds the standard mcpServers shape with args + env", () => {
    const config = roomMcpConfig([fsServer as any]);
    expect(config.mcpServers.filesystem).toEqual({
      command: "echo",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
      env: { ALLOWED_DIR: "${WORKSPACE_DIR}" },
    });
  });

  test("omits args/env when absent", () => {
    const config = roomMcpConfig([{ name: "bare", command: "x" } as any]);
    expect(config.mcpServers.bare).toEqual({ command: "x" });
  });

  test("generateRoomConfig writes .room-mcp.json; null when no servers", () => {
    const e = env({
      ops: { description: "Ops", skills: [], mcp: { servers: [fsServer] } },
      empty: { description: "Empty", skills: [] },
    });
    const opsPath = generateRoomConfig(e, "ops");
    expect(opsPath).not.toBeNull();
    expect(existsSync(opsPath!)).toBe(true);
    const doc = JSON.parse(readFileSync(opsPath!, "utf8"));
    expect(doc.mcpServers.filesystem.command).toBe("echo");
    expect(generateRoomConfig(e, "empty")).toBeNull();
  });

  test("generateRoomConfigs covers all rooms; roomsWithMcp lists only those with servers", () => {
    const e = env({
      ops: { description: "Ops", skills: [], mcp: { servers: [fsServer] } },
      empty: { description: "Empty", skills: [] },
    });
    const results = generateRoomConfigs(e);
    expect(results.ops).not.toBeNull();
    expect(results.empty).toBeNull();
    expect(roomsWithMcp(e)).toEqual(["ops"]);
  });
});

describe("mergeConfigs", () => {
  const gh = { name: "github", command: "echo", args: ["gh"] };
  function twoRooms(): Environment {
    return env({
      books: { description: "Books", skills: [], mcp: { servers: [{ ...fsServer, name: "shared" }] } },
      devops: { description: "Dev", skills: [], mcp: { servers: [gh, { ...fsServer, name: "shared" }] } },
    });
  }

  test("prefixes server names with room by default", () => {
    const merged = mergeConfigs(twoRooms(), ["books", "devops"]);
    expect(Object.keys(merged.mcpServers).sort()).toEqual([
      "books-shared",
      "devops-github",
      "devops-shared",
    ]);
  });

  test("no-prefix keeps bare names and only disambiguates collisions", () => {
    const merged = mergeConfigs(twoRooms(), ["books", "devops"], { prefix: false });
    // 'shared' from books keeps the bare name; devops 'shared' collides → prefixed
    expect(merged.mcpServers.shared).toBeDefined();
    expect(merged.mcpServers.github).toBeDefined();
    expect(merged.mcpServers["devops-shared"]).toBeDefined();
  });

  test("skips unknown rooms and can write to a file", () => {
    const out = join(dir, "merged.json");
    const merged = mergeConfigs(twoRooms(), ["books", "ghost"], { output: out });
    expect(Object.keys(merged.mcpServers)).toEqual(["books-shared"]);
    expect(JSON.parse(readFileSync(out, "utf8")).mcpServers["books-shared"]).toBeDefined();
  });
});
