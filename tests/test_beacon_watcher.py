"""Tests for beacon_watcher — the Phase 3 rewrite.

The watcher is split into decision logic (cooldown/pending-flag state machine,
event coalescing, backend selection, pidfile lifecycle, change detection) and
process machinery (fork/exec/signals, the fswatch + polling event sources). The
decision logic is unit-tested here with injected clocks and fake event sources —
no real time, no real subprocesses. Daemonization, which cannot run in-process
without ending the test runner, gets a smoke test that spawns a real daemon
against a tmp root and asserts pidfile + log + SIGTERM cleanup. Every spawned
process is killed in fixture teardown and asserted dead, so no orphan survives.
"""
from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from agent_env import beacon_watcher as bw
from agent_env.beacon_watcher import PidFile
from agent_env.environment import Environment

from tests.helpers import make_env


# ── Test doubles ────────────────────────────────────────────────────────────

class FakeClock:
    """A zero-arg callable clock the test advances by hand."""

    def __init__(self, start=1000.0):
        self.t = float(start)

    def __call__(self):
        return self.t

    def advance(self, dt):
        self.t += dt


class ScriptedSource:
    """An event source driven by a script of ``(advance_clock, returns_event)``.

    Each ``wait(timeout)`` advances the shared clock by the step's delta (modeling
    time spent blocking) and returns its event flag. Records every timeout it was
    asked to wait, so tests can assert the loop blocked for ``seconds_until_due``
    while a sync was pending.
    """

    def __init__(self, clock, steps):
        self.clock = clock
        self.steps = list(steps)
        self.waits = []
        self.closed = False

    def wait(self, timeout):
        self.waits.append(timeout)
        if not self.steps:
            return False
        dt, event = self.steps.pop(0)
        self.clock.advance(dt)
        return event

    def close(self):
        self.closed = True


def _counting_stopper(max_iterations):
    """A should_stop() predicate that returns True after ``max_iterations`` turns."""
    state = {"n": 0}

    def should_stop():
        state["n"] += 1
        return state["n"] > max_iterations

    return should_stop


def _dead_pid():
    """A PID guaranteed not to be running (spawn a trivial child, reap it)."""
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait()
    return proc.pid


def _spawn_sigterm_ignorer():
    """A child that ignores SIGTERM and sleeps — forces stop() to escalate to KILL."""
    code = ("import signal, time\n"
            "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
            "time.sleep(60)\n")
    return subprocess.Popen([sys.executable, "-c", code])


def _spawn_decoy():
    """A live, unrelated process (NOT a watcher) — stands in for the process that
    inherited a recycled PID. stop()/start() must never mistake it for the daemon."""
    return subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])


class _InstantDeadProc:
    """A fake Popen whose process exited the instant it launched: stdout sits at
    EOF and poll() is non-None. Stands in for a persistently-dying fswatch so the
    fork-storm guard can be tested without forking 350 real processes a second."""

    def __init__(self, *args, **kwargs):
        r, w = os.pipe()
        os.close(w)                       # closed write end => immediate EOF on read
        self.stdout = os.fdopen(r, "r")
        self.returncode = 0

    def poll(self):
        return 0                          # already exited

    def terminate(self):
        pass

    def kill(self):
        pass

    def wait(self, timeout=None):
        return 0


def _wait_for(predicate, timeout, interval=0.05):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


def _daemon_env(tmp_path, *, cooldown=1):
    """Write a config.toml rooted at *tmp_path* and load an Environment from it.

    Everything (state dir, pidfile, logs) resolves under tmp_path — the live
    ~/.agent-env is never touched. Returns ``(env, config_path_str)``; ``env``
    remembers the config path, so ``start(env)`` can re-pass it to the daemon.
    """
    cfg = tmp_path / "config.toml"
    home = str(tmp_path).replace("\\", "/")
    cfg.write_text(
        "[paths]\n"
        f'home = "{home}"\n'
        "[watch]\n"
        f'paths = ["{home}/agent_map.md"]\n'
        f"cooldown_seconds = {cooldown}\n"
    )
    (tmp_path / "agent_map.md").write_text("# map\n")
    env = Environment.load(str(cfg))
    return env, str(cfg)


@pytest.fixture
def spawned_pids():
    """Track daemon PIDs spawned by a test; SIGKILL any survivor in teardown.

    The post-yield block is the orphan guard: it kills every tracked PID and
    asserts it is dead, so a leaked watcher can never outlive the test.
    """
    pids = []
    yield pids

    def _reap(pid):
        # A SIGKILLed *direct* child lingers as a zombie (still "alive" to kill -0)
        # until reaped; daemonized grandchildren are reparented and aren't ours to
        # wait on (ChildProcessError) — tolerate both.
        try:
            os.waitpid(pid, os.WNOHANG)
        except (ChildProcessError, ProcessLookupError):
            pass

    for pid in pids:
        for _ in range(40):  # ~2s
            _reap(pid)
            if not bw.process_alive(pid):
                break
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                break
            time.sleep(0.05)
        _reap(pid)
        assert not bw.process_alive(pid), f"orphan watcher process {pid} survived teardown"


# ── Decision logic: CooldownGate ────────────────────────────────────────────

