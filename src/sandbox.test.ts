import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Config, DEFAULTS, deepMerge } from "./config.ts";
import { Environment } from "./env.ts";
import {
  AgentSession,
  auditRead,
  checkDataAccess,
  checkFileAccess,
  enforceDataAccess,
  enforceFileAccess,
  AccessDenied,
} from "./isolation.ts";
import {
  ROOM_JAIL_PREFIX,
  RoomJailViolation,
  RoomPathSandbox,
  createRoomSandbox,
  isRealPathWithin,
  isValidRoomName,
  realpathLoose,
} from "./sandbox.ts";
import { isPathWithin } from "./path-safety.ts";
import { spawn } from "./spawn.ts";

// A "dirty machine" fixture: two rooms side by side, a secret in the OTHER room,
// and symlinks planted inside the first room that point at it. The lexical
// check this replaces called every one of these "inside".

let dir: string; // real (symlink-free) temp root
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "harbor-sandbox-")));
  mkdirSync(join(dir, "workspace", "legal", "sub"), { recursive: true });
  mkdirSync(join(dir, "workspace", "finance", "deep"), { recursive: true });
  mkdirSync(join(dir, "workspace", "legal-private"), { recursive: true });
  writeFileSync(join(dir, "workspace", "legal", "draft.md"), "ok");
  writeFileSync(join(dir, "workspace", "finance", "secret.md"), "SECRET");
  writeFileSync(join(dir, "workspace", "legal-private", "secret.md"), "SECRET");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ws = (...p: string[]) => join(dir, "workspace", ...p);

function env(): Environment {
  const cfg = new Config(deepMerge(DEFAULTS, { paths: { state_dir: join(dir, ".agent-env") } }));
  return new Environment(dir, cfg);
}

describe("realpathLoose", () => {
  test("follows an existing symlink to its target", () => {
    symlinkSync(ws("finance", "secret.md"), ws("legal", "link.md"));
    expect(realpathLoose(ws("legal", "link.md"))).toBe(ws("finance", "secret.md"));
  });

  test("applies `..` to the RESOLVED path, the way the kernel does", () => {
    // legal/hop -> finance/deep. `hop/..` is finance (the parent of the target),
    // NOT legal (the lexical parent of the link).
    symlinkSync(ws("finance", "deep"), ws("legal", "hop"));
    // Plain concatenation on purpose: path.join would normalize the `..`
    // lexically BEFORE the code under test ever saw it, hiding the trick.
    expect(realpathLoose(ws("legal", "hop") + "/../secret.md")).toBe(ws("finance", "secret.md"));
  });

  test("resolves a chain of relative symlinks", () => {
    symlinkSync("../finance/secret.md", ws("legal", "rel.md"));
    symlinkSync("rel.md", ws("legal", "chain.md"));
    expect(realpathLoose(ws("legal", "chain.md"))).toBe(ws("finance", "secret.md"));
  });

  test("a tail that does not exist yet is appended lexically", () => {
    expect(realpathLoose(ws("legal", "new", "file.md"))).toBe(ws("legal", "new", "file.md"));
    expect(realpathLoose(ws("legal", "new", "..", "x.md"))).toBe(ws("legal", "x.md"));
  });

  test("a symlink loop throws instead of hanging", () => {
    symlinkSync(ws("legal", "b"), ws("legal", "a"));
    symlinkSync(ws("legal", "a"), ws("legal", "b"));
    expect(() => realpathLoose(ws("legal", "a"))).toThrow(/symbolic links/);
  });

  test("a NUL byte is rejected", () => {
    expect(() => realpathLoose(ws("legal", "x\0y"))).toThrow(/NUL/);
  });

  test("relative input resolves against the supplied cwd", () => {
    expect(realpathLoose("draft.md", ws("legal"))).toBe(ws("legal", "draft.md"));
  });
});

describe("isRealPathWithin", () => {
  test("string-prefix siblings are not inside (legal vs legal-private)", () => {
    expect(isRealPathWithin(ws("legal-private", "secret.md"), ws("legal"))).toBe(false);
    expect(isRealPathWithin(ws("legal", "draft.md"), ws("legal"))).toBe(true);
    expect(isRealPathWithin(ws("legal"), ws("legal"))).toBe(true);
  });

  test("a symlink loop is 'outside', not an exception", () => {
    symlinkSync(ws("legal", "b"), ws("legal", "a"));
    symlinkSync(ws("legal", "a"), ws("legal", "b"));
    expect(isRealPathWithin(ws("legal", "a"), ws("legal"))).toBe(false);
  });
});

