#!/usr/bin/env python3
"""
beacon_watcher.py — Watch the map + skills/Obsidian trees and regenerate beacons
the moment anything changes, with a self-daemonizing background mode.

Backends
--------
fswatch is the sole watching backend (macOS + Linux). When fswatch is not on
``PATH`` the watcher falls back to a 5-second polling loop that compares content
hashes of the watched paths. There is no inotifywait path — fswatch already wraps
inotify on Linux and FSEvents on macOS. Watch paths and the cooldown come from
config (``[watch] paths`` / ``cooldown_seconds``).

Coalescing & the event-drop fix (decision #11)
----------------------------------------------
A naive cooldown drops any change that lands inside the cooldown window. This
watcher instead records such a change as *pending*: when the cooldown expires a
single coalesced sync fires, so a burst of edits — or one edit mid-cooldown — is
never silently lost. All of that decision logic lives in ``CooldownGate`` +
``watch_loop``, which take an injected clock and an abstract event source so they
can be unit-tested with no real time, files, or subprocesses.

Daemon mode
-----------
``--daemon`` double-forks, ``setsid``s, redirects stdout/stderr to the env's
state-dir log (``~/.agent-env/logs/watcher.log``), writes a pidfile
(``~/.agent-env/watcher.pid``), handles ``SIGTERM`` gracefully, and detects and
recovers a stale pidfile left by a crashed predecessor. ``start()`` / ``stop()``
manage that lifecycle and are the backend the Phase 4 CLI calls; the watcher is
also runnable directly:

    python -m agent_env.beacon_watcher                 # foreground, fswatch
    python -m agent_env.beacon_watcher --poll          # foreground, polling
    python -m agent_env.beacon_watcher --daemon        # detach into the background
    python -m agent_env.beacon_watcher --stop          # stop the running daemon
    python -m agent_env.beacon_watcher --status        # report daemon state
    python -m agent_env.beacon_watcher --config PATH   # use a specific config.toml

Running under a process supervisor (documented, never generated)
----------------------------------------------------------------
This package ships **no** launchd/systemd/supervisord artifact (the old
per-machine LaunchAgent plist is gone — the live machine migrates to
``agent-env start`` in Phase 4). The 6-hour full-sync cron remains the backstop
for discovery + hygiene; add it yourself with::

    0 */6 * * * agent-env sync

To keep the watcher alive across logout/reboot, wrap ``agent-env start`` (or
``python -m agent_env.beacon_watcher --daemon``) in whatever supervisor the host
already uses — for example:

* launchd (macOS): a LaunchAgent plist whose ``ProgramArguments`` invoke
  ``agent-env start`` with ``RunAtLoad``/``KeepAlive``.
* systemd (Linux): a ``Type=forking`` user service with
  ``PIDFile=%h/.agent-env/watcher.pid``, ``ExecStart=agent-env start``,
  ``ExecStop=agent-env stop``.
* supervisord: a ``[program:agent-env-watcher]`` block running the foreground
  ``python -m agent_env.beacon_watcher`` (no ``--daemon``; let supervisord own
  the process).

These are documentation only — the package never writes a supervisor unit.
"""
from __future__ import annotations

import hashlib
import os
import select
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

from agent_env import beacon_sync
from agent_env.environment import Environment, parse_config_arg

# Default polling cadence (the documented "5s polling fallback") and the maximum
# chunk a blocking wait will sleep before re-checking the stop flag.
POLL_INTERVAL = 5.0
STOP_CHECK = 0.1

# fswatch event classes we care about — any create/modify/delete/rename.
FSWATCH_EVENTS = [
    "Updated", "Created", "Removed", "Renamed", "MovedFrom", "MovedTo",
]

# Set by the SIGTERM/SIGINT handler; consulted by the daemon/foreground loops.
_STOP = threading.Event()
# The signal number recorded by the handler, logged by the loop after it wakes.
# Kept separate from the handler's work so the handler itself stays I/O-free.
_STOP_SIGNUM = None


