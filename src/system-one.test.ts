import { afterEach, describe, expect, test } from "bun:test";

import {
  DEFAULT_RESERVED_PORTS,
  MAX_PROMPT_CHARS,
  MAX_RESPONSE_BYTES,
  SYSTEM_ONE_DEFAULT_URL,
  parseRouteSkillsResponse,
  requestRouteSkills,
  resolveRouteSkillsEndpoint,
} from "./system-one.ts";

// `procEnv` is always passed explicitly: these tests never read the live process env.
const NO_ENV = {};

describe("resolveRouteSkillsEndpoint", () => {
  test("default is System One on 127.0.0.1:8150 — not the reserved 8000", () => {
    expect(SYSTEM_ONE_DEFAULT_URL).toBe("http://127.0.0.1:8150");
    expect(DEFAULT_RESERVED_PORTS).toContain(8000);
    expect(resolveRouteSkillsEndpoint({}, NO_ENV)).toEqual({
      ok: true,
      endpoint: "http://127.0.0.1:8150/v1/route-skills",
    });
  });

  test("a base URL gets the route path; a full URL is kept as given", () => {
    expect(resolveRouteSkillsEndpoint({}, { HARBOR_SYSTEM_ONE_URL: "http://10.0.0.5:9000" })).toEqual({
      ok: true,
      endpoint: "http://10.0.0.5:9000/v1/route-skills",
    });
    expect(
      resolveRouteSkillsEndpoint({ endpoint: "http://127.0.0.1:59999/custom/route" }, NO_ENV),
    ).toEqual({ ok: true, endpoint: "http://127.0.0.1:59999/custom/route" });
  });

  test("precedence: option > legacy env > new env > config > default", () => {
    const env = {
      HARBOR_ROUTE_SKILLS_ENDPOINT: "http://127.0.0.1:1111/v1/route-skills",
      HARBOR_SYSTEM_ONE_URL: "http://127.0.0.1:2222",
    };
    const at = (o: Parameters<typeof resolveRouteSkillsEndpoint>[0], e: Record<string, string>) => {
      const r = resolveRouteSkillsEndpoint(o, e);
      return r.ok ? r.endpoint : r.reason;
    };
    expect(at({ endpoint: "http://127.0.0.1:3333", configUrl: "http://127.0.0.1:4444" }, env)).toContain(":3333");
    expect(at({ configUrl: "http://127.0.0.1:4444" }, env)).toContain(":1111");
    expect(at({ configUrl: "http://127.0.0.1:4444" }, { HARBOR_SYSTEM_ONE_URL: "http://127.0.0.1:2222" })).toContain(
      ":2222",
    );
    expect(at({ configUrl: "http://127.0.0.1:4444" }, {})).toContain(":4444");
  });

  test("port 8000 is refused, explicit or implied by the URL", () => {
    for (const url of ["http://127.0.0.1:8000", "http://localhost:8000/v1/route-skills"]) {
      const r = resolveRouteSkillsEndpoint({ endpoint: url }, NO_ENV);
      expect(r.ok, url).toBe(false);
      expect(r.ok ? "" : r.reason).toContain("reserved port 8000");
    }
    // the legacy env var cannot be used to reach it either
    expect(resolveRouteSkillsEndpoint({}, { HARBOR_ROUTE_SKILLS_ENDPOINT: "http://127.0.0.1:8000/v1/route-skills" }).ok).toBe(
      false,
    );
  });

  test("the reserved list is configurable; an explicitly empty list allows everything", () => {
    const r = resolveRouteSkillsEndpoint(
      { endpoint: "http://127.0.0.1:8150" },
      { HARBOR_SYSTEM_ONE_RESERVED_PORTS: "8150, 9999" },
    );
    expect(r.ok).toBe(false);
    expect(resolveRouteSkillsEndpoint({ endpoint: "http://127.0.0.1:8000" }, { HARBOR_SYSTEM_ONE_RESERVED_PORTS: "" }).ok).toBe(
      true,
    );
    expect(resolveRouteSkillsEndpoint({ endpoint: "http://127.0.0.1:8000", reservedPorts: [] }, NO_ENV).ok).toBe(true);
  });

  test("implicit ports are checked (https → 443, http → 80)", () => {
    const r = resolveRouteSkillsEndpoint({ endpoint: "https://router.internal/" }, { HARBOR_SYSTEM_ONE_RESERVED_PORTS: "443" });
    expect(r.ok).toBe(false);
  });

  test("malformed and non-http(s) URLs are refused, not rewritten", () => {
    expect(resolveRouteSkillsEndpoint({ endpoint: "not a url" }, NO_ENV).ok).toBe(false);
    expect(resolveRouteSkillsEndpoint({ endpoint: "file:///etc/passwd" }, NO_ENV).ok).toBe(false);
    expect(resolveRouteSkillsEndpoint({ endpoint: "ftp://host/x" }, NO_ENV).ok).toBe(false);
  });
});