class TestCooldownGate:
    """The cooldown + pending-flag state machine (decision #11)."""

    def test_first_event_fires_immediately(self):
        gate = bw.CooldownGate(10, clock=FakeClock())
        assert gate.on_event() is True
        assert gate.pending is False

    def test_event_within_cooldown_is_pending_not_dropped(self):
        clock = FakeClock()
        gate = bw.CooldownGate(10, clock=clock)
        gate.on_event()             # fires at t=0, last_sync set
        clock.advance(3)            # 3s < 10s cooldown
        assert gate.on_event() is False   # does NOT fire...
        assert gate.pending is True       # ...but is remembered, not dropped

    def test_pending_fires_after_cooldown_expires(self):
        """The core event-drop fix: a change made during cooldown still syncs."""
        clock = FakeClock()
        gate = bw.CooldownGate(10, clock=clock)
        gate.on_event()             # t=0 fires
        clock.advance(3)
        gate.on_event()             # pending (within cooldown)
        assert gate.due() is False  # cooldown not yet elapsed
        clock.advance(7)            # now 10s since last_sync
        assert gate.due() is True   # the pending change fires
        assert gate.pending is False
        assert gate.due() is False  # ...and only once

    def test_multiple_events_coalesce_to_single_pending(self):
        clock = FakeClock()
        gate = bw.CooldownGate(10, clock=clock)
        gate.on_event()             # fires
        for delta in (1, 2, 3):     # a burst, all within cooldown
            clock.advance(delta)
            assert gate.on_event() is False
        clock.advance(10)
        assert gate.due() is True   # one coalesced sync for the whole burst
        assert gate.due() is False

    def test_event_after_cooldown_fires_again(self):
        clock = FakeClock()
        gate = bw.CooldownGate(5, clock=clock)
        assert gate.on_event() is True
        clock.advance(6)            # past cooldown
        assert gate.on_event() is True   # fires immediately, no pending

    def test_not_due_when_nothing_pending(self):
        gate = bw.CooldownGate(10, clock=FakeClock())
        assert gate.due() is False
        assert gate.seconds_until_due() == 0.0

    def test_seconds_until_due_counts_down(self):
        clock = FakeClock()
        gate = bw.CooldownGate(10, clock=clock)
        gate.on_event()
        clock.advance(4)
        gate.on_event()             # pending; 6s remain on the cooldown
        assert gate.seconds_until_due() == pytest.approx(6.0)
        clock.advance(2)
        assert gate.seconds_until_due() == pytest.approx(4.0)


# ── Decision logic: watch_loop ──────────────────────────────────────────────

class TestWatchLoop:
    """The backend-agnostic loop driving a CooldownGate from an event source."""

    def test_fires_sync_on_event(self):
        clock = FakeClock()
        gate = bw.CooldownGate(10, clock=clock)
        source = ScriptedSource(clock, [(0, True)])
        reasons = []
        n = bw.watch_loop(source, gate, lambda reason: reasons.append(reason),
                          _counting_stopper(1))
        assert n == 1
        assert reasons == ["change detected"]

    def test_event_during_cooldown_fires_after_expiry(self):
        """End-to-end through the loop: event mid-cooldown is not lost."""
        clock = FakeClock()
        gate = bw.CooldownGate(10, clock=clock)
        # t0: event fires. +2: event lands mid-cooldown -> pending. +9: no event,
        # but cooldown elapsed -> the pending sync fires.
        source = ScriptedSource(clock, [(0, True), (2, True), (9, False)])
        reasons = []
        n = bw.watch_loop(source, gate, lambda reason: reasons.append(reason),
                          _counting_stopper(3))
        assert n == 2
        assert reasons == ["change detected", "coalesced change after cooldown"]
        # While pending, the loop blocked for exactly the remaining cooldown.
        assert source.waits[2] == pytest.approx(8.0)  # 10 - 2 elapsed

    def test_burst_coalesces_to_single_sync(self):
        clock = FakeClock()
        gate = bw.CooldownGate(10, clock=clock)
        # Three rapid events, then quiet until the cooldown elapses.
        source = ScriptedSource(clock, [(0, True), (1, True), (1, True), (10, False)])
        reasons = []
        n = bw.watch_loop(source, gate, lambda reason: reasons.append(reason),
                          _counting_stopper(4))
        assert n == 2  # one immediate + one coalesced, not four

    def test_no_events_no_sync(self):
        clock = FakeClock()
        gate = bw.CooldownGate(10, clock=clock)
        source = ScriptedSource(clock, [(5, False), (5, False)])
        n = bw.watch_loop(source, gate, lambda reason: pytest.fail("should not sync"),
                          _counting_stopper(2))
        assert n == 0

    def test_stop_predicate_exits_immediately(self):
        gate = bw.CooldownGate(10, clock=FakeClock())
        source = ScriptedSource(FakeClock(), [(0, True)])
        n = bw.watch_loop(source, gate, lambda reason: pytest.fail("stopped loop ran body"),
                          lambda: True)  # already stopped
        assert n == 0
        assert source.waits == []  # loop body never executed


# ── Decision logic: backend selection ───────────────────────────────────────

class TestSelectBackend:
    def test_force_poll_overrides_fswatch(self):
        assert bw.select_backend(force_poll=True, fswatch_path="/usr/bin/fswatch") == "polling"

    def test_fswatch_present(self):
        assert bw.select_backend(force_poll=False, fswatch_path="/usr/bin/fswatch") == "fswatch"

    def test_fswatch_absent(self):
        assert bw.select_backend(force_poll=False, fswatch_path=None) == "polling"

    def test_autodetect_present(self, monkeypatch):
        monkeypatch.setattr(bw.shutil, "which", lambda name: "/opt/fswatch")
        assert bw.select_backend() == "fswatch"

    def test_autodetect_absent(self, monkeypatch):
        monkeypatch.setattr(bw.shutil, "which", lambda name: None)
        assert bw.select_backend() == "polling"


# ── Decision logic: process liveness & pidfile lifecycle ────────────────────

