# Hardened browser runtime (production capture)

Playwright's official Docker image is a **base/runtime dependency, not a complete
security boundary** for browsing untrusted prospect websites. Real external captures
must run in a hardened, network-isolated container. The local Windows Chromium
install is for controlled local fixtures and development debugging only — **do not
browse real untrusted prospect sites from the Windows host.**

## Image
`deploy/Dockerfile.capture` is based on `mcr.microsoft.com/playwright:v1.61.1-noble`
(tag pinned to the `playwright` package version). It runs as the non-root `pwuser`
and keeps the Chromium sandbox enabled (never `--no-sandbox`).

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
  --tmpfs /app/.artifacts:rw,nosuid,size=512m \
  --pids-limit 512 \
  --memory 1g --cpus 1.5 \
  --network capture-egress \
  capture-runtime --campaign <name>
```

- **Non-root + `no-new-privileges` + `cap-drop ALL`** — least privilege.
- **`--init`** — reaps zombie Chromium child processes.
- **Chromium seccomp profile** — use Playwright's recommended profile (a good default
  is the upstream `chrome.json` seccomp profile). Keep the sandbox on.
- **`--read-only` root fs + tmpfs** — isolated writable dirs only; artifacts to a
  bounded tmpfs or a mounted volume (never a host dir with other data).
- **Resource limits** — CPU/memory/PID/execution-time caps.
- **Do NOT** use `--network host`, **do NOT** mount the Docker socket, **do NOT**
  mount credentials or unrelated host directories.

## Network egress isolation (the real SSRF boundary)
URL/IP checks in the app mitigate but cannot fully prevent browser-level SSRF
(subresources, page `fetch`, and browser-internal DNS are outside our interception;
we additionally disable page-script WebSocket/WebRTC via an init script). The
**final boundary is network-level egress control**:

- attach the container to a dedicated Docker network with an **egress firewall** that
  denies RFC1918 / loopback / link-local / metadata (169.254.169.254, fd00:ec2::254)
  and reserved ranges;
- allow only outbound 80/443 to public addresses;
- optionally route through a filtering forward proxy that re-validates destinations.

## Documented limitations
- Chromium performs its own DNS resolution, so app-level DNS-rebinding protection is
  partial for subresources — rely on container egress isolation.
- Native browser networking (QUIC, some prefetch) cannot be fully intercepted by
  route handlers; egress control is authoritative.
- We never claim browser SSRF is solved by URL checks alone.
