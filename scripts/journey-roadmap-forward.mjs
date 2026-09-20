#!/usr/bin/env node
/** Fresh transport acceptance: real CLI derive, then real browser Ctrl+Z.
 * Owns two file-backed homes, Vite and Chrome; all listeners bind port 0.
 * node --import tsx scripts/journey-roadmap-forward.mjs --output /path
 * Optional --source is a public, commit-pinned GitHub roadmap URL.
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { startDaemon } from '../packages/server/src/daemon.ts';
import { writeBadge, adoptIdentity } from '../packages/server/src/badge-store.ts';
import { DaemonClient } from '../packages/api/src/client.ts';
import { harnessVars } from '../packages/api/src/harness.ts';
import { BADGE_COOKIE, parseBadgeToken, CLIENT_FEATURES_HEADER, CANVAS_GROUPS_FEATURE } from '../packages/core/src/index.ts';
import { browser, until, throughTheDoor } from './lib/browser.mjs';
import { navigate, screenshot } from './lib/personal-journey-fixture.mjs';

const option = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const source = option('--source', 'https://github.com/dglazkov/isocan/blob/71741a5c42a7a86ff99042357e5d1c248a835a2d/docs/ROADMAP.md');
const output = path.resolve(option('--output', 'roadmap-forward-evidence'));
const repo = fileURLToPath(new URL('../', import.meta.url));
await fs.mkdir(output, { recursive: true });
process.env.ISOCAN_STORE = 'file';
const proof = { tree: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), source, cases: [] };

async function drive(route) {
  const state = await fs.mkdtemp(path.join(tmpdir(), 'isocan-roadmap-forward-drive-'));
  const owned = [];
  let b, web, listener;
  async function boot(name, birthHome) {
    const home = path.join(state, name);
    const daemon = await startDaemon({ host: '127.0.0.1', port: 0, contentPort: 0, home, birthHome, auth: null, operators: [], homePollMs: 50 });
    owned.push(daemon);
    const port = daemon.app.server.address().port;
    return { daemon, home, port, base: `http://127.0.0.1:${port}` };
  }
  try {
    const writer = await boot('writer', null);
    const endpoint = route === 'forwarded' ? await boot('replica', writer.base) : writer;
    const clientHome = route === 'forwarded' ? endpoint.home : path.join(state, 'direct-client');
    await fs.mkdir(clientHome, { recursive: true });
    // Vite's listen() treats port 0 as its 5173 default. Let Node own the
    // ephemeral listener instead; Vite supplies middleware and HMR only.
    listener = createHttpServer((request, response) => web.middlewares(request, response));
    web = await createServer({ configFile: false, root: path.join(repo, 'packages/web'), plugins: [react()],
      define: { 'import.meta.env.VITE_ISOCAN_PORT': JSON.stringify(String(writer.port)) },
      server: { middlewareMode: true, hmr: { server: listener }, proxy: { '/api': writer.base } },
    });
    await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${listener.address().port}`;
    b = await browser();
    await b.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await navigate(b, origin + '/');
    await throughTheDoor(b, origin, 'Acme Reader', `roadmap-${route}`);
    const actor = await b.ev('JSON.parse(localStorage.getItem("isocan.identity"))');
    const cookies = (await b.send('Network.getCookies', { urls: [origin] })).cookies;
    const badge = parseBadgeToken(cookies.find(cookie => cookie.name === BADGE_COOKIE)?.value ?? '');
    assert(badge, 'owned browser has its synthetic identity');
    // A replica serves agents, not a second browser door. The browser stays
    // at the authoritative home; the CLI receives its identity by a real pass.
    const ownerHome = route === 'direct' ? clientHome : path.join(state, 'browser-owner');
    await writeBadge(ownerHome, writer.base, { ...badge, at: new Date().toISOString() });
    await adoptIdentity(ownerHome, actor);
    const owner = new DaemonClient(writer.base, ownerHome);
    const canvasId = `prj_roadmap_${route}`;
    await owner.sendOp(null, actor, { type: 'project.create', canvasId, title: `Acme ${route} roadmap`, groupMode: 'groups' });
    const client = route === 'direct' ? owner : new DaemonClient(endpoint.base, clientHome);
    if (route === 'forwarded') {
      const pass = await owner.mintPass(canvasId, actor.id);
      await client.redeemPass(pass.token, writer.base, true);
      await client.joinFromHome(canvasId, writer.base);
    }

    // A call-through observer, not a replacement writer or forged response.
    // These are the requests received by the home after any forwarding hop.
    const receivedGroups = [];
    const submit = writer.daemon.engine.submit.bind(writer.daemon.engine);
    writer.daemon.engine.submit = request => {
      if (request.canvasId === canvasId && request.op.type === 'item.add') receivedGroups.push(request.group ?? null);
      return submit(request);
    };
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('ISOCAN_') || harnessVars.includes(key)) delete env[key];
    Object.assign(env, { ISOCAN_HOME: clientHome, ISOCAN_PORT: String(endpoint.port), ISOCAN_DEFAULT_HOME: '', ISOCAN_DEFAULT_HOME_URL: '' });
    if (route === 'direct') env.ISOCAN_DIRECT = writer.base;
    else assert(!Object.hasOwn(env, 'ISOCAN_DIRECT'), 'forwarded control must not use direct mode');
    const args = ['--canvas', canvasId, '--json', 'roadmap', 'add', source, '--at', '0,0'];
    const child = spawn(process.execPath, [path.join(repo, 'packages/cli/bin/isocan.js'), ...args], {
      cwd: clientHome, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data);
    child.stderr.on('data', data => stderr += data);
    const deadline = setTimeout(() => child.kill('SIGKILL'), 120_000);
    try {
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      assert.equal(code, 0, `${route} CLI: ${stderr}`);
    } finally { clearTimeout(deadline); }
    const receipt = JSON.parse(stdout);
    const items = Object.values((await client.snapshot(canvasId)).canvas.items);
    assert.equal(items.length, 111, 'pinned source has 105 rows, five headings and a summary');
    const summary = items.find(item => item.properties['roadmap.key'] === 'summary');
    const group = summary.properties['roadmap.reading'];
    assert.match(group, /^grp_/);
    assert.equal(receivedGroups.length, items.length);
    assert.deepEqual([...new Set(receivedGroups)], [group]);
    const entries = (await writer.daemon.engine.getLog(canvasId)).filter(entry => entry.envelope.op.type !== 'project.create');
    assert.equal(entries.length, items.length);
    assert(entries.every(entry => entry.group === group));
    assert(entries.every(entry => entry.envelope.actor.id === actor.id), 'CLI and browser really act as the same person');

    await navigate(b, `${origin}/p/${canvasId}`);
    await until(b, `!!document.querySelector('[data-item-id="${summary.id}"]')`, `${route} reading is rendered`);
    await screenshot(b, path.join(output, `${route}-before.png`));
    const undos = [];
    await b.send('Network.enable');
    b.on('Network.requestWillBeSent', ({ request }) => {
      if (new URL(request.url).pathname === `/api/projects/${canvasId}/undo` && request.method === 'POST') undos.push(request.url);
    });
    for (const type of ['rawKeyDown', 'keyUp']) await b.send('Input.dispatchKeyEvent', {
      type, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2,
    });
    await until(b, 'document.querySelectorAll(".canvas-page [data-item-id]").length === 0', `${route} empty canvas is rendered`);
    // An independent read is still a groups-capable client, like the app.
    // Never poll a refused legacy-client read and call its refusal a stale UI.
    const observed = await b.ev(`(async () => {
      const response = await fetch('/api/projects/${canvasId}/canvas', { headers: ${JSON.stringify({ [CLIENT_FEATURES_HEADER]: CANVAS_GROUPS_FEATURE })} });
      return { status: response.status, body: await response.json() };
    })()`);
    assert.equal(observed.status, 200, JSON.stringify(observed.body));
    assert.equal(Object.keys(observed.body.canvas.items).length, 0);
    assert.equal(undos.length, 1, 'one real keyboard gesture sent exactly one undo request');
    assert.equal(Object.keys((await writer.daemon.engine.getSnapshot(canvasId)).canvas.items).length, 0);
    await screenshot(b, path.join(output, `${route}-after.png`));
    assert.deepEqual(b.takeErrors(), []);
    return { route, writer: writer.base, client: endpoint.base, directEnvironmentSet: Object.hasOwn(env, 'ISOCAN_DIRECT'),
      commit: receipt.commit, cards: items.length, incomingRequests: receivedGroups.length,
      requestGroup: group, groupedEntries: entries.length, browserUndoRequests: undos.length, remaining: 0,
    };
  } catch (error) {
    if (b) await screenshot(b, path.join(output, `${route}-failure.png`)).catch(() => {});
    await fs.writeFile(path.join(output, `${route}-failure.txt`), `${error.stack}\n`);
    throw error;
  } finally {
    if (b) await b.close();
    if (web) await web.close();
    if (listener?.listening) { listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); }
    for (const daemon of owned.reverse()) { daemon.app.server.closeAllConnections(); await daemon.close(); }
    await fs.rm(state, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
for (const route of ['forwarded', 'direct']) {
  proof.cases.push(await drive(route));
  await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(proof, null, 2) + '\n');
}
console.log(JSON.stringify(proof, null, 2));
