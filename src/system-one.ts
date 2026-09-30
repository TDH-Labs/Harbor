/**
 * system-one.ts — Client-side contract with the System One router daemon.
 *
 * System One is a small, non-generative classifier service that lives OUTSIDE
 * this repository (Harbor ships the client, the trust boundary, and a service
 * unit generator — see service.ts — not the daemon). Harbor asks it which of a
 * room's skills a turn needs and treats the answer as ADVICE:
 *
 *   - The daemon is untrusted input. Skill names it returns are intersected
 *     with the room's own skills by the caller (skills.ts); it can never widen
 *     what a room may load.
 *   - It is optional. Any failure — unreachable, slow, malformed, refused —
 *     degrades to deterministic keyword matching, never to an error.
 *   - It has a reserved-port guard. The default endpoint is 127.0.0.1:8150;
 *     port 8000 is reserved for an unrelated local daemon, so an endpoint on a
 *     reserved port is refused rather than sent someone's prompt. Redirects are
 *     refused too, so a daemon cannot bounce Harbor onto a reserved port.
 *
 * Wire shape (tolerant reader): `POST <base>/v1/route-skills` with
 * `{ prompt, room, availableSkills: [{ name, description, recommendedTools }] }`.
 * The answer's keys are accepted in camelCase or snake_case; see
 * {@link parseRouteSkillsResponse}. The daemon's separate `/v1/decide`
 * (room / model-tier classification) is NOT called from Harbor: its contract is
 * defined by the daemon, which this repository does not contain.
 */

/** Default System One base URL. */
export const SYSTEM_ONE_DEFAULT_URL = "http://127.0.0.1:8150";
export const ROUTE_SKILLS_PATH = "/v1/route-skills";

/** Ports Harbor will never send a prompt to (override: HARBOR_SYSTEM_ONE_RESERVED_PORTS). */
export const DEFAULT_RESERVED_PORTS: readonly number[] = [8000];

/** The turn must not wait on the router longer than this (ms). */
export const DEFAULT_TIMEOUT_MS = 45;

/** A router answer larger than this is treated as hostile and discarded. */
export const MAX_RESPONSE_BYTES = 256 * 1024;

/** Turn text sent to the router is truncated to this many characters. */
export const MAX_PROMPT_CHARS = 8000;

type ProcEnv = Record<string, string | undefined>;

export interface EndpointOptions {
  /** Full route-skills URL, or a base URL (the path is appended). Wins over everything. */
  endpoint?: string;
  /** Base URL from config (`[system_one] url`). Lowest precedence before the default. */
  configUrl?: string;
  reservedPorts?: readonly number[];
}

export type EndpointResolution = { ok: true; endpoint: string } | { ok: false; reason: string };

function parseReservedPorts(raw: string | undefined): number[] | null {
  if (raw === undefined) return null;
  const ports = raw
    .split(",")
    .map((p) => Number.parseInt(p.trim(), 10))
    .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  return ports;
}

function withRoutePath(url: URL): string {
  if (url.pathname === "" || url.pathname === "/") url.pathname = ROUTE_SKILLS_PATH;
  return url.toString();
}

/**
 * Resolve where to send route-skills requests. Precedence: `options.endpoint`,
 * `HARBOR_ROUTE_SKILLS_ENDPOINT` (legacy, full URL), `HARBOR_SYSTEM_ONE_URL`,
 * `options.configUrl`, then {@link SYSTEM_ONE_DEFAULT_URL}. The result is
 * refused (never silently rewritten) when the URL is malformed, not http(s), or
 * on a reserved port.
 */
export function resolveRouteSkillsEndpoint(
  options: EndpointOptions = {},
  procEnv: ProcEnv = process.env,
): EndpointResolution {
  const raw =
    options.endpoint ||
    procEnv.HARBOR_ROUTE_SKILLS_ENDPOINT ||
    procEnv.HARBOR_SYSTEM_ONE_URL ||
    options.configUrl ||
    SYSTEM_ONE_DEFAULT_URL;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `System One URL is not a valid URL: ${JSON.stringify(raw)}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `System One URL must be http(s), got '${url.protocol}'` };
  }
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const reserved =
    options.reservedPorts ??
    parseReservedPorts(procEnv.HARBOR_SYSTEM_ONE_RESERVED_PORTS) ??
    DEFAULT_RESERVED_PORTS;
  if (reserved.includes(port)) {
    return {
      ok: false,
      reason:
        `System One endpoint is on reserved port ${port}; refusing to send turn text there ` +
        `(default is ${SYSTEM_ONE_DEFAULT_URL}; reserved list: HARBOR_SYSTEM_ONE_RESERVED_PORTS)`,
    };
  }
  return { ok: true, endpoint: withRoutePath(url) };
}

/** What the daemon claimed, before Harbor validates any of it. */
export interface RouteSkillsAnswer {
  skills: string[];
  tools: string[];
  /** The classifier flagged the turn as spanning domains (drives the 3 → 5 escalation). */
  crossDomain: boolean;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : [];
}

/**
 * Tolerant reader for the daemon's JSON. Accepts `selectedSkills` /
 * `selected_skills` / `skills`, likewise for tools, and `crossDomain` /
 * `cross_domain`. Returns null for anything that is not a JSON object.
 */
export function parseRouteSkillsResponse(data: unknown): RouteSkillsAnswer | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  return {
    skills: strings(d.selectedSkills ?? d.selected_skills ?? d.skills),
    tools: strings(d.selectedTools ?? d.selected_tools ?? d.tools),
    crossDomain: (d.crossDomain ?? d.cross_domain) === true,
  };
}

/** Read a response body, refusing more than `max` bytes (no unbounded buffering). */
async function readCapped(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export interface RouteRequest {
  prompt: string;
  room: string;
  availableSkills: Array<{ name: string; description: string; recommendedTools?: string[] | undefined }>;
}

export type RouteOutcome =
  | { ok: true; answer: RouteSkillsAnswer }
  | { ok: false; reason: string };

/**
 * Ask System One. Never throws: every failure is an `{ ok: false, reason }` the
 * caller turns into a deterministic fallback.
 */
export async function requestRouteSkills(
  endpoint: string,
  body: RouteRequest,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<RouteOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, prompt: body.prompt.slice(0, MAX_PROMPT_CHARS) }),
      signal: controller.signal,
      redirect: "error",
    });
    if (!res.ok) return { ok: false, reason: `System One answered HTTP ${res.status}` };
    const text = await readCapped(res, MAX_RESPONSE_BYTES);
    if (text === null) return { ok: false, reason: "System One answer exceeded the size limit" };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, reason: "System One answered with invalid JSON" };
    }
    const answer = parseRouteSkillsResponse(json);
    if (!answer) return { ok: false, reason: "System One answered with an unexpected shape" };
    return { ok: true, answer };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return { ok: false, reason: aborted ? `System One timed out after ${timeoutMs}ms` : "System One unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
