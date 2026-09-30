#!/usr/bin/env bash
# End-to-end smoke test of Harbor Server against a REAL running server.
#
#   scripts/smoke.sh local     # runs `bun src/cli.ts serve` on a temp data dir
#   scripts/smoke.sh docker    # builds and runs docker-compose.yml under its own project name
#
# It exercises what the unit tests cannot: the actual process, the actual port, and
# (docker mode) the actual image — non-root user, read-only root filesystem, the
# read-only skills bind mount, and graceful shutdown. Exit 0 only if every check passed.
#
# `local` is run in CI-like conditions by the maintainers. `docker` was written
# WITHOUT a Docker daemon available and has not been run: treat its first run as the
# first verification of the image, and read failures accordingly.
set -uo pipefail

MODE="${1:-local}"
PORT="${HARBOR_SMOKE_PORT:-18787}"
cd "$(dirname "$0")/.."
ROOT="$PWD"
WORK="$(mktemp -d)"
PASS=0
FAIL=0
SERVER_PID=""
SKILL="harbor-smoke-skill"
PROJECT="harbor-smoke"

ok()   { PASS=$((PASS+1)); printf '  ok    %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL  %s\n' "$1"; }
check() { # check <description> <command...>: passes when the command succeeds
  local d="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi
}
contains() { grep -q -- "$2" <<<"$1"; }

case "$MODE" in
  local)
    DATA="$WORK/data"
    BASE="http://127.0.0.1:$PORT"
    CFG="$DATA/tenants/acme/.agent-env/config.toml"
    SRC="$WORK/skills/$SKILL"
    H() { bun "$ROOT/src/cli.ts" "$@" --data-dir "$DATA"; }
    HC() { bun "$ROOT/src/cli.ts" "$@"; }   # commands taking --config instead of --data-dir
    ;;
  docker)
    command -v docker >/dev/null || { echo "docker not found"; exit 2; }
    BASE="http://127.0.0.1:8787"
    CFG="/data/tenants/acme/.agent-env/config.toml"
    SRC="/skills/$SKILL"
    DC() { docker compose -p "$PROJECT" "$@"; }
    H() { DC exec -T harbor bun src/cli.ts "$@"; }
    HC() { DC exec -T harbor bun src/cli.ts "$@"; }
    ;;
  *) echo "usage: $0 local|docker" >&2; exit 2 ;;
esac

cleanup() {
  if [ "$MODE" = "local" ] && [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; fi
  if [ "$MODE" = "docker" ]; then DC down -v >/dev/null 2>&1; rm -rf "$ROOT/skills/$SKILL"; rmdir "$ROOT/skills" 2>/dev/null; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

skill_text() { printf -- '---\nname: %s\ndescription: A smoke-test skill\n---\n\n# %s\n\nSMOKE-BODY\n' "$SKILL" "$SKILL"; }

echo "== start ($MODE)"
if [ "$MODE" = "local" ]; then
  mkdir -p "$SRC"; skill_text > "$SRC/SKILL.md"
  HARBOR_SYSTEM_ONE_URL="http://127.0.0.1:59992" bun "$ROOT/src/cli.ts" serve --data-dir "$DATA" --host 127.0.0.1 --port "$PORT" >"$WORK/server.log" 2>&1 &
  SERVER_PID=$!
else
  mkdir -p "$ROOT/skills/$SKILL"; skill_text > "$ROOT/skills/$SKILL/SKILL.md"
  DC up -d --build || { echo "docker compose up failed"; exit 1; }
fi
for _ in $(seq 1 60); do
  curl -fsS "$BASE/healthz" >/dev/null 2>&1 && break
  sleep 0.5
done
check "liveness /healthz answers 200" curl -fsS "$BASE/healthz"
check "readiness /readyz answers 200" curl -fsS "$BASE/readyz"

echo "== provision (the documented quickstart)"
check "tenant create" H tenant create acme
check "room create" H tenant add-room acme --room legal
check "skill install" HC skill-install "$SRC" --room legal --config "$CFG"
check "label the skill internal" HC label set --skill "$SKILL" --tier internal --config "$CFG"
TOKEN="$(H token create --tenant acme --room legal --principal owner@example.com 2>/dev/null | tail -n1)"
CAPPED="$(H token create --tenant acme --room legal --max-sensitivity public --principal byo@example.com 2>/dev/null | tail -n1)"
DELEGATE="$(H token create --tenant acme --delegate 2>/dev/null | tail -n1)"
for t in "$TOKEN" "$CAPPED" "$DELEGATE"; do case "$t" in hbr_*) ok "token issued";; *) bad "token issued (got '${t:0:12}')";; esac; done
check "grant a person for the delegate" H principal grant kim@example.com --tenant acme --room legal --clearance internal

mcp() { # mcp <token> <session-or-empty> <json> [extra curl args...]
  local tok="$1" sid="$2" body="$3"; shift 3
  curl -sS -i -X POST "$BASE/mcp" -H 'content-type: application/json' -H "authorization: Bearer $tok" \
    ${sid:+-H "mcp-session-id: $sid"} "$@" -d "$body"
}
sid_of() { tr -d '\r' <<<"$1" | awk 'tolower($1)=="mcp-session-id:" {print $2}'; }
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
CALL() { printf '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"%s","arguments":%s}}' "$1" "$2"; }

