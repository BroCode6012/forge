#!/usr/bin/env node
'use strict';

/**
 * Regression gate for the 2026-07-31 Lightning GPU incident.
 *
 * WHAT HAPPENED
 *   The vision GPU is published through a Cloudflare NAMED tunnel at a fixed hostname
 *   (LIGHTNING_VISION_URL). The domain was moved off Cloudflare, which deleted the zone
 *   that held the `vision` CNAME. The tunnel stayed connected and healthy; the hostname
 *   simply stopped resolving.
 *
 *   The app could not tell those two apart. `_waitModel()` returned a bare boolean, so
 *   "I cannot reach the address" and "the model failed to load" were the same value.
 *   Consequences, all observed in app-2026-07-31T14-08-09-991Z-34340.log:
 *     1. It waited the full 15-minute model timeout on a name that resolves to nothing.
 *     2. It then STOPPED a T4 whose vLLM had been serving on :8000 the whole time.
 *     3. It marked the failure retryable, so it rotated through the account pool and
 *        repeated — 6 attempts x ~20 min of paid GPU for a failure no account could fix.
 *     4. A working no-domain fallback existed and was never reached, because
 *        CF_TUNNEL_TOKEN being SET was treated as the endpoint being WORKING.
 *   The build never got past Step 5; zero scenes received footage.
 *
 * WHAT IS LOCKED IN HERE
 *   A. A dead hostname is reported unreachable; a live-but-not-serving one is not.
 *   B. Not-one-address-answered is a different outcome from model-never-loaded, and only
 *      the latter may rotate accounts.
 *   C. The Python helper verifies an address instead of trusting it, and can fall back to
 *      Lightning's own port (no domain, no DNS, no third party) or a no-domain tunnel.
 *   D. A direct address belonging to a different Studio is never reused.
 *
 * No network and no Lightning credentials are used: A probes only literal-IP/reserved
 * hostnames, and the rest is asserted structurally.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

let failures = 0;
let checks = 0;
function check(label, fn) {
    checks++;
    try {
        fn();
        console.log(`  ✓ ${label}`);
    } catch (err) {
        failures++;
        console.log(`  ✗ ${label}\n      ${err.message}`);
    }
}
async function checkAsync(label, fn) {
    checks++;
    try {
        await fn();
        console.log(`  ✓ ${label}`);
    } catch (err) {
        failures++;
        console.log(`  ✗ ${label}\n      ${err.message}`);
    }
}

const boxSrc = fs.readFileSync(path.join(ROOT, 'src', 'vision', 'lightning-box.js'), 'utf8');
const pySrc = fs.readFileSync(path.join(ROOT, 'src', 'lightning-control.py'), 'utf8');

(async () => {
    console.log('\n[gpu-endpoint-resilience] A. a dead address is distinguishable from a slow one');

    process.env.VISION_BACKEND = process.env.VISION_BACKEND || 'lightning';
    const box = require(path.join(ROOT, 'src', 'vision', 'lightning-box.js'));

    await checkAsync('probeEndpoint is exported', async () => {
        assert.strictEqual(typeof box.probeEndpoint, 'function', 'expected probeEndpoint export');
    });

    await checkAsync('a hostname that cannot resolve reports reachable:false', async () => {
        // .invalid is reserved by RFC 2606 and can never resolve — no network needed.
        // Generous timeout ON PURPOSE: this check is about the REASON, not the speed.
        // A slow resolver returning NXDOMAIN in >3s made the probe abort first, and the
        // check then failed with ECONNABORTED — a flaky gate over a healthy code path.
        const p = await box.probeEndpoint('https://gpu.this-name-cannot-exist.invalid/v1', 20000);
        assert.strictEqual(p.ready, false, 'a dead name must never look ready');
        assert.strictEqual(p.reachable, false,
            `a name that does not resolve must be reachable:false, got ${p.reason}`);
    });

    await checkAsync('a reachable address that is not serving reports reachable:true', async () => {
        // 127.0.0.1 on a closed port resolves fine and refuses the connection. That is a live
        // address with nothing behind it yet — exactly what a booting GPU looks like — and it
        // must NOT be confused with a dead hostname.
        const p = await box.probeEndpoint('http://127.0.0.1:1/v1', 3000);
        assert.strictEqual(p.ready, false);
        assert.strictEqual(p.reachable, true,
            `a resolvable address must stay reachable:true so the model gets its full load time, got ${p.reason}`);
    });

    await checkAsync('an empty URL is unreachable, not ready', async () => {
        const p = await box.probeEndpoint('', 1000);
        assert.strictEqual(p.ready, false);
        assert.strictEqual(p.reachable, false);
    });

    check('the probe only treats DNS failures as dead', () => {
        assert.ok(/ENOTFOUND/.test(boxSrc) && /EAI_AGAIN/.test(boxSrc),
            'expected both DNS error codes to be handled');
        assert.ok(/const dead = code === 'ENOTFOUND' \|\| code === 'EAI_AGAIN';/.test(boxSrc),
            'only a name-resolution failure may mark an address dead — a refused/reset/timeout '
            + 'connection is a booting GPU and must keep waiting');
    });

    check('validateStatus is disabled so a 404/502 is a reading, not an exception', () => {
        assert.ok(/validateStatus: \(\) => true/.test(boxSrc),
            'without this, a 502 from a live tunnel throws and looks identical to a dead name');
    });

    console.log('\n[gpu-endpoint-resilience] B. never destroy a healthy GPU, never rotate for a global fault');

    check('_waitModel returns sawAddress alongside ready', () => {
        assert.ok(/function _waitModel\(log, candidates\)/.test(boxSrc),
            '_waitModel must take the candidate address list');
        assert.ok(/return \{ ready: true, url, sawAddress: true \}/.test(boxSrc),
            'a successful wait must report which address won');
        assert.ok(/sawAddress: false/.test(boxSrc),
            'the "no address answered" outcome must be representable');
    });

    check('a bare boolean can no longer be returned from _waitModel', () => {
        const body = boxSrc.match(/async function _waitModel\([\s\S]*?\n\}/);
        assert.ok(body, 'could not locate _waitModel');
        assert.ok(!/\n\s*return (true|false);/.test(body[0]),
            'returning a bare boolean is the original bug — it collapses "unreachable" into '
            + '"model broken"');
    });

    check('_waitModel gives up early when no address ever answers', () => {
        assert.ok(/LIGHTNING_NO_ADDRESS_MS/.test(boxSrc),
            'expected a short no-address deadline so a dead name does not burn the full model timeout');
        const body = boxSrc.match(/async function _waitModel\([\s\S]*?\n\}/)[0];
        assert.ok(/if \(!sawAddress && Date\.now\(\) - t0 >= noAddressMs\)/.test(body),
            'the early bail must require that NOTHING was reachable — never bail while an '
            + 'address is alive and the model is still loading');
    });

    check('the no-address outcome is non-retryable and flagged global', () => {
        const body = boxSrc.match(/async function _startWith\([\s\S]*?\n\}\n/)[0];
        assert.ok(/if \(!wait\.sawAddress\) \{/.test(body),
            '_startWith must branch on the no-address case');
        const branch = body.match(/if \(!wait\.sawAddress\) \{[\s\S]*?\n    \}/)[0];
        assert.ok(/retryable: false/.test(branch), 'a dead address cannot heal by retrying');
        assert.ok(/globalFailure: true/.test(branch), 'it must be marked as not-this-account');
    });

    check('the rotation stops on a global failure and does not strike the account', () => {
        const loop = boxSrc.match(/if \(res\.globalFailure === true\) \{[\s\S]*?\n            \}/);
        assert.ok(loop, 'expected a globalFailure short-circuit inside the rotation loop');
        assert.ok(/return \{ ok: false, reason: res\.reason, retryable: false \}/.test(loop[0]),
            'a global failure must end the rotation immediately');
        assert.ok(!/markFailure/.test(loop[0]),
            'an account must not be penalised for a fault that is not its own — markFailure '
            + 'strikes it and can exhaust it for the whole cycle');
        // The short-circuit has to come BEFORE the rotate-to-next path, or it never runs.
        assert.ok(boxSrc.indexOf('res.globalFailure === true') < boxSrc.indexOf('rotation.markFailure(acct'),
            'the globalFailure check must precede markFailure/rotation');
    });

    check('the single-account path also refuses to retry a global failure', () => {
        assert.ok(/retryable: res\.retryable !== false && res\.globalFailure !== true/.test(boxSrc),
            'the .env fallback path must honour globalFailure too, or the outer 6-attempt loop '
            + 'still burns six wake-ups');
    });

    check('a ready model is never stopped', () => {
        const body = boxSrc.match(/async function _startWith\([\s\S]*?\n\}\n/)[0];
        const readyIdx = body.indexOf('if (wait.ready)');
        const stopIdx = body.indexOf("_runPy('stop'");
        assert.ok(readyIdx > -1 && stopIdx > readyIdx,
            'the ready branch must return before any stop can run — stopping a serving GPU is '
            + 'the exact loss this gate exists to prevent');
    });

    check('every address the helper found is polled, not just the first', () => {
        assert.ok(/const candidates = \[r\.url, \.\.\.\(Array\.isArray\(r\.altUrls\) \? r\.altUrls : \[\]\)\]/.test(boxSrc),
            'the backup addresses must be polled alongside the primary');
        assert.ok(/if \(wait\.url && wait\.url !== _v1\(r\.url\)\)/.test(boxSrc) && /_applyUrl\(wait\.url, log\)/.test(boxSrc),
            'when a backup wins, the vision endpoint must be repointed at it');
    });

    console.log('\n[gpu-endpoint-resilience] C. the helper verifies an address instead of trusting it');

    check('the configured hostname is resolution-checked before use', () => {
        assert.ok(/def host_resolves\(url\):/.test(pySrc), 'expected a host_resolves helper');
        assert.ok(/socket\.getaddrinfo\(host, None\)/.test(pySrc), 'expected a real DNS lookup');
        assert.ok(/if fixed and not host_resolves\(fixed\):/.test(pySrc),
            'CF_TUNNEL_TOKEN being set must no longer be treated as the endpoint working');
    });

    check('Lightning\'s own port is available as the no-domain backup', () => {
        assert.ok(/def native_port_url\(studio, port=8000\):/.test(pySrc), 'expected native_port_url');
        assert.ok(/studio\.list_ports\(\)/.test(pySrc) && /studio\.add_ports\(\{"vision": port\}\)/.test(pySrc),
            'it must reuse an existing exposed port before creating one');
        assert.ok(/native = native_port_url\(s\)/.test(pySrc),
            'the direct address must be resolved on every start so it is always in hand');
    });

    check('the direct address is handed back as a backup, not only as a replacement', () => {
        assert.ok(/"altUrls": \[u for u in \[native\] if u and u != fixed\]/.test(pySrc),
            'the named-tunnel result must carry the direct address as a backup');
        assert.ok(/"altUrls": \[u for u in \[native\] if u and u != url\]/.test(pySrc),
            'the quick-tunnel result must carry it too');
    });

    check('a no-domain tunnel is started when every address fails', () => {
        assert.ok(/rm -f \$HOME\/\.cf-tunnel-token; pkill -f 'cloudflared tunnel run'/.test(pySrc),
            'the named tunnel must be dropped so a quick (no-domain) tunnel can come up');
        assert.ok(/token push warning|printf %s/.test(pySrc),
            'the token must still be re-pushed on the next start so this self-heals');
    });

    check('total address failure is reported as global, not as this account failing', () => {
        const tail = pySrc.match(/"error": "no reachable address for the GPU[\s\S]{0,200}/);
        assert.ok(tail, 'expected the all-addresses-failed emit');
        assert.ok(/"retryable": False/.test(tail[0]) && /"globalFailure": True/.test(tail[0]),
            'it must be non-retryable and flagged global so the rotation stops');
    });

    check('the Node side forwards globalFailure from the helper', () => {
        assert.ok(/globalFailure: r\.globalFailure === true/.test(boxSrc),
            'the helper\'s globalFailure must survive into the rotation decision');
    });

    console.log('\n[gpu-endpoint-resilience] D. one Studio\'s direct address is never reused for another');

    check('a foreign Lightning direct address is rejected', () => {
        assert.ok(/LITNG_HOST_RE = re\.compile\(r"\\\.cloudspaces\\\.litng\\\.ai\\b", re\.I\)/.test(pySrc),
            'expected a pattern that recognises a Lightning direct address');
        assert.ok(/if fixed and LITNG_HOST_RE\.search\(fixed\) and same_endpoint\(fixed, native\) is False:/.test(pySrc),
            'a persisted direct address must be dropped unless THIS studio just confirmed it. '
            + 'It resolves perfectly while pointing at the wrong machine, so it would answer '
            + '404 forever and look like a slow model.');
    });

    check('the comparison ignores the /v1 suffix the app appends', () => {
        assert.ok(/def same_endpoint\(a, b\):/.test(pySrc), 'expected same_endpoint');
        assert.ok(/u\[:-3\]\.rstrip\("\/"\) if u\.lower\(\)\.endswith\("\/v1"\) else u/.test(pySrc),
            'the app persists the /v1 form but the SDK returns the bare host — without '
            + 'normalising, a studio would reject its OWN address');
    });

    console.log('\n[gpu-endpoint-resilience] E. a backup address is probed the way vLLM actually serves');

    check('every candidate address is normalised to the /v1 base before probing', () => {
        assert.ok(/function _v1\(rawUrl\)/.test(boxSrc), 'expected a single _v1() normaliser');
        assert.ok(/\.filter\(Boolean\)\.map\(_v1\)/.test(boxSrc),
            'the wait loop must normalise its candidates. vLLM serves /v1/models, never /models — '
            + 'probing a bare host answers 404 forever, which reads as "the model never loaded" '
            + 'and gets a healthy, fully-paid-for GPU shut down.');
        assert.ok(/const full = _v1\(rawUrl\);/.test(boxSrc),
            '_applyUrl must use the same normaliser so stored and probed addresses agree');
    });

    check('the probe asks for the models list relative to that base', () => {
        assert.ok(/\$\{url\.replace\(\/\\\/\+\$\/, ''\)\}\/models/.test(boxSrc),
            'the probe appends /models, so it must be handed the /v1 base');
    });

    check('switching to a backup is only announced when it really is a different address', () => {
        assert.ok(/wait\.url !== _v1\(r\.url\)/.test(boxSrc),
            'the primary is raw and the winner is normalised — comparing them unnormalised '
            + 'would claim a backup takeover on every single successful start');
    });

    check('the helper\'s diagnostics are forwarded in full, not just the last line', () => {
        assert.ok(!/onProgress\(line\.split\(\/\\r\?\\n\/\)\.filter\(Boolean\)\.pop\(\)\)/.test(boxSrc),
            'keeping only the tail of each chunk hides why a start behaved as it did '
            + '("address does not resolve", "falling back to the direct address")');
        assert.ok(/let errBuf = '';/.test(boxSrc) && /pumpErr\('', true\)/.test(boxSrc),
            'expected a line buffer that holds a split line and flushes on close');
    });

    check('_v1 is idempotent and slash-tolerant', () => {
        const v1 = new Function('rawUrl', `${boxSrc.match(/function _v1\(rawUrl\)\s*\{[\s\S]*?\n\}/)[0]}\nreturn _v1(rawUrl);`);
        assert.equal(v1('https://h.example'), 'https://h.example/v1');
        assert.equal(v1('https://h.example/'), 'https://h.example/v1');
        assert.equal(v1('https://h.example/v1'), 'https://h.example/v1');
        assert.equal(v1('https://h.example/v1/'), 'https://h.example/v1');
    });

    console.log(`\n[gpu-endpoint-resilience] ${checks - failures}/${checks} checks passed`);
    if (failures) {
        console.log(`[gpu-endpoint-resilience] FAILED — ${failures} check(s)\n`);
        process.exit(1);
    }
    console.log('[gpu-endpoint-resilience] OK\n');
})().catch((err) => {
    console.error('[gpu-endpoint-resilience] CRASHED:', err);
    process.exit(1);
});