class TestProcessAlive:
    def test_self_is_alive(self):
        assert bw.process_alive(os.getpid()) is True

    def test_nonpositive_pid_is_dead(self):
        assert bw.process_alive(0) is False
        assert bw.process_alive(-1) is False
        assert bw.process_alive(None) is False

    def test_reaped_child_is_dead(self):
        assert bw.process_alive(_dead_pid()) is False


class TestProcessIdentity:
    """The identity token that distinguishes our daemon from a recycled PID."""

    def test_live_process_has_identity(self):
        assert bw.process_identity(os.getpid()) is not None

    def test_dead_process_has_no_identity(self):
        assert bw.process_identity(_dead_pid()) is None

    def test_nonpositive_pid_has_no_identity(self):
        assert bw.process_identity(0) is None
        assert bw.process_identity(-1) is None
        assert bw.process_identity(None) is None

    def test_identity_is_stable_across_calls(self):
        # Same live process => same token, so a write-time token still matches at
        # read-time. Different live processes get different tokens.
        assert bw.process_identity(os.getpid()) == bw.process_identity(os.getpid())

    def test_distinct_processes_differ(self):
        decoy = _spawn_decoy()
        try:
            time.sleep(0.2)
            assert bw.process_identity(decoy.pid) != bw.process_identity(os.getpid())
        finally:
            decoy.terminate()
            decoy.wait(timeout=5)

    def test_identity_from_proc_parses_stat_and_cmdline(self, tmp_path):
        """The Linux /proc path, exercised against a fake /proc on any platform."""
        proc = tmp_path / "proc" / "4321"
        proc.mkdir(parents=True)
        # stat: "<pid> (comm) <state> ..." — comm has a nested ')' on purpose, and
        # starttime is overall field 22 (index 19 after the comm).
        rest = ["S"] + [str(n) for n in range(4, 22)] + ["99887766"]
        (proc / "stat").write_text("4321 (beacon (x)) " + " ".join(rest))
        (proc / "cmdline").write_bytes(b"python\0-m\0agent_env.beacon_watcher\0")
        token = bw._identity_from_proc(tmp_path / "proc", 4321)
        assert token == "99887766|python -m agent_env.beacon_watcher"

    def test_identity_from_proc_missing_returns_none(self, tmp_path):
        assert bw._identity_from_proc(tmp_path / "proc", 999) is None

    def test_identity_from_proc_malformed_returns_none(self, tmp_path):
        proc = tmp_path / "proc" / "5"
        proc.mkdir(parents=True)
        (proc / "stat").write_text("5 (x) S 1 2 3")   # too few fields -> IndexError
        (proc / "cmdline").write_bytes(b"x\0")
        assert bw._identity_from_proc(tmp_path / "proc", 5) is None


class TestPidFile:
    def test_write_then_read_roundtrips(self, tmp_path):
        pf = PidFile(tmp_path / "watcher.pid")
        pf.write(4321)
        assert pf.read() == 4321

    def test_read_missing_returns_none(self, tmp_path):
        assert PidFile(tmp_path / "absent.pid").read() is None

    def test_read_garbage_returns_none(self, tmp_path):
        path = tmp_path / "watcher.pid"
        path.write_text("not-a-pid\n")
        assert PidFile(path).read() is None

    def test_read_nonpositive_returns_none(self, tmp_path):
        path = tmp_path / "watcher.pid"
        path.write_text("0\n")
        assert PidFile(path).read() is None

    def test_remove_is_idempotent(self, tmp_path):
        pf = PidFile(tmp_path / "watcher.pid")
        pf.write(123)
        pf.remove()
        pf.remove()  # second remove must not raise
        assert pf.read() is None

    def test_is_running_uses_injected_liveness(self, tmp_path):
        pf_live = PidFile(tmp_path / "a.pid", alive_fn=lambda pid: True)
        pf_live.write(999)
        assert pf_live.is_running() is True
        assert pf_live.is_stale() is False

        pf_dead = PidFile(tmp_path / "b.pid", alive_fn=lambda pid: False)
        pf_dead.write(999)
        assert pf_dead.is_running() is False
        assert pf_dead.is_stale() is True

    def test_stale_and_running_false_when_absent(self, tmp_path):
        pf = PidFile(tmp_path / "absent.pid", alive_fn=lambda pid: True)
        assert pf.is_running() is False
        assert pf.is_stale() is False


class TestPidFileIdentity:
    """is_running/is_stale validate identity, so a recycled PID reads as stale."""

    def test_write_read_identity_roundtrips(self, tmp_path):
        pf = PidFile(tmp_path / "watcher.pid")
        pf.write(4321, identity="100|python -m agent_env.beacon_watcher")
        assert pf.read() == 4321
        assert pf.read_identity() == "100|python -m agent_env.beacon_watcher"

    def test_bare_pidfile_has_no_identity(self, tmp_path):
        pf = PidFile(tmp_path / "watcher.pid")
        pf.write(4321)
        assert pf.read_identity() is None

    def test_running_requires_matching_identity(self, tmp_path):
        pf = PidFile(tmp_path / "w.pid", identity_fn=lambda pid: "our-token")
        pf.write(999, identity="our-token")
        assert pf.is_running() is True
        assert pf.is_stale() is False

    def test_identity_mismatch_is_stale_not_running(self, tmp_path):
        # Recycled PID: alive, but its live identity differs from what we stored.
        pf = PidFile(tmp_path / "w.pid", identity_fn=lambda pid: "foreign-token")
        pf.write(999, identity="our-token")
        assert pf.is_running() is False
        assert pf.is_stale() is True

    def test_dead_pid_with_identity_is_stale(self, tmp_path):
        pf = PidFile(tmp_path / "w.pid", identity_fn=lambda pid: None)
        pf.write(999, identity="our-token")
        assert pf.is_running() is False
        assert pf.is_stale() is True

    def test_newline_in_identity_is_sanitized(self, tmp_path):
        # A token can never span lines, else read() would mis-parse the pid.
        pf = PidFile(tmp_path / "w.pid")
        pf.write(4321, identity="a\nb")
        assert pf.read() == 4321
        assert pf.read_identity() == "a b"