def log(message):
    """Timestamped, line-buffered log line (goes to the daemon's watcher.log)."""
    print(f"[beacon_watcher] {time.strftime('%H:%M:%S')} {message}", flush=True)


# ── Sync trigger ────────────────────────────────────────────────────────────

def run_sync(env, reason="change detected"):
    """Regenerate beacons in-process (``beacon_sync.run_generate``, no subprocess).

    A failing sync must never take the watcher down, so every error is logged and
    swallowed — the next change (or the 6-hour cron) gets another chance.
    """
    log(f"triggering sync: {reason}")
    try:
        beacon_sync.run_generate(env)
        log("sync completed")
    except SystemExit as exc:
        log(f"sync exited: {exc}")
    except Exception as exc:  # noqa: BLE001 - watcher resilience is the point
        log(f"sync error: {exc}")


# ── Decision logic: cooldown / pending-flag state machine ───────────────────

class CooldownGate:
    """Cooldown + pending-flag state machine (decision #11), with an injected clock.

    Lifecycle, driven by :func:`watch_loop`:

    * ``on_event()`` — call when a filesystem event arrives. Returns ``True`` if a
      sync should fire *now* (no recent sync, or the cooldown has elapsed). If a
      sync ran within the cooldown window, the event is **not dropped**: the gate
      records it as ``pending`` and returns ``False``.
    * ``due()`` — call on every loop turn. Returns ``True`` exactly once when a
      pending event's cooldown has finally elapsed, so the coalesced sync fires.
    * ``seconds_until_due()`` — how long the loop should wait before a pending
      sync can run (lets the loop block precisely instead of busy-spinning).

    The clock is any zero-arg callable returning monotonic-ish seconds; tests
    inject a fake so cooldown behavior is verified without real time.
    """

    def __init__(self, cooldown, clock=time.monotonic):
        self.cooldown = float(cooldown)
        self.clock = clock
        self.last_sync = None  # None => never synced; the first event fires at once
        self.pending = False

    def on_event(self):
        now = self.clock()
        if self.last_sync is None or (now - self.last_sync) >= self.cooldown:
            self.last_sync = now
            self.pending = False
            return True
        # Within cooldown — coalesce into a single deferred sync (never dropped).
        self.pending = True
        return False

    def due(self):
        if not self.pending:
            return False
        now = self.clock()
        if (now - self.last_sync) >= self.cooldown:
            self.last_sync = now
            self.pending = False
            return True
        return False

    def seconds_until_due(self):
        if not self.pending or self.last_sync is None:
            return 0.0
        return max(0.0, self.cooldown - (self.clock() - self.last_sync))


def watch_loop(source, gate, sync_fn, should_stop, base_wait=POLL_INTERVAL):
    """Drive ``gate`` from an event ``source`` until ``should_stop()`` is true.

    Backend-agnostic: ``source`` only needs ``wait(timeout) -> bool`` (did an
    event arrive within ``timeout``?). This is the unit-testable core — inject a
    scripted source + a fake-clock gate and assert exactly when ``sync_fn`` runs,
    including the event-drop fix (event mid-cooldown → one sync after it expires).

    Returns the number of syncs fired (handy for assertions).
    """
    syncs = 0
    while not should_stop():
        wait = base_wait if not gate.pending else gate.seconds_until_due()
        got_event = source.wait(wait)
        if got_event and gate.on_event():
            sync_fn(reason="change detected")
            syncs += 1
        elif gate.due():
            sync_fn(reason="coalesced change after cooldown")
            syncs += 1
    return syncs


# ── Decision logic: backend selection ───────────────────────────────────────

_AUTODETECT = object()  # sentinel: resolve fswatch via PATH (vs. an explicit value)


