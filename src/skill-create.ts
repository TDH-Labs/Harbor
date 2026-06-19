/**
 * skill-create.ts — Scaffold a new skill with a TDD harness.
 *
 * Creates a skill directory with a valid-frontmatter SKILL.md, a RED→GREEN→
 * REFACTOR test scenario, an examples file, and a README. With `register` (the
 * default off here — see {@link ScaffoldOptions}) it also copies the skill into
 * the pool, routes it to a room, and regenerates room indexes.
 *
 * Behavioral reference: `skill_create.py`. De-personalization (BUILD_BRIEF §3):
 * the prototype's SKILL.md frontmatter carried a fixed author tag and a
 * vendor-specific metadata block tied to its host skill system. The shipped
 * template uses a neutral `metadata.{tags,category}` block and names no author
 * or host system.
 *
 * Downstream contract: `scaffold(env, name, options)` returns the created paths.
 */
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";

import type { Environment } from "./env.ts";
import { addSkillToRoom, reloadEnv } from "./config-edit.ts";
import { generateRoomIndexes } from "./skills.ts";

export class SkillCreateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillCreateError";
  }
}

export interface ScaffoldOptions {
  /** Target room. Required when `register` is true; recorded in README otherwise. */
  room?: string;
  /** One-line description (defaults to a title-cased name). */
  description?: string;
  /** Copy into the pool + route to a room + regenerate indexes. Default false. */
  register?: boolean;
  /** Working directory for the scaffold (default `<cwd>/skills-in-progress`). */
  workDir?: string;
}

export interface ScaffoldResult {
  /** Absolute path to the scaffolded skill directory. */
  skillDir: string;
  /** Absolute paths of every file written, in creation order. */
  files: string[];
  /** True if the skill was copied into the pool and routed to a room. */
  registered: boolean;
  /** The room recorded (and, if registered, routed to). */
  room: string | null;
}

// ── inference helpers (ported verbatim — generic, no machine data) ───────────