describe("isValidRoomName", () => {
  test.each(["legal", "incident_response", "data-eng", "r2", "a.b"])("accepts %s", (r) => {
    expect(isValidRoomName(r)).toBe(true);
  });
  test.each(["", "..", ".", "a/b", "a\\b", "../x", ".hidden", "a..b", "x".repeat(65), "a b", "a\0b"])(
    "rejects %j",
    (r) => {
      expect(isValidRoomName(r)).toBe(false);
    },
  );
});

describe("RoomPathSandbox — the escapes the lexical check missed", () => {
  const sandbox = () => new RoomPathSandbox({ room: "legal", roots: [ws("legal")] });

  test("allows files in the room, including ones that do not exist yet", () => {
    expect(sandbox().contains(ws("legal", "draft.md"))).toBe(true);
    expect(sandbox().contains(ws("legal", "sub", "brand-new.md"))).toBe(true);
    expect(sandbox().contains(ws("legal"))).toBe(true);
  });

  test("denies a symlink planted in the room that points at another room's file", () => {
    symlinkSync(ws("finance", "secret.md"), ws("legal", "innocent.md"));
    const r = sandbox().check(ws("legal", "innocent.md"));
    expect(r.ok).toBe(false);
    // and the lexical check this replaces would have said yes:
    expect(ws("legal", "innocent.md").startsWith(ws("legal"))).toBe(true);
  });

  test("denies a symlinked directory pointing at another room", () => {
    symlinkSync(ws("finance"), ws("legal", "shortcut"));
    expect(sandbox().contains(ws("legal", "shortcut", "secret.md"))).toBe(false);
    // creating a NEW file through the symlinked dir is denied too
    expect(sandbox().contains(ws("legal", "shortcut", "planted.md"))).toBe(false);
  });

  test("denies `link/../x` where the kernel follows the link before applying `..`", () => {
    // legal/hop -> finance/deep ; legal/hop/../secret.md is finance/secret.md.
    symlinkSync(ws("finance", "deep"), ws("legal", "hop"));
    const sneaky = ws("legal", "hop") + "/../secret.md"; // not path.join: see realpathLoose tests
    expect(sandbox().contains(sneaky)).toBe(false);
    // the lexical check this replaces calls the very same string "inside":
    expect(isPathWithin(sneaky, ws("legal"))).toBe(true);
  });

  test("denies plain `..` escapes, sibling rooms, absolute paths, and the string-prefix sibling", () => {
    const sb = sandbox();
    expect(sb.contains(join(ws("legal"), "..", "finance", "secret.md"))).toBe(false);
    expect(sb.contains(ws("finance", "secret.md"))).toBe(false);
    expect(sb.contains(ws("legal-private", "secret.md"))).toBe(false);
    expect(sb.contains("/etc/passwd")).toBe(false);
    expect(sb.contains("../finance/secret.md")).toBe(false); // relative to the room root
  });

  test("denies empty paths, NUL bytes, and loops", () => {
    const sb = sandbox();
    expect(sb.contains("")).toBe(false);
    expect(sb.contains(ws("legal", "x\0.md"))).toBe(false);
    symlinkSync(ws("legal", "b"), ws("legal", "a"));
    symlinkSync(ws("legal", "a"), ws("legal", "b"));
    expect(sb.contains(ws("legal", "a"))).toBe(false);
  });

  test("allows a symlink that stays inside the room", () => {
    symlinkSync(ws("legal", "draft.md"), ws("legal", "alias.md"));
    expect(sandbox().resolve(ws("legal", "alias.md"))).toBe(ws("legal", "draft.md"));
  });

  test("a symlink introduced AFTER construction is still seen (roots and paths re-resolve)", () => {
    const sb = sandbox();
    expect(sb.contains(ws("legal", "late.md"))).toBe(true);
    symlinkSync(ws("finance", "secret.md"), ws("legal", "late.md"));
    expect(sb.contains(ws("legal", "late.md"))).toBe(false);
  });

  test("a root that is itself reached through a symlink still contains its real files", () => {
    symlinkSync(ws("legal"), join(dir, "legal-alias"));
    const sb = new RoomPathSandbox({ room: "legal", roots: [join(dir, "legal-alias")] });
    expect(sb.contains(ws("legal", "draft.md"))).toBe(true);
    expect(sb.contains(ws("finance", "secret.md"))).toBe(false);
  });

  test("relative paths mean 'in this room' (anchored at the primary root)", () => {
    const sb = sandbox();
    expect(sb.resolve("draft.md")).toBe(ws("legal", "draft.md"));
    expect(sb.contains("../finance/secret.md")).toBe(false);
  });

  test("resolve throws a RoomJailViolation whose message carries the prefix", () => {
    let err: unknown;
    try {
      sandbox().resolve(ws("finance", "secret.md"));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RoomJailViolation);
    expect((err as RoomJailViolation).message.startsWith(ROOM_JAIL_PREFIX)).toBe(true);
    expect((err as RoomJailViolation).room).toBe("legal");
  });

  test("hostile room names are rejected at construction", () => {
    for (const room of ["", "..", "../finance", "a/b", ".hidden"]) {
      expect(() => new RoomPathSandbox({ room, roots: [ws("legal")] }), room).toThrow(RoomJailViolation);
      expect(() => createRoomSandbox(dir, room), room).toThrow(RoomJailViolation);
    }
    expect(() => new RoomPathSandbox({ room: "legal", roots: [] })).toThrow(RoomJailViolation);
  });

  test("multiple roots: a path in any of them is inside", () => {
    mkdirSync(join(dir, "rooms", "legal"), { recursive: true });
    const sb = createRoomSandbox(dir, "legal");
    expect(sb.contains(join(dir, "rooms", "legal", "room_rules.md"))).toBe(true);
    expect(sb.contains(ws("legal", "draft.md"))).toBe(true);
    expect(sb.contains(join(dir, "rooms", "finance", "room_rules.md"))).toBe(false);
  });

  test("resolveCwd creates the primary root and returns its real path", () => {
    const sb = createRoomSandbox(dir, "legal");
    const cwd = sb.resolveCwd();
    expect(cwd).toBe(join(dir, "rooms", "legal"));
    expect(sb.resolveCwd(ws("legal", "sub"))).toBe(ws("legal", "sub"));
    expect(() => sb.resolveCwd(ws("finance"))).toThrow(RoomJailViolation);
  });
});

