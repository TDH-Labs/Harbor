/**
 * delegate-client.ts — How a house agent (Son of Anton) talks to Harbor Server
 * FOR a person, without being able to name the wrong one by accident.
 *
 * Harbor bounds a delegate token to the named person's grant, but it cannot tell
 * whether the house agent named the right person (see docs/CLOUD.md). That part is
 * the agent's job, and this client is built so the easy mistakes are not possible:
 *
 *   - There is no way to say "act for <string>". A person is reached only through a
 *     {@link VerifiedIdentity}, which a channel adapter creates AFTER its platform
 *     has authenticated the human (a signed-in chat account, SSO) — never from the
 *     text of a message or a file. Plain objects that merely look like one are
 *     refused at runtime.
 *   - An identity is mapped to a Harbor person by an operator-maintained
 *     {@link IdentityMap}. An identity with no entry is refused; there is no
 *     default person and no fallback.
 *   - Each person gets their own MCP session; a session is never shared between
 *     people and the person cannot be changed once it exists.
 *   - The delegate token is only ever sent to Harbor, and never appears in an
 *     error, a log line or a JSON dump.
 *
 * It does not authenticate anyone. That is the channel adapter's job, and getting
 * it wrong is the one thing Harbor cannot catch.
 */

/** Same shape Harbor accepts for a person. Keeps a CR/LF out of the header. */
const PERSON_RE = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/;
const SESSION_HEADER = "mcp-session-id";
export const ON_BEHALF_OF_HEADER = "Harbor-On-Behalf-Of";
const PROTOCOL_VERSION = "2025-06-18";

// ── errors ───────────────────────────────────────────────────────────────────

export class DelegateError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = new.target.name;
    this.status = status;
  }
}
/** The delegate token itself was refused (revoked, expired, unknown). Nobody can be served. */
export class DelegateAuthError extends DelegateError {}
/** Harbor will not act for this person: no grant, suspended, or unknown. Deliberately not more specific. */
export class DelegateForbiddenError extends DelegateError {}
export class DelegateRateLimitedError extends DelegateError {
  readonly retryAfterSeconds: number | undefined;
  constructor(message: string, retryAfterSeconds?: number) {
    super(message, 429);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
/** The channel identity has no entry in the identity map. Nothing was sent to Harbor. */
export class UnknownIdentityError extends DelegateError {}
/** Something that is not a {@link VerifiedIdentity} was offered as one. */
export class UnverifiedIdentityError extends DelegateError {}

// ── identities ───────────────────────────────────────────────────────────────

/** Every VerifiedIdentity ever issued. A look-alike object is not in here. */
const issued = new WeakSet<object>();

/**
 * A human a channel adapter has authenticated: `subject` is the platform's own
 * stable id for them (a Slack user id, an SSO `sub`), not a name they typed.
 */
export class VerifiedIdentity {
  readonly channel: string;
  readonly subject: string;
  private constructor(channel: string, subject: string) {
    this.channel = channel;
    this.subject = subject;
    issued.add(this);
    Object.freeze(this);
  }
  /**
   * Create one. Call this only from code that has just authenticated the request
   * through the channel's own mechanism (a verified signature, a validated session).
   * Never call it with a value taken from message text.
   */
  static authenticated(channel: string, subject: string): VerifiedIdentity {
    if (!channel || !subject || /[\s:]/.test(channel)) throw new UnverifiedIdentityError("a channel and a subject are required");
    return new VerifiedIdentity(channel, subject);
  }
  get key(): string {
    return `${this.channel}:${this.subject}`;
  }
}

function assertVerified(v: unknown): asserts v is VerifiedIdentity {
  if (typeof v !== "object" || v === null || !issued.has(v)) {
    throw new UnverifiedIdentityError(
      "not a VerifiedIdentity: obtain one from VerifiedIdentity.authenticated() in a channel adapter that has authenticated the human",
    );
  }
}

/**
 * Which Harbor person each authenticated channel identity is. Maintained by the
 * operator (a file, a table). Unlisted identities are refused.
 */
export class IdentityMap {
  private readonly byKey = new Map<string, string>();

  /** `entries`: `["slack:U024BE7LH", "kim@example.com"]`, one per channel identity. */
  constructor(entries: Iterable<readonly [string, string]>) {
    for (const [key, person] of entries) {
      if (!PERSON_RE.test(person)) throw new DelegateError(`invalid person for '${key}': ${JSON.stringify(person)}`);
      if (!/^[^\s:]+:.+$/.test(key)) throw new DelegateError(`identity keys look like 'channel:subject'; got ${JSON.stringify(key)}`);
      if (this.byKey.has(key)) throw new DelegateError(`identity '${key}' is mapped twice`);
      this.byKey.set(key, person);
    }
  }

  resolve(identity: VerifiedIdentity): string | null {
    assertVerified(identity);
    return this.byKey.get(identity.key) ?? null;
  }
}

// ── the client ───────────────────────────────────────────────────────────────

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface DelegateClientOptions {
  /** Harbor Server's MCP endpoint, e.g. `https://harbor.example.com/mcp`. */
  endpoint: string;
  /** The delegate token (`harbor token create --delegate`). Keep it out of logs. */
  token: string;
  identities: IdentityMap;
  /** Override `fetch` (tests, proxies). */
  fetch?: FetchLike;
}

export interface ToolOutput {
  text: string;
  isError: boolean;
}

interface JsonRpcResult {
  result?: { content?: Array<{ text?: string }>; isError?: boolean; tools?: unknown[] };
  error?: { message?: string };
}

/** One person's conversation with Harbor. Obtain it from {@link DelegateClient.forIdentity}. */
export class PersonSession {
  readonly person: string;
  private readonly client: DelegateClient;
  private sessionId: string | null = null;
  private opening: Promise<string> | null = null;
  private nextId = 1;

  /** @internal */
  constructor(client: DelegateClient, person: string) {
    this.client = client;
    this.person = person;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolOutput> {
    const r = await this.rpc("tools/call", { name, arguments: args });
    return {
      text: (r.result?.content ?? []).map((c) => c.text ?? "").join("\n"),
      isError: Boolean(r.result?.isError),
    };
  }

  async listTools(): Promise<unknown[]> {
    return (await this.rpc("tools/list", {})).result?.tools ?? [];
  }

  /** End the session at Harbor. The next call opens a fresh one. */
  async close(): Promise<void> {
    const sid = this.sessionId;
    this.sessionId = null;
    this.opening = null;
    if (sid === null) return;
    await this.client.send(this.person, { method: "DELETE", sessionId: sid }).catch(() => undefined);
  }

  private async rpc(method: string, params: unknown, retried = false): Promise<JsonRpcResult> {
    const sid = await this.ensureSession();
    const res = await this.client.send(this.person, {
      method: "POST",
      sessionId: sid,
      body: { jsonrpc: "2.0", id: this.nextId++, method, params },
    });
    // 404 = Harbor no longer knows this session (idle expiry, or the person's grant
    // changed room or clearance). It was refused before dispatch, so re-opening and
    // retrying once cannot repeat an effect.
    if (res.status === 404 && !retried) {
      void res.body?.cancel();
      // Forget the session only if it is still the one that just failed. Concurrent
      // calls all hit the same 404; the first resets and re-opens, and the rest must
      // join that one new session instead of each opening (and orphaning) their own.
      if (this.sessionId === sid) {
        this.sessionId = null;
        this.opening = null;
      }
      return this.rpc(method, params, true);
    }
    await DelegateClient.expectOk(res);
    const parsed = (await res.json().catch(() => null)) as JsonRpcResult | null;
    if (parsed === null) throw new DelegateError("Harbor returned a body that is not JSON", res.status);
    if (parsed.error) throw new DelegateError(`Harbor error: ${parsed.error.message ?? "unknown"}`, res.status);
    return parsed;
  }

  private ensureSession(): Promise<string> {
    if (this.sessionId !== null) return Promise.resolve(this.sessionId);
    // Concurrent first calls share one initialize instead of opening several sessions.
    this.opening ??= this.open().then(
      (sid) => {
        this.sessionId = sid;
        return sid;
      },
      (err) => {
        this.opening = null;
        throw err;
      },
    );
    return this.opening;
  }

  private async open(): Promise<string> {
    const res = await this.client.send(this.person, {
      method: "POST",
      body: {
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "initialize",
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "harbor-delegate-client", version: "1" } },
      },
    });
    await DelegateClient.expectOk(res);
    const sid = res.headers.get(SESSION_HEADER);
    if (!sid) throw new DelegateError("Harbor did not return a session id", res.status);
    await this.client
      .send(this.person, { method: "POST", sessionId: sid, body: { jsonrpc: "2.0", method: "notifications/initialized" } })
      .catch(() => undefined);
    return sid;
  }
}

export class DelegateClient {
  private readonly sessions = new Map<string, PersonSession>();
  private readonly endpoint: string;
  private readonly identities: IdentityMap;
  private readonly doFetch: FetchLike;
  // Not enumerable and not a plain property, so a stray JSON.stringify(client) or
  // console.log(client) cannot print the credential.
  readonly #token: string;