describe("parseRouteSkillsResponse", () => {
  test("accepts camelCase, snake_case, and the bare `skills`/`tools` keys", () => {
    expect(parseRouteSkillsResponse({ selectedSkills: ["a"], selectedTools: ["t"], crossDomain: true })).toEqual({
      skills: ["a"],
      tools: ["t"],
      crossDomain: true,
    });
    expect(parseRouteSkillsResponse({ selected_skills: ["a"], selected_tools: ["t"], cross_domain: true })).toEqual({
      skills: ["a"],
      tools: ["t"],
      crossDomain: true,
    });
    expect(parseRouteSkillsResponse({ skills: ["a"], tools: ["t"] })).toEqual({
      skills: ["a"],
      tools: ["t"],
      crossDomain: false,
    });
  });

  test("crossDomain must be exactly true — truthy strings and numbers do not escalate", () => {
    for (const v of ["true", 1, "yes", {}, [], null]) {
      expect(parseRouteSkillsResponse({ skills: [], crossDomain: v })?.crossDomain, JSON.stringify(v)).toBe(false);
    }
  });

  test("non-string and empty entries are filtered out", () => {
    expect(parseRouteSkillsResponse({ skills: ["a", 1, null, "", { x: 1 }, "b"] })?.skills).toEqual(["a", "b"]);
    expect(parseRouteSkillsResponse({ skills: "not-an-array" })?.skills).toEqual([]);
  });

  // Rows are wrapped: a bare `[]` row would be spread into ZERO arguments.
  test.each([[null], [undefined], [42], ["str"], [[]], [true]])("%j is not an answer", (v) => {
    expect(parseRouteSkillsResponse(v)).toBeNull();
  });
});

describe("requestRouteSkills", () => {
  const servers: Array<{ stop: (force?: boolean) => void }> = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.stop(true);
  });
  function serve(fetch: (req: Request) => Response | Promise<Response>) {
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch });
    servers.push(s);
    return `http://127.0.0.1:${s.port}/v1/route-skills`;
  }
  const req = { prompt: "hello", room: "legal", availableSkills: [{ name: "a", description: "d" }] };

  test("a good answer parses", async () => {
    const url = serve(() => Response.json({ selectedSkills: ["a"] }));
    const r = await requestRouteSkills(url, req, 500);
    expect(r).toEqual({ ok: true, answer: { skills: ["a"], tools: [], crossDomain: false } });
  });

  test("nothing listening → unreachable, never a throw", async () => {
    const r = await requestRouteSkills("http://127.0.0.1:59998/v1/route-skills", req, 200);
    expect(r).toEqual({ ok: false, reason: "System One unreachable" });
  });

  test("HTTP error, invalid JSON, and wrong shape each degrade with a reason", async () => {
    expect(await requestRouteSkills(serve(() => new Response("x", { status: 500 })), req, 500)).toEqual({
      ok: false,
      reason: "System One answered HTTP 500",
    });
    expect(await requestRouteSkills(serve(() => new Response("{nope")), req, 500)).toEqual({
      ok: false,
      reason: "System One answered with invalid JSON",
    });
    expect(await requestRouteSkills(serve(() => Response.json([1, 2])), req, 500)).toEqual({
      ok: false,
      reason: "System One answered with an unexpected shape",
    });
  });

  test("a slow daemon is abandoned at the timeout", async () => {
    const url = serve(async () => {
      await new Promise((r) => setTimeout(r, 300));
      return Response.json({ selectedSkills: ["a"] });
    });
    const started = Date.now();
    const r = await requestRouteSkills(url, req, 40);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(250);
  });

  test("an oversized body is refused on its declared length, without waiting for it", async () => {
    // A raw socket, because Bun's Response normalizes a lying Content-Length.
    const raw = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket) {
          socket.write(
            `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${MAX_RESPONSE_BYTES * 4}\r\n\r\n{`,
          );
          // …and never sends the rest.
        },
      },
    });
    servers.push({ stop: () => raw.stop(true) });
    const started = Date.now();
    const r = await requestRouteSkills(`http://127.0.0.1:${raw.port}/v1/route-skills`, req, 1000);
    expect(r).toEqual({ ok: false, reason: "System One answer exceeded the size limit" });
    expect(Date.now() - started).toBeLessThan(800); // refused on the header, not on the timeout
  });

  test("an oversized streamed body is cut off and refused", async () => {
    const url = serve(
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              const chunk = new Uint8Array(64 * 1024).fill(0x20);
              for (let i = 0; i < 8; i++) c.enqueue(chunk); // 512 KiB of whitespace
              c.close();
            },
          }),
        ),
    );
    const r = await requestRouteSkills(url, req, 1000);
    expect(r).toEqual({ ok: false, reason: "System One answer exceeded the size limit" });
  });

  test("a redirect is refused — a daemon cannot bounce Harbor onto another port", async () => {
    let hit = 0;
    const other = serve(() => {
      hit++;
      return Response.json({ selectedSkills: ["a"] });
    });
    const url = serve(() => Response.redirect(other, 302));
    const r = await requestRouteSkills(url, req, 500);
    expect(r.ok).toBe(false);
    expect(hit).toBe(0);
  });

  test("the prompt is truncated before it leaves the process", async () => {
    let seen = 0;
    const url = serve(async (r) => {
      seen = ((await r.json()) as { prompt: string }).prompt.length;
      return Response.json({ selectedSkills: [] });
    });
    await requestRouteSkills(url, { ...req, prompt: "x".repeat(MAX_PROMPT_CHARS * 3) }, 500);
    expect(seen).toBe(MAX_PROMPT_CHARS);
  });
});