describe("checkFileAccess / checkDataAccess use the real-path sandbox", () => {
  test("a planted symlink no longer passes checkFileAccess", () => {
    const e = env();
    const s = new AgentSession({ room: "legal", capabilities: ["file_read"] });
    symlinkSync(ws("finance", "secret.md"), ws("legal", "innocent.md"));
    expect(checkFileAccess(s, ws("legal", "innocent.md"), "read", e)).toBe(false);
    expect(checkFileAccess(s, ws("legal", "draft.md"), "read", e)).toBe(true);
  });

  test("`rooms/<room>` is an allowed file root; another room's is not", () => {
    const e = env();
    const s = new AgentSession({ room: "legal", capabilities: ["file_read"] });
    expect(checkFileAccess(s, join(dir, "rooms", "legal", "notes.md"), "read", e)).toBe(true);
    expect(checkFileAccess(s, join(dir, "rooms", "finance", "notes.md"), "read", e)).toBe(false);
  });

  test("a session whose room is `..` (or another traversal-shaped name) is denied everything", () => {
    const e = env();
    for (const room of ["..", "../finance", "a/b", ".hidden"]) {
      const s = new AgentSession({ room, capabilities: ["file_read", "data_read"] });
      expect(checkFileAccess(s, ws("finance", "secret.md"), "read", e), room).toBe(false);
      expect(checkFileAccess(s, join(dir, "anything"), "read", e), room).toBe(false);
      expect(checkDataAccess(s, join(dir, "data", "x.db"), e), room).toBe(false);
    }
  });

  test("data access follows symlinks too", () => {
    const e = env();
    mkdirSync(join(dir, "data", "legal"), { recursive: true });
    mkdirSync(join(dir, "data", "finance"), { recursive: true });
    writeFileSync(join(dir, "data", "finance", "books.db"), "x");
    symlinkSync(join(dir, "data", "finance", "books.db"), join(dir, "data", "legal", "books.db"));
    const s = new AgentSession({ room: "legal", capabilities: ["data_read"] });
    expect(checkDataAccess(s, join(dir, "data", "legal", "books.db"), e)).toBe(false);
  });
});