class TestRecoverStalePidfile:
    def test_removes_stale(self, tmp_path):
        pf = PidFile(tmp_path / "watcher.pid", alive_fn=lambda pid: False)
        pf.write(4242)
        assert bw._recover_stale_pidfile(pf) is True
        assert not pf.path.exists()

    def test_keeps_live(self, tmp_path):
        pf = PidFile(tmp_path / "watcher.pid", alive_fn=lambda pid: True)
        pf.write(4242)
        assert bw._recover_stale_pidfile(pf) is False
        assert pf.path.exists()

    def test_noop_when_absent(self, tmp_path):
        pf = PidFile(tmp_path / "absent.pid")
        assert bw._recover_stale_pidfile(pf) is False


class TestClaimPidfile:
    """Atomic O_CREAT|O_EXCL claim + fd finalization (the concurrent-start fix)."""

    def test_first_claim_succeeds_and_stamps_identity(self, tmp_path):
        pf = PidFile(tmp_path / "w.pid")
        fd = bw._claim_pidfile(pf)
        try:
            assert fd is not None
            assert pf.path.exists()
            # The reserved file is stamped with the claimer's live pid+identity, so
            # it never looks empty to a racing loser.
            assert pf.read() == os.getpid()
            assert pf.is_running() is True
        finally:
            os.close(fd)

    def test_second_concurrent_claim_loses_to_live_owner(self, tmp_path):
        path = tmp_path / "w.pid"
        winner_fd = bw._claim_pidfile(PidFile(path))
        try:
            # A second claimer finds a live, identity-matched owner and loses
            # WITHOUT removing the winner's file.
            assert bw._claim_pidfile(PidFile(path), attempts=2,
                                     sleep=lambda s: None) is None
            assert path.exists()
            assert PidFile(path).read() == os.getpid()
        finally:
            os.close(winner_fd)

    def test_claim_clears_stale_residue_then_wins(self, tmp_path):
        path = tmp_path / "w.pid"
        PidFile(path).write(_dead_pid(), identity="dead-token")  # crash residue
        fd = bw._claim_pidfile(PidFile(path), attempts=3, sleep=lambda s: None)
        try:
            assert fd is not None              # residue cleared, claim taken
            assert PidFile(path).is_running()  # now names the live claimer
        finally:
            os.close(fd)

    def test_finalize_claim_overwrites_with_real_pid(self, tmp_path):
        path = tmp_path / "w.pid"
        fd = os.open(str(path), os.O_CREAT | os.O_WRONLY, 0o644)
        os.write(fd, b"999\nprefork-token\n")   # pre-fork stamp to be replaced
        bw._finalize_claim(fd, 12345, "daemon-token")
        pf = PidFile(path)
        assert pf.read() == 12345
        assert pf.read_identity() == "daemon-token"


# ── Decision logic: change detection for the polling fallback ───────────────

class TestComputeWatchHashes:
    def test_hashes_files_and_dir_contents(self, tmp_path):
        f = tmp_path / "agent_map.md"
        f.write_text("hello")
        d = tmp_path / "skills"
        (d / "a").mkdir(parents=True)
        (d / "a" / "SKILL.md").write_text("skill")
        hashes = bw.compute_watch_hashes(None, paths=[f, d])
        assert str(f) in hashes
        assert str(d / "a" / "SKILL.md") in hashes

    def test_hash_changes_on_edit(self, tmp_path):
        f = tmp_path / "agent_map.md"
        f.write_text("v1")
        before = bw.compute_watch_hashes(None, paths=[f])
        f.write_text("v2")
        after = bw.compute_watch_hashes(None, paths=[f])
        assert before != after

    def test_new_file_in_dir_changes_hashes(self, tmp_path):
        d = tmp_path / "Obsidian"
        d.mkdir()
        (d / "one.md").write_text("1")
        before = bw.compute_watch_hashes(None, paths=[d])
        (d / "two.md").write_text("2")
        after = bw.compute_watch_hashes(None, paths=[d])
        assert before != after

    def test_missing_path_ignored(self, tmp_path):
        assert bw.compute_watch_hashes(None, paths=[tmp_path / "nope"]) == {}

    def test_hash_file_unreadable_returns_empty(self, tmp_path):
        # A directory cannot be read as bytes -> "" rather than an exception.
        assert bw._hash_file(tmp_path) == ""

    def test_default_paths_from_env(self, tmp_path):
        env = make_env(tmp_path)
        # env.watch_paths() includes agent_map.md, which make_env wrote.
        hashes = bw.compute_watch_hashes(env)
        assert str(env.agent_map) in hashes


# ── Sync trigger ────────────────────────────────────────────────────────────

class TestRunSync:
    def test_calls_run_generate_once(self, tmp_path, monkeypatch):
        env = make_env(tmp_path)
        calls = []
        monkeypatch.setattr(bw.beacon_sync, "run_generate", lambda e: calls.append(e))
        bw.run_sync(env, reason="unit")
        assert calls == [env]

    def test_swallows_exception(self, tmp_path, monkeypatch):
        env = make_env(tmp_path)
        called = []

        def boom(e):
            called.append(e)
            raise RuntimeError("boom")

        monkeypatch.setattr(bw.beacon_sync, "run_generate", boom)
        bw.run_sync(env, reason="err")        # must not raise
        assert called == [env]                # but the attempt happened

    def test_swallows_system_exit(self, tmp_path, monkeypatch):
        env = make_env(tmp_path)
        monkeypatch.setattr(bw.beacon_sync, "run_generate",
                            lambda e: (_ for _ in ()).throw(SystemExit(1)))
        bw.run_sync(env, reason="exit")       # must not propagate SystemExit