def select_backend(force_poll=False, fswatch_path=_AUTODETECT):
    """Choose the watch backend: ``"fswatch"`` when available, else ``"polling"``.

    ``force_poll`` (the ``--poll`` flag) always selects polling. ``fswatch_path``
    is injectable for tests: leave it unset to resolve via ``shutil.which``, or
    pass an explicit path (present) or ``None``/``""`` (absent).
    """
    if force_poll:
        return "polling"
    if fswatch_path is _AUTODETECT:
        fswatch_path = shutil.which("fswatch")
    return "fswatch" if fswatch_path else "polling"


# ── Decision logic: change detection for the polling fallback ───────────────

def _hash_file(path):
    try:
        return hashlib.md5(Path(path).read_bytes()).hexdigest()
    except OSError:
        return ""


def compute_watch_hashes(env, paths=None):
    """Map ``watched-file -> content-hash`` across the configured watch paths.

    Pure (same filesystem in, same map out): the polling fallback compares two
    successive snapshots to decide whether anything changed. A watch path that is
    a file is hashed directly; a directory contributes a hash per regular file
    beneath it.
    """
    if paths is None:
        paths = env.watch_paths()
    hashes = {}
    for raw in paths:
        p = Path(raw)
        if p.is_file():
            hashes[str(p)] = _hash_file(p)
        elif p.is_dir():
            for f in sorted(p.rglob("*")):
                if f.is_file():
                    hashes[str(f)] = _hash_file(f)
    return hashes


# ── Decision logic: pidfile lifecycle ───────────────────────────────────────

def process_alive(pid):
    """Is ``pid`` a live process? Uses signal 0 (no signal actually delivered)."""
    if pid is None or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists, just owned by another user
    return True


