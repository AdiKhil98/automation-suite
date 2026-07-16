// In-container Chromium sandbox smoke + egress-firewall probes. Run inside the
// hardened container (see docs/deploy/hardened-browser.md). Exits non-zero on failure.
import { chromium } from 'playwright';
import net from 'node:net';
import https from 'node:https';

let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) fail = 1;
};

// --- 1. Chromium renders under the FULL hardening ---
// Uses the same CAPTURE_CHROMIUM_SANDBOX posture the app uses. In the max-hardened
// container this is `false` (--cap-drop ALL + no-new-privileges make the in-process
// sandbox unable to initialize; the container + egress firewall are the authoritative
// boundary — D-0022). A successful render here proves capture works under every
// hardening flag; the in-process sandbox posture is reported for transparency.
const wantSandbox = process.env.CAPTURE_CHROMIUM_SANDBOX === 'true';
try {
  const browser = await chromium.launch({ chromiumSandbox: wantSandbox, args: ['--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.goto('data:text/html,<h1 id="ok">rendered</h1>', { waitUntil: 'load' });
  const text = await page.locator('#ok').textContent();
  await page.screenshot({ path: '/tmp/render-smoke.png' });
  const fs = await import('node:fs');
  let sawNoSandbox = false;
  for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (cmd.includes('chrom') && cmd.split('\0').includes('--no-sandbox')) sawNoSandbox = true;
    } catch { /* process exited */ }
  }
  check('chromium-render', text === 'rendered', 'page rendered under full hardening + screenshot to tmpfs');
  // The posture must match config: in-process sandbox off ⇒ --no-sandbox expected.
  check('chromium-sandbox-posture', sawNoSandbox === !wantSandbox, `in-process sandbox=${String(wantSandbox)}; --no-sandbox present=${String(sawNoSandbox)} (container+egress is the boundary)`);
  await browser.close();
} catch (err) {
  check('chromium-render', false, String(err).slice(0, 300));
}

// --- 2. Egress firewall probes ---
const tryConnect = (host, port, timeoutMs = 4000) =>
  new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: timeoutMs });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('timeout', () => { s.destroy(); resolve(false); });
    s.on('error', () => resolve(false));
  });

// Must be BLOCKED: cloud metadata, RFC1918 samples, host gateway (non-DB port).
check('egress-block-metadata', !(await tryConnect('169.254.169.254', 80)), '169.254.169.254:80');
check('egress-block-rfc1918-10', !(await tryConnect('10.255.255.1', 80)), '10.255.255.1:80');
check('egress-block-rfc1918-192', !(await tryConnect('192.168.1.1', 80)), '192.168.1.1:80');
check('egress-block-rfc1918-172', !(await tryConnect('172.16.0.1', 80)), '172.16.0.1:80');
const hostGw = process.env.HOST_GATEWAY_IP;
if (hostGw) {
  check('egress-block-hostgw-80', !(await tryConnect(hostGw, 80)), `${hostGw}:80 (host, non-DB port)`);
  if (process.env.EXPECT_DB_ALLOWED === 'true') {
    check('egress-allow-hostgw-5432', await tryConnect(hostGw, 5432), `${hostGw}:5432 (Postgres exception)`);
  }
}

// Must be ALLOWED: public 443.
const publicOk = await new Promise((resolve) => {
  const req = https.get('https://example.com/', { timeout: 8000 }, (res) => {
    res.resume();
    resolve(res.statusCode !== undefined && res.statusCode < 500);
  });
  req.on('timeout', () => { req.destroy(); resolve(false); });
  req.on('error', () => resolve(false));
});
check('egress-allow-public-443', publicOk, 'https://example.com');

console.log('---');
console.log(fail === 0 ? 'ALL CAPTURE-RUNTIME CHECKS PASSED' : 'CAPTURE-RUNTIME CHECKS FAILED');
process.exit(fail);