# ── Event sources: polling ──────────────────────────────────────────────────

class TestPollingEventSource:
    def test_detects_change(self, tmp_path):
        env = make_env(tmp_path)
        src = bw.PollingEventSource(env, interval=0.02)
        # make_env already wrote agent_map.md; mutate it and poll.
        env.agent_map.write_text("changed")
        assert src.wait(0.05) is True

    def test_no_change_returns_false(self, tmp_path):
        env = make_env(tmp_path)
        src = bw.PollingEventSource(env, interval=0.02)
        assert src.wait(0.05) is False

    def test_stop_event_short_circuits(self, tmp_path):
        env = make_env(tmp_path)
        stop = threading.Event()
        stop.set()
        src = bw.PollingEventSource(env, interval=5.0, stop_event=stop)
        start = time.monotonic()
        assert src.wait(5.0) is False        # returns at once despite a 5s budget
        assert time.monotonic() - start < 1.0
        src.close()


# ── Event sources: fswatch (requires fswatch on PATH) ───────────────────────

@pytest.mark.skipif(not shutil.which("fswatch"), reason="fswatch not installed")
class TestFswatchEventSource:
    def test_quiet_dir_eventually_times_out_to_false(self, tmp_path):
        (tmp_path / "f.txt").write_text("x")
        src = bw.FswatchEventSource([tmp_path])
        try:
            # fswatch may emit start-up events; once the dir is quiet, wait() must
            # exercise its timeout path and return False.
            deadline = time.monotonic() + 5
            settled = False
            while time.monotonic() < deadline:
                if src.wait(0.3) is False:
                    settled = True
                    break
            assert settled, "fswatch never went quiet on an unchanged dir"
        finally:
            src.close()
        assert src._proc is None  # no orphan fswatch

    def test_detects_real_change(self, tmp_path):
        target = tmp_path / "f.txt"
        target.write_text("x")
        src = bw.FswatchEventSource([tmp_path])
        try:
            src.wait(0.5)  # let fswatch spin up
            got = False
            for i in range(20):  # up to ~10s, regenerating events each turn
                target.write_text(f"y{i}")
                if src.wait(0.5):
                    got = True
                    break
            assert got
        finally:
            src.close()

    def test_close_terminates_process(self, tmp_path):
        src = bw.FswatchEventSource([tmp_path])
        src.wait(0.2)  # spawn
        proc = src._proc
        assert proc is not None
        src.close()
        assert proc.poll() is not None  # terminated
        assert src._proc is None

    def test_stop_event_returns_false_promptly(self, tmp_path):
        stop = threading.Event()
        stop.set()
        src = bw.FswatchEventSource([tmp_path], stop_event=stop)
        try:
            start = time.monotonic()
            assert src.wait(5.0) is False     # honors stop before blocking on select
            assert time.monotonic() - start < 1.0
        finally:
            src.close()


# ── Event sources: fswatch fork-storm guard (fake fswatch, no real forks) ────

class TestFswatchForkStormGuard:
    """A persistently-dying fswatch must back off and degrade to polling, not
    respawn ~350x/second (F-C)."""

    def _instant_source(self, monkeypatch, sleeps):
        monkeypatch.setattr(bw.subprocess, "Popen", _InstantDeadProc)
        return bw.FswatchEventSource(
            [Path("/watched")], sleep=lambda s: sleeps.append(s), clock=lambda: 0.0,
        )

    def test_immediate_deaths_back_off_then_degrade(self, monkeypatch):
        sleeps = []
        src = self._instant_source(monkeypatch, sleeps)
        K = bw.FswatchEventSource.MAX_FAST_DEATHS
        for _ in range(K):
            assert src.wait(0.5) is False        # every spawn dies on launch
        assert src.degraded is True
        # Exponential backoff on deaths 1..K-1; the Kth degrades without sleeping.
        base = bw.FswatchEventSource.BACKOFF_BASE
        assert sleeps == [pytest.approx(base * 2 ** i) for i in range(K - 1)]

    def test_degraded_source_short_circuits_without_respawn(self, monkeypatch):
        sleeps = []
        src = self._instant_source(monkeypatch, sleeps)
        for _ in range(bw.FswatchEventSource.MAX_FAST_DEATHS):
            src.wait(0.5)
        assert src.degraded is True
        before = len(sleeps)
        assert src.wait(0.5) is False            # no spawn, no backoff once degraded
        assert len(sleeps) == before

    def test_backoff_is_capped(self, monkeypatch):
        sleeps = []
        monkeypatch.setattr(bw.subprocess, "Popen", _InstantDeadProc)
        src = bw.FswatchEventSource([Path("/w")], sleep=lambda s: sleeps.append(s),
                                    clock=lambda: 0.0)
        # Raise the death budget and lower the cap; the cap must still bound sleeps.
        monkeypatch.setattr(src, "MAX_FAST_DEATHS", 8)
        monkeypatch.setattr(src, "BACKOFF_MAX", 0.25)
        for _ in range(7):
            src.wait(0.5)
        assert max(sleeps) <= 0.25

    def test_healthy_exit_resets_fast_death_streak(self):
        # An fswatch that lived past the threshold is a healthy exit, not part of a
        # storm: the streak resets so it never degrades.
        src = bw.FswatchEventSource([Path("/w")], clock=lambda: 100.0)
        src._spawn_at = 0.0
        src._fast_deaths = 3
        src._note_exit()                         # lived = 100s >> FAST_DEATH_SECONDS
        assert src._fast_deaths == 0
        assert src.degraded is False