def process_identity(pid):
    """A stable identity token for a *live* process, or ``None`` if it is not
    running (or cannot be inspected).

    The token combines the process's start time with its command line. A bare PID
    is not enough to trust: the kernel recycles PIDs, so after our daemon dies the
    number in the pidfile may belong to an unrelated process. By recording this
    token when we write the pidfile and re-deriving it on read, a recycled PID is
    detectable — the live process's token will not match what we stored — which is
    what stops :func:`start` from wedging on a foreign PID and :func:`stop` from
    signalling an innocent one.

    Linux reads ``/proc/<pid>`` (start time = ``stat`` field 22, command =
    ``cmdline``); macOS/BSD shells out to ``ps -p <pid> -o lstart= -o command=``.
    Both are stable for a process's lifetime and differ once the PID is reused.
    """
    if not process_alive(pid):
        return None
    proc_root = Path("/proc")
    if proc_root.is_dir():  # Linux: /proc is authoritative and cheap.
        return _identity_from_proc(proc_root, pid)
    try:  # macOS/BSD: ps. lstart is an absolute start time, command is argv.
        out = subprocess.run(
            ["ps", "-p", str(pid), "-o", "lstart=", "-o", "command="],
            capture_output=True, text=True, timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    token = " ".join(out.stdout.split())
    return token or None


def _identity_from_proc(proc_root, pid):
    """Parse a ``starttime|cmdline`` token from ``proc_root/<pid>`` (Linux), or
    ``None`` if the process is gone or its stat is unparseable. Split out from
    :func:`process_identity` so the Linux path is unit-testable against a fake
    /proc tree on any platform."""
    try:
        stat = (proc_root / str(pid) / "stat").read_text()
        # comm (field 2) is parenthesized and may itself contain spaces/parens;
        # split after the final ')' so offsets past it are reliable. starttime is
        # overall field 22 => index 19 of the remainder.
        starttime = stat.rsplit(")", 1)[1].split()[19]
        raw = (proc_root / str(pid) / "cmdline").read_bytes()
        cmd = raw.replace(b"\0", b" ").strip().decode("utf-8", "replace")
        return f"{starttime}|{cmd}"
    except (OSError, IndexError):
        return None


class PidFile:
    """Read/write/remove + liveness/identity checks for the daemon's pidfile.

    The pidfile stores the PID on line 1 and an optional identity token (see
    :func:`process_identity`) on line 2. ``is_running``/``is_stale`` compare that
    stored token against the *live* process so a recycled foreign PID reads as
    stale, not as our daemon. ``alive_fn`` and ``identity_fn`` are injectable so
    the lifecycle is unit-testable without real processes.
    """

    def __init__(self, path, alive_fn=process_alive, identity_fn=process_identity):
        self.path = Path(path)
        self._alive = alive_fn
        self._identity = identity_fn

    def read(self):
        """The stored PID, or ``None`` if the file is absent or not a positive int."""
        try:
            text = self.path.read_text()
        except (FileNotFoundError, NotADirectoryError, IsADirectoryError, OSError):
            return None
        first = text.split("\n", 1)[0].strip()
        try:
            pid = int(first)
        except ValueError:
            return None
        return pid if pid > 0 else None

    def read_identity(self):
        """The stored identity token, or ``None`` for a bare (legacy) or absent
        pidfile."""
        try:
            lines = self.path.read_text().splitlines()
        except (FileNotFoundError, NotADirectoryError, IsADirectoryError, OSError):
            return None
        if len(lines) < 2:
            return None
        return lines[1].strip() or None

    def write(self, pid, identity=None):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if identity is None:
            self.path.write_text(f"{pid}\n")
        else:
            self.path.write_text(f"{pid}\n{identity.replace(chr(10), ' ')}\n")

    def remove(self):
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass

    def is_running(self):
        """True only when the pidfile names *our* live daemon: the PID is alive
        and its identity matches what we recorded (or, for a legacy bare pidfile
        with no token, simply that the PID is alive)."""
        pid = self.read()
        if pid is None:
            return False
        stored = self.read_identity()
        if stored is None:
            return self._alive(pid)
        live = self._identity(pid)
        return live is not None and live == stored

    def is_stale(self):
        """True when the pidfile names a PID that is not our live daemon — dead
        (crash residue) or a recycled foreign PID whose identity no longer
        matches what we stored."""
        pid = self.read()
        if pid is None:
            return False
        stored = self.read_identity()
        if stored is None:
            return not self._alive(pid)
        live = self._identity(pid)
        return live is None or live != stored


def _recover_stale_pidfile(pidfile):
    """Delete a pidfile pointing at a dead process. Returns True if one was cleaned."""
    if pidfile.is_stale():
        log(f"recovering stale pidfile {pidfile.path} (pid {pidfile.read()} not running)")
        pidfile.remove()
        return True
    return False


# ── Process machinery: concrete event sources ───────────────────────────────

class FswatchEventSource:
    """``wait(timeout)`` over a long-lived fswatch process.

    A single streaming ``fswatch`` is kept running; ``wait`` selects on its stdout
    for up to ``timeout`` seconds (re-checking ``stop_event`` every ``STOP_CHECK``
    so SIGTERM is honored promptly) and drains a burst into one event.

    Fork-storm guard: a misconfigured or unsupported fswatch can exit the instant
    it is launched, and the naive ``return False`` on EOF let the loop respawn it
    immediately — ~350 forks/second. Each immediate death (process lived under
    ``FAST_DEATH_SECONDS``) now triggers an exponential backoff before the next
    respawn, and after ``MAX_FAST_DEATHS`` consecutive immediate deaths the source
    marks itself ``degraded`` so :func:`run_watch` falls back to the polling
    backend. A healthy run (fswatch lived long enough) resets the counter.
    ``sleep`` and ``clock`` are injectable so the backoff is unit-testable without
    real time.
    """

    FAST_DEATH_SECONDS = 1.0   # fswatch dying sooner than this is an "immediate" death
    MAX_FAST_DEATHS = 5        # consecutive immediate deaths before degrading
    BACKOFF_BASE = 0.1         # first backoff; doubles each subsequent immediate death
    BACKOFF_MAX = 2.0          # cap on a single backoff sleep

    def __init__(self, paths, fswatch_path="fswatch", stop_event=None,
                 sleep=time.sleep, clock=time.monotonic):
        self.paths = [str(p) for p in paths]
        self.fswatch_path = fswatch_path
        self._stop = stop_event
        self._sleep = sleep
        self._clock = clock
        self._proc = None
        self._spawn_at = None
        self._fast_deaths = 0
        self.degraded = False

    def _ensure_proc(self):
        if self._proc is not None and self._proc.poll() is None:
            return
        cmd = [self.fswatch_path, "--recursive"]
        for event in FSWATCH_EVENTS:
            cmd += ["--event", event]
        cmd += self.paths
        self._proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
        )
        self._spawn_at = self._clock()

    def _note_exit(self):
        """fswatch exited: throttle a rapid respawn, and degrade to polling if it
        keeps dying immediately (the fork-storm guard)."""
        lived = self._clock() - (self._spawn_at if self._spawn_at is not None
                                 else self._clock())
        if lived >= self.FAST_DEATH_SECONDS:
            self._fast_deaths = 0  # a healthy run resets the streak
            return
        self._fast_deaths += 1
        if self._fast_deaths >= self.MAX_FAST_DEATHS:
            self.degraded = True
            log(f"fswatch exited immediately {self._fast_deaths} times; "
                f"falling back to the polling backend")
            return
        backoff = min(self.BACKOFF_MAX,
                      self.BACKOFF_BASE * (2 ** (self._fast_deaths - 1)))
        log(f"fswatch exited after {lived:.3f}s (rapid death "
            f"{self._fast_deaths}/{self.MAX_FAST_DEATHS}); backing off {backoff:.2f}s")
        if self._stop is None or not self._stop.is_set():
            self._sleep(backoff)

    def _drain(self):
        # Swallow any immediately-available follow-up lines so a burst of edits
        # collapses into a single logical event (the gate coalesces the rest).
        while True:
            ready, _, _ = select.select([self._proc.stdout], [], [], 0)
            if not ready:
                return
            if self._proc.stdout.readline() == "":
                return

    def wait(self, timeout):
        if self.degraded:
            return False
        self._ensure_proc()
        deadline = self._clock() + max(0.0, timeout)
        while True:
            if self._stop is not None and self._stop.is_set():
                return False
            remaining = deadline - self._clock()
            if remaining <= 0:
                return False
            ready, _, _ = select.select(
                [self._proc.stdout], [], [], min(remaining, STOP_CHECK)
            )
            if ready:
                line = self._proc.stdout.readline()
                if line == "":  # fswatch exited — back off, then let wait respawn it
                    self._proc = None
                    self._note_exit()
                    return False
                self._drain()
                return True

    def close(self):
        if self._proc is not None and self._proc.poll() is None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self._proc.kill()
                self._proc.wait()
        self._proc = None


