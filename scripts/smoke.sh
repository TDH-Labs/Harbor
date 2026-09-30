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
# `local` passes against a real `harbor serve` and FAILS when the room gate or the
# sensitivity gate is broken on purpose. `docker` was written WITHOUT a Docker daemon
# available and has never been run: treat its first run as the first verification of
# the image, and read failures accordingly. It builds an image tagged harbor-smoke:test
# (not the compose file's own tag), runs under the compose project name harbor-smoke,
# publishes 127.0.0.1:8787 (so stop anything already using it), and removes all three.
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
    SRC2="$WORK/skills/${SKILL}-other"
    H() { bun "$ROOT/src/cli.ts" "$@" --data-dir "$DATA"; }
    HC() { bun "$ROOT/src/cli.ts" "$@"; }   # commands taking --config instead of --data-dir
    ;;
  docker)
    command -v docker >/dev/null || { echo "docker not found"; exit 2; }
    BASE="http://127.0.0.1:8787"
    CFG="/data/tenants/acme/.agent-env/config.toml"
    SRC="/skills/$SKILL"
    SRC2="/skills/${SKILL}-other"
    printf 'services:\n  harbor:\n    image: harbor-smoke:test\n' > "$WORK/override.yml"
    DC() { docker compose -p "$PROJECT" -f "$ROOT/docker-compose.yml" -f "$WORK/override.yml" "$@"; }
    H() { DC exec -T harbor bun src/cli.ts "$@"; }
    HC() { DC exec -T harbor bun src/cli.ts "$@"; }
    ;;
  *) echo "usage: $0 local|docker" >&2; exit 2 ;;
esac

cleanup() {
  if [ "$MODE" = "local" ] && [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; fi
  if [ "$MODE" = "docker" ]; then
    DC down -v >/dev/null 2>&1
    docker image rm harbor-smoke:test >/dev/null 2>&1
    rm -rf "$ROOT/skills/$SKILL" "$ROOT/skills/${SKILL}-other"; rmdir "$ROOT/skills" 2>/dev/null
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

skill_text() { printf -- '---\nname: %s\ndescription: A smoke-test skill\n---\n\n# %s\n\n%s\n' "$1" "$1" "$2"; }

echo "== start ($MODE)"
if [ "$MODE" = "local" ]; then
  mkdir -p "$SRC" "$SRC2"; skill_text "$SKILL" SMOKE-BODY > "$SRC/SKILL.md"; skill_text "${SKILL}-other" OTHER-ROOM-BODY > "$SRC2/SKILL.md"
  HARBOR_SYSTEM_ONE_URL="http://127.0.0.1:59992" bun "$ROOT/src/cli.ts" serve --data-dir "$DATA" --host 127.0.0.1 --port "$PORT" >"$WORK/server.log" 2>&1 &
  SERVER_PID=$!
else
  mkdir -p "$ROOT/skills/$SKILL" "$ROOT/skills/${SKILL}-other"
  skill_text "$SKILL" SMOKE-BODY > "$ROOT/skills/$SKILL/SKILL.md"; skill_text "${SKILL}-other" OTHER-ROOM-BODY > "$ROOT/skills/${SKILL}-other/SKILL.md"
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
check "second room create" H tenant add-room acme --room finance
check "skill install" HC skill-install "$SRC" --room legal --config "$CFG"
check "skill install into the other room" HC skill-install "$SRC2" --room finance --config "$CFG"
check "label the skill internal" HC label set --skill "$SKILL" --tier internal --config "$CFG"
TOKEN="$(H token create --tenant acme --room legal --principal owner@example.com 2>/dev/null | tail -n1)"
CAPPED="$(H token create --tenant acme --room legal --max-sensitivity public --principal byo@example.com 2>/dev/null | tail -n1)"
DELEGATE="$(H token create --tenant acme --delegate 2>/dev/null | tail -n1)"
OTHER="$(H token create --tenant acme --room finance --principal fin@example.com 2>/dev/null | tail -n1)"
for t in "$TOKEN" "$CAPPED" "$DELEGATE" "$OTHER"; do case "$t" in hbr_*) ok "token issued";; *) bad "token issued (got '${t:0:12}')";; esac; done
check "grant a person for the delegate" H principal grant kim@example.com --tenant acme --room legal --clearance internal

mcp() { # mcp <token> <session-or-empty> <json> [extra curl args...]
  local tok="$1" sid="$2" body="$3"; shift 3
  curl -sS -i -X POST "$BASE/mcp" -H 'content-type: application/json' -H "authorization: Bearer $tok" \
    ${sid:+-H "mcp-session-id: $sid"} "$@" -d "$body"
}
# The HTTP status of a `curl -i` response: the first line only, never a stray "401" in a body or header.
status_of() { head -n1 <<<"$1" | tr -d '\r' | awk '{print $2}'; }
expect_status() { # expect_status <description> <code> <response>
  [ "$(status_of "$3")" = "$2" ] && ok "$1" || bad "$1 (got HTTP $(status_of "$3"))"
}
sid_of() { tr -d '\r' <<<"$1" | awk 'tolower($1)=="mcp-session-id:" {print $2}'; }
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
CALL() { printf '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"%s","arguments":%s}}' "$1" "$2"; }