# ── run_watch wiring ────────────────────────────────────────────────────────

class TestRunWatch:
    def test_polling_branch_returns_when_stopped(self, tmp_path):
        env = make_env(tmp_path)
        stop = threading.Event()
        stop.set()  # pre-stopped: the loop body never runs, returns at once
        assert bw.run_watch(env, force_poll=True, stop_event=stop) == 0

    def test_fswatch_branch_builds_and_closes_source(self, tmp_path, monkeypatch):
        env = make_env(tmp_path)
        made = {}

        class FakeFswatch:
            def __init__(self, paths, stop_event=None):
                made["paths"] = paths
            def wait(self, timeout):
                return False
            def close(self):
                made["closed"] = True

        monkeypatch.setattr(bw, "select_backend", lambda **kw: "fswatch")
        monkeypatch.setattr(bw, "FswatchEventSource", FakeFswatch)
        stop = threading.Event()
        stop.set()
        bw.run_watch(env, stop_event=stop)
        assert made.get("paths") is not None
        assert made.get("closed") is True

    def test_degraded_fswatch_falls_back_to_polling(self, tmp_path, monkeypatch):
        """When the fswatch source degrades, run_watch finishes on polling."""
        env = make_env(tmp_path)
        used = {"poll_waits": 0}
        stop = threading.Event()

        class DegradingFswatch:
            def __init__(self, paths, stop_event=None):
                self.degraded = False
            def wait(self, timeout):
                self.degraded = True          # degrade on the first wait
                return False
            def close(self):
                used["fswatch_closed"] = True

        class FakePolling:
            def __init__(self, env, stop_event=None):
                used["poll_built"] = True
            def wait(self, timeout):
                used["poll_waits"] += 1
                stop.set()                    # let the polling loop exit after a turn
                return False
            def close(self):
                used["poll_closed"] = True

        monkeypatch.setattr(bw, "select_backend", lambda **kw: "fswatch")
        monkeypatch.setattr(bw, "FswatchEventSource", DegradingFswatch)
        monkeypatch.setattr(bw, "PollingEventSource", FakePolling)
        bw.run_watch(env, stop_event=stop)
        assert used.get("fswatch_closed") is True   # the degraded source was closed
        assert used.get("poll_built") is True       # polling took over
        assert used["poll_waits"] >= 1
        assert used.get("poll_closed") is True

    def test_defaults_to_module_stop_event(self, tmp_path):
        env = make_env(tmp_path)
        bw._STOP.set()  # pre-stop the module-global event used when none is passed
        try:
            assert bw.run_watch(env, force_poll=True) == 0
        finally:
            bw._STOP.clear()


# ── Foreground & CLI dispatch ───────────────────────────────────────────────

class TestForegroundAndMain:
    def test_run_foreground_invokes_run_watch(self, tmp_path, monkeypatch):
        env = make_env(tmp_path)
        seen = {}
        monkeypatch.setattr(
            bw, "run_watch",
            lambda e, force_poll=False, stop_event=None: seen.update(env=e, fp=force_poll),
        )
        old = (signal.getsignal(signal.SIGTERM), signal.getsignal(signal.SIGINT))
        try:
            bw.run_foreground(env, force_poll=True)
        finally:
            signal.signal(signal.SIGTERM, old[0])
            signal.signal(signal.SIGINT, old[1])
        assert seen == {"env": env, "fp": True}

    def test_run_foreground_swallows_keyboard_interrupt(self, tmp_path, monkeypatch):
        env = make_env(tmp_path)

        def boom(*a, **k):
            raise KeyboardInterrupt

        monkeypatch.setattr(bw, "run_watch", boom)
        old = (signal.getsignal(signal.SIGTERM), signal.getsignal(signal.SIGINT))
        try:
            bw.run_foreground(env)  # Ctrl-C must not escape as an error
        finally:
            signal.signal(signal.SIGTERM, old[0])
            signal.signal(signal.SIGINT, old[1])

    def test_main_status_not_running(self, tmp_path, capsys):
        _env, cfg = _daemon_env(tmp_path)
        assert bw.main(["--config", cfg, "--status"]) == 0
        assert "not running" in capsys.readouterr().out

    def test_main_status_running(self, tmp_path, monkeypatch, capsys):
        _env, cfg = _daemon_env(tmp_path)
        monkeypatch.setattr(bw, "status", lambda env: 4242)
        bw.main(["--config", cfg, "--status"])
        assert "running (pid 4242)" in capsys.readouterr().out

    def test_main_stop_running(self, tmp_path, monkeypatch, capsys):
        _env, cfg = _daemon_env(tmp_path)
        monkeypatch.setattr(bw, "stop", lambda env: True)
        bw.main(["--config", cfg, "--stop"])
        assert "stopped" in capsys.readouterr().out

    def test_main_stop_none(self, tmp_path, monkeypatch, capsys):
        _env, cfg = _daemon_env(tmp_path)
        monkeypatch.setattr(bw, "stop", lambda env: False)
        bw.main(["--config", cfg, "--stop"])
        assert "no running watcher" in capsys.readouterr().out

    def test_main_daemon_dispatch(self, tmp_path, monkeypatch):
        _env, cfg = _daemon_env(tmp_path)
        seen = {}
        monkeypatch.setattr(bw, "_run_as_daemon",
                            lambda env, force_poll=False: seen.update(fp=force_poll) or 0)
        assert bw.main(["--config", cfg, "--daemon", "--poll"]) == 0
        assert seen["fp"] is True

    def test_main_default_is_foreground(self, tmp_path, monkeypatch):
        _env, cfg = _daemon_env(tmp_path)
        seen = {}
        monkeypatch.setattr(bw, "run_foreground",
                            lambda env, force_poll=False: seen.update(fp=force_poll))
        assert bw.main(["--config", cfg]) == 0
        assert seen["fp"] is False

    def test_main_argv_defaults_to_sys_argv(self, tmp_path, monkeypatch, capsys):
        _env, cfg = _daemon_env(tmp_path)
        monkeypatch.setattr(sys, "argv", ["beacon_watcher", "--config", cfg, "--status"])
        assert bw.main() == 0  # argv=None -> reads sys.argv[1:]
        assert "not running" in capsys.readouterr().out


