#!/usr/bin/env node
/** Real CLI + pointer-driven browser acceptance, on an owned home and Vite.
 * Public reads only; no live canvas, token, daemon or timer is borrowed.
 * node --import tsx scripts/journey-roadmap.mjs --repository owner/repo --output /path
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { startDaemon } from '../packages/server/src/daemon.ts';
import { writeBadge, adoptIdentity } from '../packages/server/src/badge-store.ts';
import { DaemonClient } from '../packages/api/src/client.ts';
import { harnessVars } from '../packages/api/src/harness.ts';
import { BADGE_COOKIE, parseBadgeToken } from '../packages/core/src/index.ts';
import { browser, until, throughTheDoor } from './lib/browser.mjs';
import { click, navigate, screenshot } from './lib/personal-journey-fixture.mjs';
const option = name => process.argv[process.argv.indexOf(name) + 1];
const repository = process.argv.includes('--repository') ? option('--repository') : null;
assert(repository, 'Pass --repository owner/repository: this walk reads a real public roadmap');
const output = path.resolve(process.argv.includes('--output') ? option('--output') : 'roadmap-evidence');
await fs.mkdir(output, { recursive: true });
const state = await fs.mkdtemp(path.join(tmpdir(), 'isocan-roadmap-journey-'));
const repo = fileURLToPath(new URL('../', import.meta.url));
process.env.ISOCAN_STORE = 'file';
// Below the ephemeral range: a busy host may have exhausted port-0 bindings.
const ownedPort = 20_000 + Math.floor(Math.random() * 8_000);
const daemon = await startDaemon({ host: '127.0.0.1', port: ownedPort, home: path.join(state, 'daemon'), birthHome: null, auth: null, operators: [], contentPort: 'off', servesWorld: true });
const port = daemon.app.server.address().port;
const base = `http://127.0.0.1:${port}`;
const web = await createServer({ configFile: false, root: path.join(repo, 'packages/web'), plugins: [react()], define: { 'import.meta.env.VITE_ISOCAN_PORT': JSON.stringify(String(port)) }, server: { host: '127.0.0.1', port: ownedPort + 1, strictPort: true, proxy: { '/api': base } } });
await web.listen();
const origin = `http://127.0.0.1:${web.httpServer.address().port}`;
const b = await browser();
const clientHome = path.join(state, 'client');
await fs.mkdir(clientHome);
const proof = { source: repository, daemon: base, web: origin, checks: [] };
async function cli(args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('ISOCAN_') || harnessVars.includes(key)) delete env[key];
  Object.assign(env, { ISOCAN_HOME: clientHome, ISOCAN_DIRECT: base, ISOCAN_PORT: String(port), ISOCAN_DEFAULT_HOME_URL: '' });
  const child = spawn(process.execPath, [path.join(repo, 'packages/cli/bin/isocan.js'), ...args], { cwd: clientHome, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
  const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
  try { const code = await new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); }); return { code, stdout, stderr }; }
  finally { clearTimeout(timer); }
}
try {
  await b.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await navigate(b, origin + '/');
  await throughTheDoor(b, origin, 'Acme Reader', 'roadmap-journey');
  const actor = await b.ev('JSON.parse(localStorage.getItem("isocan.identity"))');
  const cookies = (await b.send('Network.getCookies', { urls: [origin] })).cookies;
  const badge = parseBadgeToken(cookies.find(c => c.name === BADGE_COOKIE)?.value ?? '');
  assert(badge, 'owned browser has a synthetic badge');
  await writeBadge(clientHome, base, { ...badge, at: new Date().toISOString() });
  await adoptIdentity(clientHome, actor);
  const client = new DaemonClient(base, clientHome);
  const canvasId = 'prj_roadmap_web';
  await client.sendOp(null, actor, { type: 'project.create', canvasId, title: 'Acme roadmap', groupMode: 'groups' });
  await navigate(b, `${origin}/p/${canvasId}`);
  await until(b, '!!document.querySelector(".canvas-page")', 'canvas mounted');
  await b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 });
  await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 });
  await click(b, '.palette-field');
  await b.send('Input.insertText', { text: 'Add…' });
  await until(b, 'document.querySelector(".palette-row")?.textContent.includes("Add…")', 'Add command found');
  await click(b, '.palette-row');
  await click(b, '.add-popover input');
  await b.send('Input.insertText', { text: `https://github.com/${repository}` });
  await until(b, 'document.querySelector(".add-preview")?.textContent.includes("Derive")', 'shared recogniser names the roadmap');
  await screenshot(b, path.join(output, '01-recognition.png'));
  await click(b, '.add-popover button[type="submit"]');
  await until(b, '!document.querySelector(".add-popover") || !!document.querySelector(".site-error")', 'public roadmap import settled', 120_000);
  assert.equal(await b.ev('document.querySelector(".site-error")?.textContent ?? null'), null);
  const snapshot = await client.snapshot(canvasId);
  const items = Object.values(snapshot.canvas.items);
  const summary = items.find(item => item.properties['roadmap.key'] === 'summary');
  assert(summary, 'summary exists after actual Add submit');
  const commit = summary.properties['roadmap.commit'];
  const rawUrl = `https://raw.githubusercontent.com/${repository}/${commit}/docs/ROADMAP.md`;
  const raw = await (await fetch(rawUrl, { signal: AbortSignal.timeout(20_000) })).text();
  // Independent count/link witness: read the generator's rows, not the parser under test.
  const rows = [...raw.matchAll(/^\| (?:research|\*\*project\*\*) \| \[([^\]]+)\]\(([^)]+)\) \| ([^|]*) \| (.*) \|$/gm)];
  const rowItems = items.filter(item => item.properties['roadmap.key'].startsWith('row:'));
  assert(rows.length > 0);
  assert.equal(rowItems.length, rows.length);
  const documentBase = `https://github.com/${repository}/blob/${commit}/docs/ROADMAP.md`;
  for (const row of rows) {
    const link = new URL(row[2], documentBase).href;
    assert(rowItems.some(item => item.title === row[1] && item.properties.source === link), `row reaches its exact document: ${row[1]}`);
  }
  assert(items.every(item => item.properties['roadmap.commit'] === commit && item.properties.synced === summary.properties.synced));
  await screenshot(b, path.join(output, '02-imported-canvas.png'));
  proof.commit = commit; proof.blobSha = summary.properties['roadmap.blob']; proof.rows = rows.length; proof.cards = items.length;
  proof.checks.push('Browser Add recognised GitHub and landed every source row at one commit');
  console.log('PASS browser import:', rows.length, 'rows at', commit);
  const row = rowItems[0];
  await navigate(b, `${origin}/p/${canvasId}/w/${row.id}`);
  await until(b, '!!document.querySelector(".artifact-stage .md-view h1")', 'the row words are actually rendered');
  const view = await b.ev(`(() => { const h=document.querySelector('.artifact-stage .md-view h1'); const r=h.getBoundingClientRect(); return {text:h.textContent,visible:r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight,editors:document.querySelectorAll('.stage-editor-slot,.stage-rail.left,.cm-editor').length,links:[...document.querySelectorAll('.artifact-stage a')].map(a=>({text:a.textContent,href:a.href}))}; })()`);
  assert.equal(view.text, row.title); assert(view.visible); assert.equal(view.editors, 0);
  assert(view.links.some(link => link.href === row.properties.source));
  await screenshot(b, path.join(output, '03-read-only-row.png'));
  assert.deepEqual(b.takeErrors(), []);
  await click(b, `.artifact-stage a[href="${row.properties.source}"]`);
  await until(b, `location.href === ${JSON.stringify(row.properties.source)} && document.readyState === 'complete'`, 'pointer click navigated to the pinned source', 30_000);
  await screenshot(b, path.join(output, '04-pinned-source.png'));
  const docPath = new URL(row.properties.source).pathname.split('/').slice(5).join('/');
  const document = await (await fetch(`https://raw.githubusercontent.com/${repository}/${commit}/${docPath}`, { signal: AbortSignal.timeout(20_000) })).text();
  assert(/^#\s+\S/m.test(document), 'the followed source has a document heading, not just an HTTP 200');
  // Remote GitHub scripts are not part of the app's exception ledger.
  b.takeErrors();
  await navigate(b, `${origin}/p/${canvasId}/w/${row.id}`);
  proof.checks.push('Visible row, no editor, actual pointer click opens commit-pinned source containing a document heading');
  const refused = await cli(['--canvas', canvasId, 'set', row.id, '--title', 'Invented status']);
  assert.notEqual(refused.code, 0); assert.match(refused.stderr, /derived.*source/i);
  assert.deepEqual((await client.snapshot(canvasId)).canvas.items[row.id], row);
  proof.checks.push('CLI content-edit attempt refused and entire persisted item unchanged');
  console.log('PASS pinned source click and refused CLI edit');
  const issue = view.links.find(link => /\/issues\/\d+$/.test(link.href));
  assert(issue, 'the first source row in this fixture names an issue');
  await until(b, '!!document.querySelector(".artifact-stage .md-view h1")', 'return from source');
  await click(b, `.artifact-stage a[href="${issue.href}"]`);
  await until(b, `location.href === ${JSON.stringify(issue.href)} && document.readyState === 'complete'`, 'real issue link followed', 30_000);
  await screenshot(b, path.join(output, '06-named-issue.png'));
  b.takeErrors();
  const noIssue = rows.find(sourceRow => !sourceRow[4].includes('/issues/'));
  assert(noIssue);
  const noIssueItem = rowItems.find(item => item.title === noIssue[1]);
  await navigate(b, `${origin}/p/${canvasId}/w/${noIssueItem.id}`);
  await until(b, '!!document.querySelector(".artifact-stage .md-view h1")', 'row with no issue renders');
  assert.equal(await b.ev(`document.querySelectorAll('.artifact-stage a[href*="/issues/"]').length`), 0);
  proof.checks.push('Actual pointer opens the named issue; an unlinked row has no invented issue anchor');
  const ordinaryPath = path.join(state, 'ordinary.md');
  await fs.writeFile(ordinaryPath, '# Acme editable control\n\nThese words were authored here.\n');
  const ordinaryAdd = await cli(['--canvas', canvasId, '--json', 'add', ordinaryPath]);
  assert.equal(ordinaryAdd.code, 0, ordinaryAdd.stderr);
  const ordinaryId = JSON.parse(ordinaryAdd.stdout).itemId;
  await navigate(b, `${origin}/p/${canvasId}/w/${ordinaryId}`);
  await until(b, 'document.querySelector(".cm-editor .cm-content")?.textContent.includes("Acme editable control")', 'same actor gets the loaded editor and its source text');
  await screenshot(b, path.join(output, '07-editor-positive-control.png'));
  const ordinaryEdit = await cli(['--canvas', canvasId, 'set', ordinaryId, '--title', 'Acme changed locally']);
  assert.equal(ordinaryEdit.code, 0, ordinaryEdit.stderr);
  assert.equal((await client.snapshot(canvasId)).canvas.items[ordinaryId].title, 'Acme changed locally');
  proof.checks.push('Positive control: same browser/actor gets an ordinary document editor and its CLI edit persists');
  await b.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await navigate(b, `${origin}/p/${canvasId}/i/${row.id}`);
  await until(b, '!!document.querySelector(".md-view h1")', 'phone reading visible');
  assert(await b.ev('document.querySelector(".md-view h1").getBoundingClientRect().right <= innerWidth && document.body.scrollWidth <= innerWidth'), 'phone reading fits without horizontal overflow');
  await screenshot(b, path.join(output, '05-phone-reading.png'));
  proof.checks.push('390px phone reading visibly fits with no horizontal overflow');
  const cliCanvas = 'prj_roadmap_cli';
  await client.sendOp(null, actor, { type: 'project.create', canvasId: cliCanvas, title: 'Acme CLI roadmap', groupMode: 'groups' });
  const added = await cli(['--canvas', cliCanvas, '--json', 'roadmap', 'add', `${documentBase}`, '--at', '0,0']);
  assert.equal(added.code, 0, added.stderr);
  const receipt = JSON.parse(added.stdout);
  assert.equal(receipt.commit, commit); assert.equal(receipt.rows, rows.length);
  const cliItems = Object.values((await client.snapshot(cliCanvas)).canvas.items);
  assert.equal(cliItems.length, items.length);
  const shape = item => ({ title: item.title, source: item.properties.source, key: item.properties['roadmap.key'] });
  assert.deepEqual(cliItems.map(shape).sort((a,b)=>a.key.localeCompare(b.key)), items.map(shape).sort((a,b)=>a.key.localeCompare(b.key)));
  const undo = await cli(['--canvas', cliCanvas, 'undo']);
  assert.equal(undo.code, 0, undo.stderr);
  assert.equal(Object.keys((await client.snapshot(cliCanvas)).canvas.items).length, 0);
  proof.checks.push('Real roadmap add CLI has browser parity; one real undo removes all imported cards');
  const errors = b.takeErrors();
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof, null, 2));
} catch (error) {
  await screenshot(b, path.join(output, 'failure.png')).catch(() => {});
  await fs.writeFile(path.join(output, 'failure.txt'), `${error.stack}\n${JSON.stringify(b.takeErrors())}\n`);
  throw error;
} finally {
  await b.close(); await web.close(); daemon.app.server.closeAllConnections(); await daemon.close();
  await fs.rm(state, { recursive: true, force: true, maxRetries: 5 });
}
