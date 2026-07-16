#!/bin/sh
# Egress firewall for the capture container network (the authoritative SSRF boundary,
# see docs/deploy/hardened-browser.md). Runs INSIDE the Docker Linux VM / host:
#
#   Get-Content deploy/egress-firewall.sh | docker run --rm -i --privileged --pid=host `
#     justincormack/nsenter1 /bin/sh -s -- 172.30.99.0/24 <host-gateway-ip>
#
# Idempotent (flushes + re-creates its own chain). NOTE (Docker Desktop): rules live in
# the Desktop Linux VM and do NOT survive a Docker Desktop restart — re-run before
# every capture session and verify with deploy/verify-capture.mjs.
set -eu
SUBNET="${1:?usage: egress-firewall.sh <capture-subnet> <host-gateway-ip>}"
HOST_GW="${2:?usage: egress-firewall.sh <capture-subnet> <host-gateway-ip>}"
CHAIN=CAPTURE-EGRESS

iptables -N "$CHAIN" 2>/dev/null || true
iptables -F "$CHAIN"

# Single deliberate exception: Postgres on the host (pipeline DB writes).
iptables -A "$CHAIN" -d "$HOST_GW/32" -p tcp --dport 5432 -j ACCEPT

# Deny private / loopback / link-local / metadata / CGNAT destinations.
iptables -A "$CHAIN" -d 127.0.0.0/8 -j REJECT
iptables -A "$CHAIN" -d 10.0.0.0/8 -j REJECT
iptables -A "$CHAIN" -d 172.16.0.0/12 -j REJECT
iptables -A "$CHAIN" -d 192.168.0.0/16 -j REJECT
iptables -A "$CHAIN" -d 169.254.0.0/16 -j REJECT
iptables -A "$CHAIN" -d 100.64.0.0/10 -j REJECT

# Allow only web ports to public addresses (TCP only; QUIC falls back to TCP).
iptables -A "$CHAIN" -p tcp --dport 80 -j ACCEPT
iptables -A "$CHAIN" -p tcp --dport 443 -j ACCEPT

# Default deny everything else from the capture network.
iptables -A "$CHAIN" -j REJECT

# Route capture-network traffic through the chain (idempotent insert).
iptables -D DOCKER-USER -s "$SUBNET" -j "$CHAIN" 2>/dev/null || true
iptables -I DOCKER-USER 1 -s "$SUBNET" -j "$CHAIN"

echo "capture egress firewall installed for $SUBNET (db exception: $HOST_GW:5432)"
iptables -S "$CHAIN"