echo "== authentication"
R="$(curl -sS -i -X POST "$BASE/mcp" -H 'content-type: application/json' -d "$INIT")"
contains "$R" "401" && ok "no token is refused (401)" || bad "no token is refused (401)"
R="$(mcp "hbr_000000000000_$(printf 'A%.0s' $(seq 1 43))" "" "$INIT")"
contains "$R" "401" && ok "a wrong token is refused (401)" || bad "a wrong token is refused (401)"

echo "== an ordinary token"
R="$(mcp "$TOKEN" "" "$INIT")"; SID="$(sid_of "$R")"
[ -n "$SID" ] && ok "initialize returns a session id" || bad "initialize returns a session id"
R="$(mcp "$TOKEN" "$SID" "$(CALL list_skills '{}')")"
contains "$R" "$SKILL" && ok "list_skills shows the skill" || bad "list_skills shows the skill"
R="$(mcp "$TOKEN" "$SID" "$(CALL read_skill "{\"skill_name\":\"$SKILL\"}")")"
contains "$R" "SMOKE-BODY" && ok "read_skill returns the content" || bad "read_skill returns the content"
R="$(mcp "$TOKEN" "$SID" "$(CALL read_skill '{"skill_name":"not-in-this-room"}')")"
contains "$R" '"isError":true' && ok "a skill outside the room is refused" || bad "a skill outside the room is refused"

echo "== a token with a sensitivity ceiling"
R="$(mcp "$CAPPED" "" "$INIT")"; CSID="$(sid_of "$R")"
[ -n "$CSID" ] && ok "the capped token opens a session" || bad "the capped token opens a session"
R="$(mcp "$CAPPED" "$CSID" "$(CALL list_skills '{}')")"
# absence proves nothing if the call itself failed, so require a 200 answer too
{ contains "$R" "200 OK" && ! contains "$R" "$SKILL"; } && ok "an internal skill is hidden from a public-ceiling token" || bad "an internal skill is hidden from a public-ceiling token"
R="$(mcp "$CAPPED" "$CSID" "$(CALL read_skill "{\"skill_name\":\"$SKILL\"}")")"
{ contains "$R" '"isError":true' && ! contains "$R" "SMOKE-BODY"; } && ok "and refused, with no content" || bad "and refused, with no content"

echo "== a delegate token acting for a person"
R="$(mcp "$DELEGATE" "" "$INIT")"
contains "$R" "400" && ok "no Harbor-On-Behalf-Of is refused (400)" || bad "no Harbor-On-Behalf-Of is refused (400)"
R="$(mcp "$DELEGATE" "" "$INIT" -H 'Harbor-On-Behalf-Of: nobody@example.com')"
contains "$R" "403" && ok "a person with no grant is refused (403)" || bad "a person with no grant is refused (403)"
R="$(mcp "$DELEGATE" "" "$INIT" -H 'Harbor-On-Behalf-Of: kim@example.com')"; DSID="$(sid_of "$R")"
[ -n "$DSID" ] && ok "a granted person opens a session" || bad "a granted person opens a session"
R="$(mcp "$DELEGATE" "$DSID" "$(CALL read_skill "{\"skill_name\":\"$SKILL\"}")" -H 'Harbor-On-Behalf-Of: kim@example.com')"
contains "$R" "SMOKE-BODY" && ok "and receives what their grant allows" || bad "and receives what their grant allows"
R="$(mcp "$TOKEN" "" "$INIT" -H 'Harbor-On-Behalf-Of: kim@example.com')"
contains "$R" "403" && ok "a non-delegate token cannot claim to act for anyone (403)" || bad "a non-delegate token cannot claim to act for anyone (403)"

if [ "$MODE" = "docker" ]; then
  echo "== the container"
  check "runs as a non-root user" bash -c "[ \"\$(docker compose -p $PROJECT exec -T harbor id -u | tr -d '\\r')\" != 0 ]"
  check "root filesystem is read-only" bash -c "! docker compose -p $PROJECT exec -T harbor sh -c 'touch /probe' 2>/dev/null"
  check "the skills mount is read-only" bash -c "! docker compose -p $PROJECT exec -T harbor sh -c 'touch /skills/probe' 2>/dev/null"
  check "the published port is loopback-only" bash -c "docker compose -p $PROJECT port harbor 8787 | grep -q '^127.0.0.1:'"
fi

echo "== graceful shutdown"
if [ "$MODE" = "local" ]; then
  kill -TERM "$SERVER_PID"
  wait "$SERVER_PID"; RC=$?
  SERVER_PID=""
  [ "$RC" = 0 ] && ok "SIGTERM drains and exits 0" || bad "SIGTERM drains and exits 0 (exit $RC)"
else
  START=$(date +%s); DC stop >/dev/null 2>&1; RC=$?; END=$(date +%s)
  [ "$RC" = 0 ] && [ $((END-START)) -lt 15 ] && ok "docker stop finishes inside the grace period" || bad "docker stop finishes inside the grace period"
fi

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" = 0 ]