# ── _run_as_daemon guard & stop (no real daemon) ────────────────────────────

class TestDaemonGuards:
    def test_run_as_daemon_refuses_when_already_running(self, tmp_path, monkeypatch):
        env = make_env(tmp_path)
        PidFile(env.watcher_pidfile).write(os.getpid())  # we are alive => running
        monkeypatch.setattr(bw, "daemonize",
                            lambda *a, **k: pytest.fail("must not daemonize"))
        assert bw._run_as_daemon(env, force_poll=True) == 0

    def test_run_as_daemon_recovers_stale_then_dispatches(self, tmp_path, monkeypatch):
        """Non-running path: a stale pidfile is recovered, then atomically claimed
        and the open fd is carried through to the (stubbed) daemonize/_serve."""
        env = make_env(tmp_path)
        dead = _dead_pid()
        PidFile(env.watcher_pidfile).write(dead, identity="dead-token")  # stale residue
        seen = {}
        # Stub the fork/serve machinery so the test process doesn't daemonize.
        monkeypatch.setattr(bw, "daemonize",
                            lambda log_path, keep_fd=None: seen.update(log=log_path, fd=keep_fd))
        monkeypatch.setattr(bw, "_serve",
                            lambda e, pf, fp, claim_fd=None: seen.update(fp=fp, claim=claim_fd))
        assert bw._run_as_daemon(env, force_poll=True) == 0
        assert seen["log"] == env.watcher_log
        assert seen["fp"] is True
        assert seen["fd"] is not None and seen["fd"] == seen["claim"]  # fd passed through
        # Stale (dead) pid recovered; the file now names the live claimer, not `dead`.
        assert PidFile(env.watcher_pidfile).read() != dead
        assert PidFile(env.watcher_pidfile).is_running()
        os.close(seen["fd"])               # the real reserved fd the stub left open
        env.watcher_pidfile.unlink()

    def test_handle_stop_is_bare_flag_set_no_io(self, capsys):
        """The handler must do no I/O (async-signal-safe): set the flag, record
        the signum, and nothing else. The log line is deferred to the loop."""
        bw._STOP.clear()
        bw._STOP_SIGNUM = None
        try:
            bw._handle_stop(signal.SIGTERM, None)
            assert bw._STOP.is_set()
            assert bw._STOP_SIGNUM == signal.SIGTERM
            assert capsys.readouterr().out == ""        # no logging inside the handler
            # The loop emits the deferred line after it wakes, then clears it.
            bw._log_stop_signal()
            out = capsys.readouterr().out
            assert "received signal" in out and str(int(signal.SIGTERM)) in out
            assert bw._STOP_SIGNUM is None
        finally:
            bw._STOP.clear()
            bw._STOP_SIGNUM = None

    def test_log_stop_signal_noop_when_nothing_recorded(self, capsys):
        bw._STOP_SIGNUM = None
        bw._log_stop_signal()
        assert capsys.readouterr().out == ""

    def test_await_pidfile_times_out_to_none(self, tmp_path):
        pf = PidFile(tmp_path / "never-written.pid")
        t0 = time.monotonic()
        assert bw._await_pidfile(pf, timeout=0.2, interval=0.05) is None
        assert time.monotonic() - t0 >= 0.2  # actually waited the full window

    def test_stop_no_watcher_returns_false(self, tmp_path):
        env = make_env(tmp_path)
        assert bw.stop(env) is False

    def test_stop_removes_stale_pidfile(self, tmp_path):
        env = make_env(tmp_path)
        PidFile(env.watcher_pidfile).write(_dead_pid())
        assert bw.stop(env) is False
        assert not env.watcher_pidfile.exists()

    def test_stop_refuses_foreign_recycled_pid(self, tmp_path, spawned_pids):
        """stop() must never signal a live PID whose identity is not the daemon's.

        Models a recycled PID: the watcher died and the kernel handed its PID to
        an unrelated process. stop() must leave that bystander untouched.
        """
        env = make_env(tmp_path)
        decoy = _spawn_decoy()
        spawned_pids.append(decoy.pid)
        time.sleep(0.2)
        # Pidfile names the decoy's PID but with the *dead* watcher's identity.
        PidFile(env.watcher_pidfile).write(decoy.pid, identity="dead-watcher-token")
        assert bw.stop(env) is False              # not ours -> not signalled
        assert bw.process_alive(decoy.pid)        # the bystander survives
        assert not env.watcher_pidfile.exists()   # stale residue still cleared

    def test_stop_escalates_to_sigkill(self, tmp_path, spawned_pids):
        """A watcher that ignores SIGTERM is escalated to SIGKILL within timeout."""
        env = make_env(tmp_path)
        proc = _spawn_sigterm_ignorer()
        spawned_pids.append(proc.pid)
        time.sleep(0.3)  # let the child install its SIG_IGN handler
        PidFile(env.watcher_pidfile).write(proc.pid)
        assert bw.stop(env, timeout=0.5) is True   # SIGTERM ignored -> SIGKILL
        proc.wait(timeout=5)                        # reap the killed child (zombie)
        assert proc.returncode is not None
        assert not env.watcher_pidfile.exists()

    def test_status_running_and_not(self, tmp_path):
        env = make_env(tmp_path)
        assert bw.status(env) is None
        PidFile(env.watcher_pidfile).write(os.getpid())
        assert bw.status(env) == os.getpid()