class PollingEventSource:
    """``wait(timeout)`` fallback: sleep, then diff content hashes of watch paths.

    Sleeps in ``STOP_CHECK`` chunks (honoring ``stop_event``) up to
    ``min(interval, timeout)``, then returns whether any watched file changed.
    """

    def __init__(self, env, interval=POLL_INTERVAL, stop_event=None, sleep=time.sleep):
        self.env = env
        self.interval = interval
        self._stop = stop_event
        self._sleep = sleep
        self._hashes = compute_watch_hashes(env)

    def wait(self, timeout):
        budget = min(self.interval, timeout) if timeout > 0 else 0.0
        slept = 0.0
        while slept < budget:
            if self._stop is not None and self._stop.is_set():
                return False
            chunk = min(STOP_CHECK, budget - slept)
            self._sleep(chunk)
            slept += chunk
        current = compute_watch_hashes(self.env)
        if current != self._hashes:
            self._hashes = current
            return True
        return False

    def close(self):
        pass


def run_watch(env, force_poll=False, stop_event=None):
    """Build the selected event source + cooldown gate and run :func:`watch_loop`.

    Returns the number of syncs fired. The source is always closed on exit so no
    fswatch child outlives the watcher.
    """
    if stop_event is None:
        stop_event = _STOP
    backend = select_backend(force_poll=force_poll)
    paths = env.watch_paths()
    log(f"watching {len(paths)} path(s) via {backend}: "
        f"{', '.join(str(p) for p in paths)}")
    if backend == "fswatch":
        source = FswatchEventSource(paths, stop_event=stop_event)
    else:
        source = PollingEventSource(env, stop_event=stop_event)
    gate = CooldownGate(env.config.watch_cooldown, clock=time.monotonic)

    def sync_fn(reason):
        run_sync(env, reason=reason)

    # Stop the loop on a real stop OR when the fswatch source degrades, so we can
    # hand off to polling without losing the (shared) cooldown gate's pending sync.
    def should_stop():
        return stop_event.is_set() or getattr(source, "degraded", False)

    try:
        syncs = watch_loop(source, gate, sync_fn, should_stop)
    finally:
        source.close()

    if getattr(source, "degraded", False) and not stop_event.is_set():
        log("fswatch backend degraded; continuing on the polling backend")
        poll_source = PollingEventSource(env, stop_event=stop_event)
        try:
            syncs += watch_loop(poll_source, gate, sync_fn, stop_event.is_set)
        finally:
            poll_source.close()
    # The loop has woken and exited; now safe to emit any signal the handler
    # recorded (kept out of the handler itself — see _handle_stop).
    _log_stop_signal()
    return syncs