echo "== authentication"
R="$(curl -sS -i -X POST "$BASE/mcp" -H 'content-type: application/json' -d "$INIT")"
expect_status "no token is refused (401)" 401 "$R"
R="$(mcp "hbr_000000000000_$(printf 'A%.0s' $(seq 1 43))" "" "$INIT")"
expect_status "a wrong token is refused (401)" 401 "$R"

echo "== an ordinary token"
R="$(mcp "$TOKEN" "" "$INIT")"; SID="$(sid_of "$R")"
[ -n "$SID" ] && ok "initialize returns a session id" || bad "initialize returns a session id"
R="$(mcp "$TOKEN" "$SID" "$(CALL list_skills '{}')")"
contains "$R" "$SKILL" && ok "list_skills shows the skill" || bad "list_skills shows the skill"
R="$(mcp "$TOKEN" "$SID" "$(CALL read_skill "{\"skill_name\":\"$SKILL\"}")")"
contains "$R" "SMOKE-BODY" && ok "read_skill returns the content" || bad "read_skill returns the content"
# A REAL skill that lives in another room. (A name that does not exist is refused whether or
# not the room gate works, so it proves nothing.) The positive control shows it is readable
# from its own room, so the refusal below is the gate and not a missing file.
OSID="$(sid_of "$(mcp "$OTHER" "" "$INIT")")"
R="$(mcp "$OTHER" "$OSID" "$(CALL read_skill "{\"skill_name\":\"${SKILL}-other\"}")")"
contains "$R" "OTHER-ROOM-BODY" && ok "control: the other room's own token reads its skill" || bad "control: the other room's own token reads its skill"
R="$(mcp "$TOKEN" "$SID" "$(CALL read_skill "{\"skill_name\":\"${SKILL}-other\"}")")"
{ contains "$R" '"isError":true' && ! contains "$R" "OTHER-ROOM-BODY"; } && ok "a real skill in another room is refused, with no content" || bad "a real skill in another room is refused, with no content"

echo "== a token with a sensitivity ceiling"
R="$(mcp "$CAPPED" "" "$INIT")"; CSID="$(sid_of "$R")"
[ -n "$CSID" ] && ok "the capped token opens a session" || bad "the capped token opens a session"
R="$(mcp "$CAPPED" "$CSID" "$(CALL list_skills '{}')")"
# absence proves nothing if the call itself failed, so require a 200 answer too
{ [ "$(status_of "$R")" = 200 ] && ! contains "$R" "$SKILL"; } && ok "an internal skill is hidden from a public-ceiling token" || bad "an internal skill is hidden from a public-ceiling token"
R="$(mcp "$CAPPED" "$CSID" "$(CALL read_skill "{\"skill_name\":\"$SKILL\"}")")"
{ contains "$R" '"isError":true' && ! contains "$R" "SMOKE-BODY"; } && ok "and refused, with no content" || bad "and refused, with no content"

echo "== a delegate token acting for a person"
R="$(mcp "$DELEGATE" "" "$INIT")"
expect_status "no Harbor-On-Behalf-Of is refused (400)" 400 "$R"
R="$(mcp "$DELEGATE" "" "$INIT" -H 'Harbor-On-Behalf-Of: nobody@example.com')"
expect_status "a person with no grant is refused (403)" 403 "$R"
R="$(mcp "$DELEGATE" "" "$INIT" -H 'Harbor-On-Behalf-Of: kim@example.com')"; DSID="$(sid_of "$R")"
[ -n "$DSID" ] && ok "a granted person opens a session" || bad "a granted person opens a session"
R="$(mcp "$DELEGATE" "$DSID" "$(CALL read_skill "{\"skill_name\":\"$SKILL\"}")" -H 'Harbor-On-Behalf-Of: kim@example.com')"
contains "$R" "SMOKE-BODY" && ok "and receives what their grant allows" || bad "and receives what their grant allows"
R="$(mcp "$TOKEN" "" "$INIT" -H 'Harbor-On-Behalf-Of: kim@example.com')"
expect_status "a non-delegate token cannot claim to act for anyone (403)" 403 "$R"

if [ "$MODE" = "docker" ]; then
  echo "== the container"
  # Every check requires the command to RUN (a failed `exec` must not read as "denied").
  UID_IN="$(DC exec -T harbor id -u 2>/dev/null | tr -d '\r')"
  [ -n "$UID_IN" ] && [ "$UID_IN" != 0 ] && ok "runs as a non-root user (uid $UID_IN)" || bad "runs as a non-root user (got '${UID_IN}')"
  DC exec -T harbor sh -c 'touch /tmp/.probe && touch /data/.probe && rm -f /tmp/.probe /data/.probe' >/dev/null 2>&1 \
    && ok "control: /tmp (tmpfs) and /data (volume) are writable" || bad "control: /tmp (tmpfs) and /data (volume) are writable"
  OUT="$(DC exec -T harbor sh -c 'touch /home/bun/.probe' 2>&1)"
  contains "$OUT" "Read-only file system" && ok "the root filesystem is read-only" || bad "the root filesystem is read-only (got: ${OUT:0:80})"
  OUT="$(DC exec -T harbor sh -c "touch /skills/.probe" 2>&1)"
  contains "$OUT" "Read-only file system" && ok "the skills mount is read-only" || bad "the skills mount is read-only (got: ${OUT:0:80})"
  PUB="$(DC port harbor 8787 2>/dev/null)"
  case "$PUB" in 127.0.0.1:*) ok "the published port is loopback-only ($PUB)";; *) bad "the published port is loopback-only (got '$PUB')";; esac
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