# ── Daemonization smoke test (spawns a real, isolated daemon) ────────────────

class TestDaemonSmoke:
    """Spawn a real daemon against a tmp root; assert pidfile + log + clean stop.

    HARD CONSTRAINT: everything resolves under tmp_path; the live ~/.agent-env is
    never touched. The spawned_pids fixture SIGKILLs any survivor in teardown and
    asserts it is dead, so the suite leaves no orphan watcher behind.
    """

    def test_lifecycle_start_pidfile_log_stop(self, tmp_path, spawned_pids):
        env, _cfg = _daemon_env(tmp_path)
        # config_path omitted on purpose: start() falls back to env.config_path.
        pid = bw.start(env, force_poll=True)
        spawned_pids.append(pid)

        assert pid is not None, "daemon did not report a pid"
        assert bw.process_alive(pid)
        assert env.watcher_pidfile.exists()
        assert PidFile(env.watcher_pidfile).read() == pid
        assert _wait_for(env.watcher_log.exists, 5), "daemon never created its log"

        # Idempotent: starting again returns the same pid, no second daemon.
        assert bw.start(env, force_poll=True) == pid

        # SIGTERM via stop(): process exits and the pidfile is cleaned up.
        assert bw.stop(env) is True
        assert _wait_for(lambda: not bw.process_alive(pid), 5)
        assert not env.watcher_pidfile.exists()

    def test_stale_pidfile_recovered_after_kill9(self, tmp_path, spawned_pids):
        env, cfg = _daemon_env(tmp_path)
        pid1 = bw.start(env, force_poll=True, config_path=cfg)
        spawned_pids.append(pid1)
        assert bw.process_alive(pid1)

        # Simulate a crash: SIGKILL leaves the pidfile pointing at a dead pid.
        os.kill(pid1, signal.SIGKILL)
        assert _wait_for(lambda: not bw.process_alive(pid1), 5)
        assert PidFile(env.watcher_pidfile).read() == pid1  # stale residue

        # Restart recovers the stale pidfile and brings up a fresh daemon.
        pid2 = bw.start(env, force_poll=True, config_path=cfg)
        spawned_pids.append(pid2)
        assert pid2 is not None
        assert bw.process_alive(pid2)
        assert PidFile(env.watcher_pidfile).read() == pid2

        assert bw.stop(env) is True
        assert _wait_for(lambda: not bw.process_alive(pid2), 5)

    def test_recycled_pid_wedge_recovers(self, tmp_path, spawned_pids):
        """A pidfile pointing at a live *foreign* (recycled) PID must not wedge
        start(): the stale entry is recovered and a fresh daemon comes up, and the
        bystander holding the recycled PID is never signalled."""
        env, cfg = _daemon_env(tmp_path)
        decoy = _spawn_decoy()
        spawned_pids.append(decoy.pid)
        time.sleep(0.2)
        # The dead watcher's PID is now `decoy`; its stored identity is stale.
        PidFile(env.watcher_pidfile).write(decoy.pid, identity="dead-watcher-token")

        pid = bw.start(env, force_poll=True, config_path=cfg)
        spawned_pids.append(pid)
        assert pid is not None
        assert pid != decoy.pid                       # a genuinely new daemon...
        assert bw.process_alive(pid)                  # ...that actually came up
        assert PidFile(env.watcher_pidfile).read() == pid
        assert bw.process_alive(decoy.pid)            # bystander never signalled

        assert bw.stop(env) is True
        assert _wait_for(lambda: not bw.process_alive(pid), 5)

    def test_concurrent_starts_yield_one_daemon(self, tmp_path, spawned_pids):
        """Two daemons racing to start yield exactly one watcher and one valid
        pidfile: the loser of the atomic O_EXCL claim exits without daemonizing,
        so the first daemon is never overwritten and orphaned."""
        env, cfg = _daemon_env(tmp_path)
        cmd = [sys.executable, "-m", "agent_env.beacon_watcher",
               "--daemon", "--poll", "--config", cfg]

        def _spawn():
            return subprocess.Popen(
                cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, start_new_session=True,
            )

        def _live_watchers():
            out = subprocess.run(["pgrep", "-f", "agent_env.beacon_watcher"],
                                 capture_output=True, text=True)
            return sorted(
                p for p in (int(t) for t in out.stdout.split())
                if bw.process_alive(p) and cfg in (bw.process_identity(p) or "")
            )

        racers = [_spawn(), _spawn()]
        for r in racers:        # both pre-fork processes exit promptly; reap them
            try:
                r.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass

        # The pidfile settles on exactly one live, identity-matched daemon.
        assert _wait_for(lambda: PidFile(env.watcher_pidfile).is_running(), 5), \
            "no daemon ever claimed the pidfile"
        pid = PidFile(env.watcher_pidfile).read()
        spawned_pids.append(pid)

        # Exactly one watcher process is alive for this config — the loser exited.
        assert _wait_for(lambda: _live_watchers() == [pid], 5), \
            f"expected exactly one watcher ({pid}); found {_live_watchers()}"

        assert bw.stop(env) is True
        assert _wait_for(lambda: not bw.process_alive(pid), 5)
        assert not env.watcher_pidfile.exists()