# ── Process machinery: signals & daemonization ──────────────────────────────

def _handle_stop(signum, _frame):
    # Async-signal-safe: only record the signal number and set the flag. No I/O
    # (logging) here — print() inside a signal handler can deadlock if the signal
    # lands mid-write. The deferred line is emitted by _log_stop_signal() once the
    # loop has woken from its blocking wait.
    global _STOP_SIGNUM
    _STOP_SIGNUM = signum
    _STOP.set()


def _log_stop_signal():
    """Emit the deferred 'received signal' line outside the signal handler — called
    by the loop after it wakes — then clear the record so it logs at most once."""
    global _STOP_SIGNUM
    if _STOP_SIGNUM is not None:
        log(f"received signal {_STOP_SIGNUM}; stopping")
        _STOP_SIGNUM = None


def install_signal_handlers():
    """Route SIGTERM/SIGINT to a graceful stop of the watch loop."""
    signal.signal(signal.SIGTERM, _handle_stop)
    signal.signal(signal.SIGINT, _handle_stop)


def _claim_pidfile(pidfile, attempts=10, sleep=time.sleep, wait=0.02):
    """Atomically reserve the pidfile and return its open fd, or ``None`` if a
    concurrently-starting daemon won the race.

    Two ``start()`` calls used to both pass ``is_running()`` before either wrote
    the pidfile, so the second silently overwrote the first and orphaned it. The
    decisive arbiter here is ``O_CREAT | O_EXCL``: the create is atomic, so out of
    any number of racers exactly one succeeds and the rest get ``FileExistsError``.

    The winner gets the open fd, which is passed *through* the double-fork so the
    detached grandchild can write its own pid+identity into the already-reserved
    file — the recorded PID must be the long-lived daemon's, and the double-fork
    changes the PID, so a pre-fork write alone would record a PID that immediately
    dies. To keep the reserved file from ever looking empty (which would let a
    racing loser delete it), the winner stamps its *pre-fork* pid+identity into
    the fd immediately; the grandchild overwrites that via :func:`_finalize_claim`.

    A loser (``FileExistsError``) inspects the existing file: a live,
    identity-matched owner means we lost cleanly (return ``None``, caller must NOT
    daemonize); only genuinely stale/empty residue is cleared so the claim can be
    retried.
    """
    pidfile.path.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(attempts):
        try:
            fd = os.open(str(pidfile.path),
                         os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except FileExistsError:
            if pidfile.is_running():
                return None  # a live, identity-matched daemon owns it — we lose
            if attempt < attempts - 1:
                # Not (yet) running: stale residue, or a winner whose grandchild
                # has not finalized. Give the winner a beat; only steal the file
                # if it is still unclaimed afterwards.
                sleep(wait)
                if pidfile.is_running():
                    return None
                pidfile.remove()
            continue
        # Won the create. Stamp our pre-fork identity so the file is never empty.
        pid = os.getpid()
        os.write(fd, f"{pid}\n{process_identity(pid)}\n".encode())
        os.fsync(fd)
        return fd
    return None


def _finalize_claim(fd, pid, identity):
    """Overwrite a reserved pidfile (held open as ``fd``) with the daemon's real
    pid+identity, then close it. Called by the detached grandchild so the recorded
    PID is its own, not the transient pre-fork PID that claimed the file."""
    os.lseek(fd, 0, os.SEEK_SET)
    os.ftruncate(fd, 0)
    os.write(fd, f"{pid}\n{identity}\n".encode())
    os.fsync(fd)
    os.close(fd)


def daemonize(log_path, keep_fd=None):  # pragma: no cover - daemon smoke test only
    """Double-fork + setsid into the background; redirect std streams to ``log_path``.

    Returns only in the final detached grandchild; the invoking process and the
    intermediate child both ``os._exit(0)``. ``keep_fd`` (the reserved-pidfile fd
    from :func:`_claim_pidfile`) is inherited across both forks and is never one
    of the std-stream targets, so it survives to the grandchild untouched. Pure
    process machinery — it cannot run in-process without ending the test runner,
    so it is verified by spawning a real daemon in tests/test_beacon_watcher.py
    rather than by unit coverage.
    """
    log_path = Path(log_path)
    # First fork: detach from the invoking process group / shell.
    if os.fork() > 0:
        os._exit(0)
    os.setsid()
    # Second fork: guarantee we can never reacquire a controlling terminal.
    if os.fork() > 0:
        os._exit(0)
    os.chdir("/")
    os.umask(0o022)
    sys.stdout.flush()
    sys.stderr.flush()
    log_path.parent.mkdir(parents=True, exist_ok=True)
    devnull_fd = os.open(os.devnull, os.O_RDONLY)
    log_fd = os.open(str(log_path), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    os.dup2(devnull_fd, 0)
    os.dup2(log_fd, 1)
    os.dup2(log_fd, 2)
    # Only the std-stream fds are closed; keep_fd (always > 2) is left open so the
    # grandchild can finalize the pidfile through it.
    if devnull_fd > 2 and devnull_fd != keep_fd:
        os.close(devnull_fd)
    if log_fd > 2 and log_fd != keep_fd:
        os.close(log_fd)


def _serve(env, pidfile, force_poll, claim_fd=None):  # pragma: no cover - daemon only
    """Own the pidfile and run the watch loop until SIGTERM. Daemon-side only.

    ``claim_fd`` is the reserved-pidfile fd inherited from :func:`_claim_pidfile`;
    the grandchild finalizes it with its own pid+identity. (A ``None`` fd — only
    on a non-atomic code path — falls back to a plain write.)"""
    pid = os.getpid()
    identity = process_identity(pid)
    if claim_fd is not None:
        _finalize_claim(claim_fd, pid, identity)
    else:
        pidfile.write(pid, identity=identity)
    install_signal_handlers()
    _STOP.clear()
    log(f"watcher daemon started (pid {pid})")
    try:
        run_watch(env, force_poll=force_poll, stop_event=_STOP)
    finally:
        pidfile.remove()
        log("watcher daemon exited; pidfile removed")


def _run_as_daemon(env, force_poll=False):
    """``--daemon`` entry: refuse to double-start, atomically claim, then detach.

    The atomic claim happens *before* daemonizing so the loser of a concurrent
    start exits cleanly without forking a second daemon; the winner carries the
    open fd through the double-fork to the grandchild.
    """
    pidfile = PidFile(env.watcher_pidfile)
    if pidfile.is_running():
        log(f"watcher already running (pid {pidfile.read()}); not starting another")
        return 0
    _recover_stale_pidfile(pidfile)
    claim_fd = _claim_pidfile(pidfile)
    if claim_fd is None:
        log("watcher already being started by another process; not starting another")
        return 0
    daemonize(env.watcher_log, keep_fd=claim_fd)  # pragma: no cover - daemon only
    _serve(env, pidfile, force_poll, claim_fd=claim_fd)  # pragma: no cover
    return 0  # pragma: no cover


# ── Process machinery: start / stop lifecycle (Phase 4 CLI backend) ─────────

def _await_pidfile(pidfile, timeout=10.0, interval=0.05):
    """Wait for a freshly spawned daemon to write a live pidfile; return its PID."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pidfile.is_running():
            return pidfile.read()
        time.sleep(interval)
    return pidfile.read()


def start(env, force_poll=False, config_path=None):
    """Start the watcher as a detached daemon; return its PID.

    Idempotent: if a live watcher already owns the pidfile, returns that PID
    without spawning a second. A stale pidfile is recovered first. The daemon is
    a fresh ``python -m agent_env.beacon_watcher --daemon`` process so the caller
    (e.g. the Phase 4 CLI) keeps running.
    """
    pidfile = PidFile(env.watcher_pidfile)
    if pidfile.is_running():
        return pidfile.read()
    _recover_stale_pidfile(pidfile)
    if config_path is None:
        config_path = env.config_path
    cmd = [sys.executable, "-m", "agent_env.beacon_watcher", "--daemon"]
    if force_poll:
        cmd.append("--poll")
    if config_path is not None:
        cmd += ["--config", str(config_path)]
    proc = subprocess.Popen(
        cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, start_new_session=True,
    )
    # The immediate child double-forks then exits; reap it so it isn't a zombie.
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass
    return _await_pidfile(pidfile)


def stop(env, timeout=10.0):
    """Stop the running watcher: SIGTERM, await exit (SIGKILL on timeout), clean up.

    Returns True if a live watcher was signalled, False if none was running (any
    stale pidfile is removed either way). Refuses to signal a PID that fails the
    identity check — a dead PID, or one recycled by an unrelated process — so a
    crashed watcher never gets an innocent bystander killed in its place.
    """
    pidfile = PidFile(env.watcher_pidfile)
    if not pidfile.is_running():
        pidfile.remove()
        return False
    pid = pidfile.read()
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pidfile.remove()
        return False
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not process_alive(pid):
            break
        time.sleep(0.05)
    else:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    pidfile.remove()
    return True


def status(env):
    """Return the live watcher PID, or ``None`` if no watcher is running."""
    pidfile = PidFile(env.watcher_pidfile)
    return pidfile.read() if pidfile.is_running() else None


# ── Foreground / CLI entry ──────────────────────────────────────────────────

def run_foreground(env, force_poll=False):
    """Run the watch loop in the foreground (Ctrl-C / SIGTERM to stop)."""
    install_signal_handlers()
    _STOP.clear()
    log("starting watcher in foreground (Ctrl-C to stop)")
    try:
        run_watch(env, force_poll=force_poll, stop_event=_STOP)
    except KeyboardInterrupt:
        pass
    log("watcher stopped")


def main(argv=None):
    if argv is None:
        argv = sys.argv[1:]
    config_path, rest = parse_config_arg(argv)
    env = Environment.load(config_path)
    force_poll = "--poll" in rest

    if "--stop" in rest:
        print("stopped" if stop(env) else "no running watcher")
        return 0
    if "--status" in rest:
        pid = status(env)
        print(f"running (pid {pid})" if pid else "not running")
        return 0
    if "--daemon" in rest:
        return _run_as_daemon(env, force_poll=force_poll)

    run_foreground(env, force_poll=force_poll)
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