describe("enforceFileAccess / enforceDataAccess (throwing, auditing)", () => {
  test("returns the real path to open for an allowed file", () => {
    const e = env();
    const s = new AgentSession({ room: "legal", capabilities: ["file_read"] });
    expect(enforceFileAccess(s, ws("legal", "draft.md"), "read", e)).toBe(ws("legal", "draft.md"));
  });

  test("a jail escape throws RoomJailViolation and is audited as room_jail_violation", () => {
    const e = env();
    const s = new AgentSession({ room: "legal", capabilities: ["file_read"] });
    symlinkSync(ws("finance", "secret.md"), ws("legal", "innocent.md"));
    expect(() => enforceFileAccess(s, ws("legal", "innocent.md"), "read", e)).toThrow(RoomJailViolation);
    const rows = auditRead(e, { room: "legal" }).filter((r) => r.event === "room_jail_violation");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.decision).toBe("denied");
    expect(rows[0]?.capability).toBe("file_read");
  });

  test("a missing capability is an AccessDenied, not a jail violation", () => {
    const e = env();
    const s = new AgentSession({ room: "legal", capabilities: ["file_read"] });
    expect(() => enforceFileAccess(s, ws("legal", "draft.md"), "write", e)).toThrow(AccessDenied);
  });

  test("ADMIN bypasses the jail (returns the real path) but capability is still needed", () => {
    const e = env();
    const admin = new AgentSession({ room: "legal", capabilities: ["file_read", "admin"] });
    expect(enforceFileAccess(admin, ws("finance", "secret.md"), "read", e)).toBe(ws("finance", "secret.md"));
    const noCap = new AgentSession({ room: "legal", capabilities: ["admin"] });
    expect(() => enforceFileAccess(noCap, ws("finance", "secret.md"), "read", e)).toThrow(AccessDenied);
  });

  test("enforceDataAccess confines to data/<room>", () => {
    const e = env();
    const s = new AgentSession({ room: "legal", capabilities: ["data_read"] });
    expect(enforceDataAccess(s, join(dir, "data", "legal", "a.db"), e)).toBe(join(dir, "data", "legal", "a.db"));
    expect(() => enforceDataAccess(s, join(dir, "data", "finance", "a.db"), e)).toThrow(RoomJailViolation);
  });

  test("an oversized hostile path is truncated in the audit row", () => {
    const e = env();
    const s = new AgentSession({ room: "legal", capabilities: ["file_read"] });
    const long = ws("finance", "x".repeat(5000));
    expect(() => enforceFileAccess(s, long, "read", e)).toThrow(RoomJailViolation);
    const row = auditRead(e, { room: "legal" }).find((r) => r.event === "room_jail_violation");
    expect(row?.resource.length).toBeLessThanOrEqual(512);
  });
});

describe("spawn({ confineToRoom })", () => {
  async function out(s: ReadableStream<Uint8Array> | number | undefined): Promise<string> {
    return !s || typeof s === "number" ? "" : new Response(s).text();
  }

  test("cwd defaults to the room root, created on demand", async () => {
    const e = env();
    const child = spawn("pwd", [], { harborEnv: e, room: "legal", confineToRoom: true, track: false });
    await child.exited;
    expect((await out(child.stdout)).trim()).toBe(join(dir, "rooms", "legal"));
    expect(child.allowedPaths).toContain(join(dir, "rooms", "legal"));
  });

  test("an explicit cwd inside the room is honored", async () => {
    const e = env();
    const child = spawn("pwd", [], {
      harborEnv: e,
      room: "legal",
      cwd: ws("legal", "sub"),
      confineToRoom: true,
      track: false,
    });
    await child.exited;
    expect((await out(child.stdout)).trim()).toBe(ws("legal", "sub"));
  });

  test("a cwd in another room is refused before anything launches, and audited", () => {
    const e = env();
    expect(() =>
      spawn("pwd", [], { harborEnv: e, room: "legal", cwd: ws("finance"), confineToRoom: true }),
    ).toThrow(RoomJailViolation);
    expect(auditRead(e, { room: "legal" }).some((r) => r.capability === "spawn" && r.decision === "denied")).toBe(true);
  });

  test("a cwd reached through a planted symlink is refused", () => {
    const e = env();
    symlinkSync(ws("finance"), ws("legal", "shortcut"));
    expect(() =>
      spawn("pwd", [], { harborEnv: e, room: "legal", cwd: ws("legal", "shortcut"), confineToRoom: true }),
    ).toThrow(RoomJailViolation);
  });

  test("an allowedPaths entry outside the room is refused", () => {
    const e = env();
    expect(() =>
      spawn("pwd", [], {
        harborEnv: e,
        room: "legal",
        allowedPaths: [ws("legal"), ws("finance")],
        confineToRoom: true,
      }),
    ).toThrow(RoomJailViolation);
  });

  test("a hostile room name is refused", () => {
    const e = env();
    expect(() => spawn("pwd", [], { harborEnv: e, room: "..", confineToRoom: true })).toThrow(RoomJailViolation);
  });

  test("without confineToRoom nothing changes (cwd is not forced)", async () => {
    const e = env();
    const child = spawn("pwd", [], { harborEnv: e, room: "legal", cwd: ws("finance"), track: false });
    await child.exited;
    expect((await out(child.stdout)).trim()).toBe(ws("finance"));
  });
});
