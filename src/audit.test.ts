import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type HypervisorEvent,
  audit,
  emitHypervisorEvent,
  onHypervisorEvent,
} from "./audit.ts";
import { Config, DEFAULTS, deepMerge } from "./config.ts";
import { Environment } from "./env.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harbor-audit-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function env(): Environment {
  const cfg = new Config(deepMerge(DEFAULTS, { paths: { state_dir: join(dir, ".agent-env") } }));
  return new Environment(dir, cfg);
}

describe("audit verbs", () => {
  test("deny records a denied entry surfaced by recent + denialsToday", () => {
    const e = env();
    audit.deny("s1", "read_skill", "nda-review", "not in room marketing", { room: "marketing", env: e });

    const entries = audit.recent({ env: e });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.decision).toBe("denied");
    expect(entries[0]?.capability).toBe("read_skill");
    expect(entries[0]?.resource).toBe("nda-review");
    expect(entries[0]?.room).toBe("marketing");
    expect(audit.denialsToday(undefined, { env: e })).toBe(1);
  });

  test("allow records an allowed entry that does NOT count as a denial", () => {
    const e = env();
    audit.allow("s1", "read_skill", "case-brief", "loaded 1623 tokens", { room: "legal", env: e });

    const entries = audit.recent({ env: e });
    expect(entries[0]?.decision).toBe("allowed");
    expect(audit.denialsToday(undefined, { env: e })).toBe(0);
  });

  test("denialsToday scopes by room", () => {
    const e = env();
    audit.deny("s1", "read_skill", "a", "x", { room: "marketing", env: e });
    audit.deny("s2", "read_skill", "b", "y", { room: "legal", env: e });
    expect(audit.denialsToday("marketing", { env: e })).toBe(1);
    expect(audit.denialsToday("legal", { env: e })).toBe(1);
    expect(audit.denialsToday(undefined, { env: e })).toBe(2);
  });

  test("recent honors the room filter and limit", () => {
    const e = env();
    for (let i = 0; i < 5; i++) audit.deny(`s${i}`, "read_skill", `r${i}`, "x", { room: "marketing", env: e });
    audit.deny("other", "read_skill", "z", "x", { room: "legal", env: e });
    expect(audit.recent({ env: e, room: "marketing" })).toHaveLength(5);
    expect(audit.recent({ env: e, limit: 2 })).toHaveLength(2);
  });
});

describe("hypervisor event bus", () => {
  test("subscribers receive emitted events; unsubscribe stops delivery", () => {
    const got: HypervisorEvent[] = [];
    const off = onHypervisorEvent((evt) => got.push(evt));

    emitHypervisorEvent({ kind: "spawn", event: "started", timestamp: 1 });
    expect(got).toHaveLength(1);
    expect(got[0]?.kind).toBe("spawn");

    off();
    emitHypervisorEvent({ kind: "spawn", event: "started", timestamp: 2 });
    expect(got).toHaveLength(1); // not delivered after unsubscribe
  });

  test("audit.deny / audit.allow emit an audit event with the decision", () => {
    const e = env();
    const got: HypervisorEvent[] = [];
    const off = onHypervisorEvent((evt) => got.push(evt));
    try {
      audit.deny("s1", "read_skill", "nda", "no", { room: "marketing", env: e });
      audit.allow("s1", "read_skill", "case-brief", "ok", { room: "legal", env: e });
    } finally {
      off();
    }
    expect(got.map((g) => `${g.kind}:${g.decision}`)).toEqual(["audit:denied", "audit:allowed"]);
  });

  test("a throwing subscriber does not break emit for others", () => {
    const got: string[] = [];
    const off1 = onHypervisorEvent(() => {
      throw new Error("bad subscriber");
    });
    const off2 = onHypervisorEvent((evt) => got.push(evt.kind));
    try {
      expect(() => emitHypervisorEvent({ kind: "gate", timestamp: 1 })).not.toThrow();
      expect(got).toEqual(["gate"]);
    } finally {
      off1();
      off2();
    }
  });
});