/** `my-skill_name` → `my, skill, name` as comma-separated tags. */
export function nameToTags(name: string): string {
  return name
    .replace(/[-_]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(", ");
}

/** Infer a coarse category from the name + description keywords. */
export function inferCategory(name: string, description: string): string {
  const text = `${name} ${description}`.toLowerCase();
  const has = (...ws: string[]) => ws.some((w) => text.includes(w));
  if (has("tool", "cli", "command", "api", "integration")) return "productivity";
  if (has("data", "analyze", "report", "metric", "kpi")) return "analytics";
  if (has("code", "dev", "test", "deploy", "ci", "build")) return "development";
  if (has("market", "seo", "social", "content", "ad")) return "marketing";
  if (has("legal", "law", "compliance", "regula")) return "legal";
  if (has("financ", "invest", "account", "tax", "budget")) return "finance";
  if (has("research", "paper", "academ", "study")) return "research";
  return "productivity";
}

/** Build a test prompt from the description. */
export function inferPrompt(description: string): string {
  const base = description.replace(/\.+$/, "");
  return `How do I ${base.toLowerCase()}?`;
}

// ── templates ──────────────────────────────────────────────────────────────--

function skillTemplate(name: string, description: string, tags: string, category: string): string {
  return `---
name: ${name}
description: ${description}
version: 0.1.0
license: MIT
metadata:
  tags: [${tags}]
  category: ${category}
  related_skills: []
---

# ${name}

${description}

## When to use

*When the user says...* "..."

## How to use

\`\`\`
example command or invocation
\`\`\`

## Procedure

### Step 1: ...

### Step 2: ...

## Notes

-
`;
}

function testScenarioTemplate(name: string, prompt: string): string {
  return `# TDD Pressure Scenario: ${name}

## RED Phase — Run without the skill

**Purpose:** Observe baseline behavior — what does an agent do when it doesn't
have the ${name} skill? Document the failures.

**Scenario prompt:**
\`\`\`
${prompt}
\`\`\`

**Expected failure modes (check at least 3):**
- [ ] {Agent does not follow procedure Step 1}
- [ ] {Agent skips Step 2, goes straight to guess}
- [ ] {Agent invents a tool that doesn't exist}
- [ ] {Agent hallucinates a workflow step}
- [ ] ...

**Record observations here:**
\`\`\`
RED run: <date>
Results: ...
Rationalizations observed: ...
\`\`\`

---

## GREEN Phase — Run with the skill

**Purpose:** Verify the skill fixes the failures seen in RED.

**Setup:** Ensure \`${name}/SKILL.md\` is loaded into context.

**Same scenario prompt:**
\`\`\`
${prompt}
\`\`\`

**Expected compliance:**
- [ ] {Agent follows Step 1 correctly}
- [ ] {Agent does Step 2 properly}
- [ ] {No invented tools}
- [ ] {Output matches expected format}

**Record observations here:**
\`\`\`
GREEN run: <date>
Results: ...
Any remaining rationalizations: ...
\`\`\`

---

## REFACTOR Phase

**Purpose:** Close any loopholes found during GREEN.

**Loopholes to plug:**
1. { }
2. { }

**Changes made:**
- { }
`;
}

function basicUsageTemplate(name: string, prompt: string): string {
  return `# ${name} — Basic Usage

## Example

**User says:**
\`\`\`
${prompt}
\`\`\`

**Expected behavior:**
1. Agent recognizes this as a ${name} task
2. Agent follows Step 1: ...
3. Agent follows Step 2: ...
4. Output: ...

## Common variations
-
`;
}

function readmeTemplate(name: string, description: string, room: string): string {
  return `# ${name}

${description}

## TDD Status

| Phase | Status | Date |
|-------|--------|------|
| RED   | ☐ | |
| GREEN | ☐ | |
| REFACTOR | ☐ | |

## Files

| File | Purpose |
|------|---------|
| \`SKILL.md\` | Skill definition — the main document |
| \`tests/test_scenario.md\` | TDD pressure scenario (RED→GREEN→REFACTOR) |
| \`examples/basic_usage.md\` | Example prompts and expected behavior |

## Room

${room}
`;
}

// ── scaffold ───────────────────────────────────────────────────────────────--

/**
 * Scaffold a new skill. Returns the created paths. Throws
 * {@link SkillCreateError} if the target directory already exists, or if
 * `register` is requested without a room that exists in config.
 */
export function scaffold(env: Environment, name: string, options: ScaffoldOptions = {}): ScaffoldResult {
  const register = options.register ?? false;
  const room = options.room ?? null;
  const description = options.description || `Skill for ${titleize(name)}`;

  if (register) {
    if (!room) throw new SkillCreateError("registration requires a --room");
    if (!(room in env.config.roomSkills)) {
      throw new SkillCreateError(`room '${room}' not found in config`);
    }
  }

  // Default workDir to env.dataDir (deterministic, not ambient cwd).
  // process.cwd() coupling caused order-dependent test flakiness: any test
  // that changed or deleted cwd broke every later test. The data dir is stable
  // per-environment and never deleted mid-suite.
  const base = options.workDir
    ? resolvePath(options.workDir)
    : join(env.dataDir, "skills-in-progress");
  const skillDir = join(base, name);
  if (existsSync(skillDir)) {
    throw new SkillCreateError(`${skillDir} already exists`);
  }

  const tags = nameToTags(name);
  const category = inferCategory(name, description);
  const prompt = inferPrompt(description);

  mkdirSync(join(skillDir, "tests"), { recursive: true });
  mkdirSync(join(skillDir, "examples"), { recursive: true });

  const fileContents: Array<[string, string]> = [
    ["SKILL.md", skillTemplate(name, description, tags, category)],
    ["tests/test_scenario.md", testScenarioTemplate(name, prompt)],
    ["examples/basic_usage.md", basicUsageTemplate(name, prompt)],
    ["README.md", readmeTemplate(name, description, room ?? "(unassigned)")],
  ];
  const files: string[] = [];
  for (const [rel, content] of fileContents) {
    const path = join(skillDir, rel);
    writeFileSync(path, content);
    files.push(path);
  }

  let registered = false;
  if (register && room) {
    registerSkill(env, name, room, skillDir);
    registered = true;
  }

  return { skillDir, files, registered, room };
}

/** Copy a scaffolded skill into the pool, route it to a room, regenerate indexes. */
function registerSkill(env: Environment, name: string, room: string, sourceDir: string): void {
  const target = join(env.skillsDir, name);
  mkdirSync(env.skillsDir, { recursive: true });
  // cpSync with force overwrites; behavioral parity with the prototype's overwrite.
  cpSync(sourceDir, target, { recursive: true, force: true });
  addSkillToRoom(env, name, room);
  // Re-read config so the freshly-routed skill is in-memory before indexing.
  generateRoomIndexes(reloadEnv(env));
}

function titleize(name: string): string {
  return name
    .replace(/[-_]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}
