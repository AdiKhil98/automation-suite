# Hardened browser runtime (production capture)

Playwright's official Docker image is a **base/runtime dependency, not a complete
security boundary** for browsing untrusted prospect websites. Real external captures
must run in a hardened, network-isolated container. The local Windows Chromium
install is for controlled local fixtures and development debugging only — **do not
browse real untrusted prospect sites from the Windows host.**

## Image
`deploy/Dockerfile.capture` is based on `mcr.microsoft.com/playwright:v1.61.1-noble`
(tag pinned to the `playwright` package version). It runs as the non-root `pwuser`.

## Chromium in-process sandbox vs. container hardening (D-0022)
Chromium's *in-process* sandbox is **incompatible** with the maximally-hardened flag
set: under `--cap-drop ALL` + `--security-opt no-new-privileges`, neither the setuid
sandbox (needs privilege escalation) nor the namespace sandbox can initialize, so
Chromium fails to launch. Rather than weaken the container to satisfy Chromium, the
**container itself is the authoritative boundary** (D-0017): non-root, all caps
dropped, no-new-privileges, default-deny seccomp, read-only fs, resource limits, and —
the real SSRF control — the network **egress firewall**. Inside that boundary the app
sets `CAPTURE_CHROMIUM_SANDBOX=false` (Chromium runs with `--no-sandbox`). Where a
runtime *can* grant the in-process sandbox (e.g. a dev host), leave
`CAPTURE_CHROMIUM_SANDBOX=true` for defense-in-depth. Playwright defaults this to OFF,
so it is set explicitly in code either way — verified by `deploy/verify-capture.mjs`.

## Build

```bash
docker build -f deploy/Dockerfile.capture -t capture-runtime .
```

`.dockerignore` keeps `.env`, `node_modules`, `.git`, and all local artifacts OUT of
the image — secrets are never baked in; the key is passed only at run time via `--env`.

## Required `docker run` hardening
```bash
docker run --rm \
  --user pwuser \
  --init \
  --security-opt seccomp=deploy/seccomp/chromium.json \
  --security-opt no-new-privileges \
  --cap-drop ALL \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m \
  --tmpfs /home/pwuser:rw,nosuid,mode=1777,size=256m \
  --tmpfs /app/.artifacts:rw,nosuid,size=512m \
  --pids-limit 512 \
  --memory 1g --cpus 1.5 \
  --network capture-egress \
  capture-runtime --campaign <name>
```

- **Non-root + `no-new-privileges` + `cap-drop ALL`** — least privilege.
- **`--init`** — reaps zombie Chromium child processes.
- **Chromium seccomp profile** — `deploy/seccomp/chromium.json` is Playwright's
  recommended profile for v1.61.1 (default-deny `SCMP_ACT_ERRNO` with an explicit
  allowlist).
- **`--read-only` root fs + tmpfs** — isolated writable dirs only: `/tmp` (noexec,
  nosuid), Chromium's writable `HOME` (`/home/pwuser`), and artifacts to a bounded
  tmpfs or a mounted volume (never a host dir with other data).
- **Resource limits** — CPU/memory/PID caps (execution-time cap via the app's
  `CAPTURE_TOTAL_TIMEOUT_MS`).
- **Do NOT** use `--network host`, **do NOT** mount the Docker socket, **do NOT**
  mount credentials or unrelated host directories.

## Verification (run before trusting the container)

Two scripts prove the hardening is actually in effect — not merely declared:

```bash
# A) OS-level hardening assertions (non-root, cap-drop, seccomp, read-only, tmpfs,
#    limits, init). Override the entrypoint to run the checker inside the full flag set:
docker run --rm --entrypoint bash \
  --user pwuser --init \
  --security-opt seccomp=deploy/seccomp/chromium.json --security-opt no-new-privileges \
  --cap-drop ALL --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m --tmpfs /home/pwuser:rw,nosuid,size=256m \
  --tmpfs /app/.artifacts:rw,nosuid,size=512m \
  --pids-limit 512 --memory 1g --cpus 1.5 \
  --network capture-egress \
  capture-runtime deploy/verify-container.sh

# B) Chromium sandbox smoke + egress-firewall probes (metadata/RFC1918 blocked,
#    public 443 allowed). Same flag set, entrypoint = node:
docker run --rm --entrypoint node \
  --user pwuser --init \
  --security-opt seccomp=deploy/seccomp/chromium.json --security-opt no-new-privileges \
  --cap-drop ALL --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m --tmpfs /home/pwuser:rw,nosuid,size=256m \
  --tmpfs /app/.artifacts:rw,nosuid,size=512m \
  --pids-limit 512 --memory 1g --cpus 1.5 \
  --network capture-egress \
  capture-runtime deploy/verify-capture.mjs
```

Both must print `ALL ... CHECKS PASSED` and exit 0. The egress probes in (B) only
prove blocking once the firewall (below) is installed on the `capture-egress` network.

## Network egress isolation (the real SSRF boundary)
URL/IP checks in the app mitigate but cannot fully prevent browser-level SSRF
(subresources, page `fetch`, and browser-internal DNS are outside our interception;
we additionally disable page-script WebSocket/WebRTC via an init script). The
**final boundary is network-level egress control**:

- attach the container to a dedicated Docker network (`capture-egress`,
  `docker network create --subnet 172.30.99.0/24 capture-egress`);
- install `deploy/egress-firewall.sh` on that network — it denies RFC1918 / loopback /
  link-local / metadata / CGNAT and allows only outbound 80/443 to public addresses,
  with a single deliberate exception for Postgres on the host gateway (`:5432`);
- optionally route through a filtering forward proxy that re-validates destinations.

The firewall rules live in the Docker Linux VM (`DOCKER-USER` chain) and must be
(re)applied per session — see the script header for the exact `nsenter` invocation and
the Docker Desktop restart caveat. `deploy/verify-capture.mjs` confirms the boundary is
live before any real capture.

## Documented limitations
- Chromium performs its own DNS resolution, so app-level DNS-rebinding protection is
  partial for subresources — rely on container egress isolation.
- Native browser networking (QUIC, some prefetch) cannot be fully intercepted by
  route handlers; egress control is authoritative.
- The Chromium in-process sandbox is disabled in the max-hardened profile (D-0022); a
  renderer compromise is then contained by the container (cap-drop ALL,
  no-new-privileges, seccomp, read-only fs, non-root) and the egress firewall, not by
  Chromium's own sandbox.
- We never claim browser SSRF is solved by URL checks alone.

## Verified
Built and verified 2026-07-15 on Docker 29.6.1 (Desktop / WSL2). `verify-container.sh`:
all 15 OS-hardening checks pass. `verify-capture.mjs`: Chromium renders under the full
flag set; egress firewall blocks metadata/RFC1918/host-non-DB and allows public 443.