  constructor(options: DelegateClientOptions) {
    if (!options.token) throw new DelegateError("a delegate token is required");
    this.endpoint = options.endpoint;
    this.identities = options.identities;
    this.#token = options.token;
    this.doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  toJSON(): { endpoint: string } {
    return { endpoint: this.endpoint };
  }

  /**
   * The session for the person behind an authenticated channel identity. Throws
   * {@link UnverifiedIdentityError} for anything that is not a real
   * {@link VerifiedIdentity} and {@link UnknownIdentityError} when the identity is
   * not in the map — in both cases without contacting Harbor.
   */
  forIdentity(identity: VerifiedIdentity): PersonSession {
    assertVerified(identity);
    const person = this.identities.resolve(identity);
    if (person === null) throw new UnknownIdentityError(`no Harbor person is mapped to ${identity.key}`);
    let s = this.sessions.get(person);
    if (!s) {
      s = new PersonSession(this, person);
      this.sessions.set(person, s);
    }
    return s;
  }

  /** @internal — sends one request as `person`; the header is set here and nowhere else. */
  async send(
    person: string,
    req: { method: "POST" | "DELETE"; sessionId?: string; body?: unknown },
  ): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#token}`,
      [ON_BEHALF_OF_HEADER]: person,
      "mcp-protocol-version": PROTOCOL_VERSION,
    };
    if (req.body !== undefined) headers["content-type"] = "application/json";
    if (req.sessionId) headers[SESSION_HEADER] = req.sessionId;
    return this.doFetch(this.endpoint, {
      method: req.method,
      headers,
      ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
      redirect: "error", // a redirect would carry the bearer token to another host
    });
  }

  /** @internal */
  static async expectOk(res: Response): Promise<void> {
    if (res.ok) return;
    void res.body?.cancel();
    switch (res.status) {
      case 401:
        throw new DelegateAuthError("Harbor refused the delegate token", 401);
      case 403:
        throw new DelegateForbiddenError("Harbor will not act for this person", 403);
      case 429: {
        const after = Number(res.headers.get("retry-after"));
        throw new DelegateRateLimitedError("rate limited by Harbor", Number.isFinite(after) && after > 0 ? after : undefined);
      }
      default:
        throw new DelegateError(`Harbor returned HTTP ${res.status}`, res.status);
    }
  }
}
