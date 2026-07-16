#!/bin/bash
# In-container hardening verification. Run with the FULL hardened `docker run`
# flag set (see docs/deploy/hardened-browser.md). Exits non-zero on any failure.
set -u
FAIL=0
check() { # name, condition-result (0/1), detail
  if [ "$2" -eq 0 ]; then echo "PASS  $1  $3"; else echo "FAIL  $1  $3"; FAIL=1; fi
}

# 1. Non-root execution
UID_NOW=$(id -u)
[ "$UID_NOW" -ne 0 ]; check "non-root" $? "uid=$UID_NOW ($(id -un))"

# 2. All capabilities dropped
CAPEFF=$(grep CapEff /proc/self/status | awk '{print $2}')
[ "$CAPEFF" = "0000000000000000" ]; check "cap-drop-all" $? "CapEff=$CAPEFF"

# 3. no-new-privileges
NNP=$(grep NoNewPrivs /proc/self/status | awk '{print $2}')
[ "$NNP" = "1" ]; check "no-new-privileges" $? "NoNewPrivs=$NNP"

# 4. Seccomp filter active (2 = SECCOMP_MODE_FILTER)
SECCOMP=$(grep '^Seccomp:' /proc/self/status | awk '{print $2}')
[ "$SECCOMP" = "2" ]; check "seccomp-filter" $? "Seccomp=$SECCOMP"

# 5. Read-only root filesystem
if touch /rofs-test 2>/dev/null; then rm -f /rofs-test; check "read-only-rootfs" 1 "/ is writable"; else check "read-only-rootfs" 0 "/ not writable"; fi
if touch /app/rofs-test 2>/dev/null; then rm -f /app/rofs-test; check "read-only-app" 1 "/app is writable"; else check "read-only-app" 0 "/app not writable"; fi

# 6. Writable tmpfs mounts (and /tmp is noexec+nosuid)
touch /tmp/wtest 2>/dev/null; check "tmpfs-tmp-writable" $? "/tmp writable"; rm -f /tmp/wtest
TMPOPTS=$(grep ' /tmp ' /proc/mounts | head -1)
echo "$TMPOPTS" | grep -q noexec; check "tmp-noexec" $? "$TMPOPTS"
echo "$TMPOPTS" | grep -q nosuid; check "tmp-nosuid" $? ""
touch /app/.artifacts/wtest 2>/dev/null; check "artifacts-writable" $? "/app/.artifacts writable"; rm -f /app/.artifacts/wtest
touch "$HOME/wtest" 2>/dev/null; check "home-writable" $? "HOME=$HOME writable (Chromium cache)"; rm -f "$HOME/wtest"

# 7. Resource limits (cgroup v2)
PIDSMAX=$(cat /sys/fs/cgroup/pids.max 2>/dev/null || echo unknown)
[ "$PIDSMAX" != "max" ] && [ "$PIDSMAX" != "unknown" ]; check "pids-limit" $? "pids.max=$PIDSMAX"
MEMMAX=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || echo unknown)
[ "$MEMMAX" != "max" ] && [ "$MEMMAX" != "unknown" ]; check "memory-limit" $? "memory.max=$MEMMAX"
CPUMAX=$(cat /sys/fs/cgroup/cpu.max 2>/dev/null || echo unknown)
[ "$CPUMAX" != "max" ] && [ "$CPUMAX" != "unknown" ]; check "cpu-limit" $? "cpu.max=$CPUMAX"

# 8. PID 1 is an init (zombie reaping via --init)
INIT_COMM=$(cat /proc/1/comm 2>/dev/null || echo unknown)
[ "$INIT_COMM" != "node" ] && [ "$INIT_COMM" != "bash" ]; check "init-pid1" $? "pid1=$INIT_COMM"

echo "---"
[ $FAIL -eq 0 ] && echo "ALL HARDENING CHECKS PASSED" || echo "HARDENING CHECKS FAILED"
exit $FAIL
