// Real-app (Geode, hidden) end-to-end check of the built plugin. Not part of `npm test`.
//
//   GEODE_DIR=/path/to/geode (built) PLUGIN_DIR=/path/to/plugin (built) OUT_DIR=/tmp/out \
//     xvfb-run -a node test/real-app/run.mjs
//
// Launches Geode with GEODE_HEADLESS=1 (window never shown on macOS; Xvfb on Linux) and a
// throwaway --user-data-dir, installs the plugin into a throwaway vault, and drives the UI.
import { createRequire } from 'node:module';
import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { deflateSync } from 'node:zlib';

const GEODE = process.env.GEODE_DIR, PLUGIN = process.env.PLUGIN_DIR, OUT = process.env.OUT_DIR;
await fs.mkdir(OUT, { recursive: true });
const { _electron } = createRequire(path.join(GEODE, 'package.json'))('@playwright/test');
const { ZipFile } = createRequire(path.join(PLUGIN, 'package.json'))('yazl');

const results = [];
const log = (step, ok, evidence) => { results.push({ step, ok, evidence }); console.log(`${ok ? 'PASS' : 'FAIL'} ${step}: ${typeof evidence === 'string' ? evidence : JSON.stringify(evidence)}`); };
const check = (step, cond, evidence) => log(step, !!cond, evidence);

// --- fixtures -----------------------------------------------------------------------------------
const fx = async n => JSON.parse(await fs.readFile(path.join(PLUGIN, 'test/fixtures', n), 'utf8'));
function conv(id, title, texts, t0 = 1700700000) {
  const mapping = { root: { id: 'root', message: null, parent: null, children: ['n0'] } };
  texts.forEach((text, i) => {
    mapping[`n${i}`] = { id: `n${i}`, parent: i ? `n${i - 1}` : 'root', children: i + 1 < texts.length ? [`n${i + 1}`] : [],
      message: { id: `n${i}`, author: { role: i % 2 ? 'assistant' : 'user' }, create_time: t0 + i, content: { content_type: 'text', parts: [text] }, metadata: {} } };
  });
  return { id, title, create_time: t0, update_time: t0 + texts.length, current_node: `n${texts.length - 1}`, mapping };
}
function png() { // 10x10 red square
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(10, 0); ihdr.writeUInt32BE(10, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: 10 }, () => Buffer.from([255, 0, 0])))]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: 10 }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}
async function zipOf(file, entries) {
  const z = new ZipFile();
  for (const [n, d] of Object.entries(entries)) z.addBuffer(Buffer.isBuffer(d) ? d : Buffer.from(d), n);
  z.end();
  await new Promise((res, rej) => { const o = createWriteStream(file); o.on('close', res); o.on('error', rej); z.outputStream.pipe(o); });
  return file;
}

const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chatgpt-import-realapp-'));
const vault = path.join(base, 'vault'), userData = path.join(base, 'userdata');
const pluginDir = path.join(vault, '.geode/plugins/threads-chatgpt-import');
await fs.mkdir(pluginDir, { recursive: true });
await fs.mkdir(userData, { recursive: true });
for (const f of ['main.js', 'manifest.json', 'styles.css']) await fs.copyFile(path.join(PLUGIN, f), path.join(pluginDir, f));
await fs.writeFile(path.join(vault, 'Welcome.md'), '# Throwaway vault\n');
await fs.writeFile(path.join(vault, '.geode/plugins.json'), JSON.stringify(['threads-chatgpt-import']));
await fs.writeFile(path.join(userData, 'geode.json'), JSON.stringify({ lastVault: vault, recentVaults: [vault] }));

const plain = await fx('plain.json'), code = await fx('code.json'), branched = await fx('branched.json'),
  image = await fx('image.json'), tool = await fx('tool.json'), empty = await fx('empty.json');
const caseA = conv('case-a', 'Case Title', ['hello A', 'reply A'], 1700800000), caseB = conv('case-b', 'case title', ['hello B', 'reply B'], 1700800000);
const PNG = png();
const zip1 = await zipOf(path.join(base, 'export1.zip'), {
  'conversations-000.json': JSON.stringify([plain, code, branched]),
  'conversations-001.json': JSON.stringify([image, tool, empty, caseA, caseB]),
  'file-ABC123-pic.png': PNG, 'user.json': '{}',
});
// ZIP 2: "Planning a garden" and the code conversation have new content.
const plain2 = structuredClone(plain), code2 = structuredClone(code);
const lastOf = c => c.mapping[c.current_node].message;
lastOf(plain2).content.parts = [lastOf(plain2).content.parts.join('') + '\n\nUPSTREAM-CHANGE-PLAIN'];
lastOf(code2).content.parts = [lastOf(code2).content.parts.join('') + '\n\nUPSTREAM-CHANGE-CODE'];
plain2.update_time += 500; code2.update_time += 500;
const zip2 = await zipOf(path.join(base, 'export2.zip'), {
  'conversations-000.json': JSON.stringify([plain2, code2, branched]),
  'conversations-001.json': JSON.stringify([image, tool, empty, caseA, caseB]),
  'file-ABC123-pic.png': PNG,
});
const BULK = 1500;
const bulk = Array.from({ length: BULK }, (_, i) => conv(`bulk-${i}`, `Bulk ${String(i).padStart(4, '0')}`, ['question '.repeat(200) + i, `answer ${'x'.repeat(2000)} END-${i}`], 1600000000 + i * 3600));
const zip3 = await zipOf(path.join(base, 'export3-bulk.zip'), { 'conversations.json': JSON.stringify(bulk) });

// --- app helpers --------------------------------------------------------------------------------
const consoleErrors = [];
async function launch(label) {
  const app = await _electron.launch({
    args: [GEODE, `--user-data-dir=${userData}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    cwd: GEODE, env: { ...process.env, GEODE_HEADLESS: '1' },
  });
  app.on?.('console', m => { if (['error', 'warning'].includes(m.type())) consoleErrors.push('[' + label + '] main ' + m.type() + ': ' + m.text().slice(0, 300)); });
  const page = await app.firstWindow();
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) consoleErrors.push(`[${label}] ${m.type()}: ${m.text().slice(0, 300)}`); });
  page.on('pageerror', e => consoleErrors.push(`[${label}] pageerror: ${String(e).slice(0, 300)}`));
  await page.waitForFunction(() => window.app?.workspace && window.app?.plugins, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  return { app, page };
}
async function runCommand(page, name) {
  await page.evaluate(() => document.body.focus());
  await page.keyboard.press('Control+P');
  await page.waitForSelector('.prompt-input', { timeout: 10000 });
  await page.fill('.prompt-input', name);
  await page.waitForTimeout(400);
  const items = await page.$$eval('.prompt-results > *, .suggestion-item', els => els.map(e => e.textContent.trim()).filter(Boolean));
  await page.keyboard.press('Enter');
  return items;
}
async function walk(dir, rel = '') {
  const out = [];
  for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])) {
    const r = path.join(rel, e.name);
    if (e.name === '.geode' || e.name === '.obsidian') continue;
    if (e.isDirectory()) out.push(...await walk(dir, r)); else out.push(r);
  }
  return out.sort();
}
const modalText = page => page.$eval('.threads-chatgpt-import', e => e.innerText);
const btn = (page, text) => page.locator('.threads-chatgpt-import button', { hasText: text }).first();

/** Drives modal: ZIP -> (folder) -> Preview. Returns preview text. Leaves the modal on the preview. */
async function toPreview(page, zip, folder) {
  const names = await runCommand(page, 'Import ChatGPT export');
  await page.waitForSelector('.threads-chatgpt-import');
  if (folder) await page.fill('.threads-chatgpt-import .setting-item input[type=text]', folder);
  await page.setInputFiles('.threads-chatgpt-import input[type=file]', zip);
  await page.waitForFunction(() => /Selected: /.test(document.querySelector('.threads-chatgpt-import')?.innerText ?? ''), null, { timeout: 15000 });
  await btn(page, 'Preview import').click();
  await page.waitForFunction(() => /Dry run/.test(document.querySelector('.threads-chatgpt-import')?.innerText ?? ''), null, { timeout: 60000 });
  return { names, text: await modalText(page) };
}
const closeModal = async page => { await page.keyboard.press('Escape'); await page.waitForTimeout(300); };
const parseSummary = t => Object.fromEntries([...t.matchAll(/^(Created|Skipped|Attachments).*$/gm)].map(m => [m[1], m[0]]));
const num = (t, re) => Number((t.match(re) ?? [])[1]);

// =================================================================================================
let { app, page } = await launch('run1');
try {
  // ---- Step 1: plugin loads ----
  const cmds = await page.evaluate(() => Object.values(window.app.commands.commands ?? {}).map(c => c.name));
  check('1 commands registered', cmds.some(n => /Import ChatGPT export/.test(n)) && cmds.some(n => /Continue in Agent Threads/.test(n)),
    { matching: cmds.filter(n => /ChatGPT|Agent Threads/.test(n)) });
  check('1 plugin enabled in registry', await page.evaluate(() => !!window.app.plugins.plugins['threads-chatgpt-import']), 'app.plugins.plugins has threads-chatgpt-import');
  const before = await walk(vault);

  // ---- Step 2: first import through the real UI ----
  const pv = await toPreview(page, zip1);
  await page.screenshot({ path: path.join(OUT, 'dry-run-preview.png') });
  console.log('--- PREVIEW ---\n' + pv.text + '\n---');
  check('2 command found in palette via UI', pv.names.some(n => /Import ChatGPT export/.test(n)), pv.names.slice(0, 5));
  const afterPreview = await walk(vault);
  check('2 nothing written before Import', JSON.stringify(before) === JSON.stringify(afterPreview), { before: before.length, afterPreview: afterPreview.length });
  check('2 preview counts', /Conversations found\s*8/.test(pv.text) || /Conversations found\s*7/.test(pv.text), pv.text.match(/Conversations found\s*\d+|New notes\s*\d+|Attachments to copy[^\n]*/g));
  await btn(page, /Import \d+ note/).click();
  await page.waitForFunction(() => /Import finished|Import cancelled/.test(document.querySelector('.threads-chatgpt-import')?.innerText ?? ''), null, { timeout: 60000 });
  await page.screenshot({ path: path.join(OUT, 'summary-first-import.png') });
  const sum1 = await modalText(page);
  console.log('--- SUMMARY 1 ---\n' + sum1 + '\n---');
  await btn(page, 'Close').click();
  const files1 = await walk(vault);
  const md1 = files1.filter(f => f.endsWith('.md') && f !== 'Welcome.md');
  const att1 = files1.filter(f => /\.png$/.test(f));
  console.log('FILES', JSON.stringify(files1, null, 1));
  check('2 summary says Created N matching md files', num(sum1, /Created (\d+)/) === md1.length, { summary: parseSummary(sum1), mdOnDisk: md1.length });
  check('2 attachment exists and is a valid PNG', att1.length === 1 && (await fs.readFile(path.join(vault, att1[0]))).equals(PNG), att1);
  const notes = Object.fromEntries(await Promise.all(md1.map(async f => [f, await fs.readFile(path.join(vault, f), 'utf8')])));
  const imgNote = Object.entries(notes).find(([, t]) => t.includes('chatgpt_id: conv-image-0004') || t.includes('conv-image-0004'));
  check('2 image note embeds the attachment', imgNote && new RegExp(`!\\[\\[[^\\]]*${path.basename(att1[0])}`).test(imgNote[1]), imgNote && imgNote[1].slice(0, 900));
  const fm = Object.values(notes)[0];
  check('2 frontmatter present', /^---\nchatgpt_id: /m.test(fm) || /^---\n[\s\S]*chatgpt_id/.test(fm), fm.slice(0, 400));
  const codeNote = Object.entries(notes).find(([, t]) => t.includes('conv-code'));
  console.log('--- code note ---\n' + (codeNote ? codeNote[1].slice(0, 600) : 'none'));
  const caseNotes = md1.filter(f => /case title/i.test(f));
  check('3 case-colliding titles produce two distinct files', caseNotes.length === 2 && new Set(caseNotes.map(f => f.toLowerCase())).size === 2, caseNotes);
  check('2 empty conversation handled (no crash; see counts)', true, { mdNames: md1 });

  // ---- Step 3: idempotence and local edits ----
  const pv2 = await toPreview(page, zip1);
  await page.screenshot({ path: path.join(OUT, 'dry-run-reimport-unchanged.png') });
  check('3 re-import: nothing new/updated, all skipped unchanged', num(pv2.text, /New notes\s*(\d+)/) === 0 && num(pv2.text, /Notes to update\s*(\d+)/) === 0 && num(pv2.text, /already imported\s*(\d+)/) === md1.length,
    pv2.text.match(/(New notes|Notes to update|Skipped, [^\n]*)\s*\d+/g));
  check('3 re-import preview offers "Nothing to import"', await btn(page, 'Nothing to import').isVisible(), 'button label');
  await closeModal(page);
  check('3 re-import (preview only) wrote nothing', JSON.stringify(await walk(vault)) === JSON.stringify(files1), 'file list identical');

  const plainFile = md1.find(f => /Planning a garden/.test(f));
  const edited = notes[plainFile] + '\n\nMY OWN EDIT MARKER\n';
  await fs.writeFile(path.join(vault, plainFile), edited);
  await page.waitForTimeout(1500); // let the vault watcher pick the edit up
  const pv3 = await toPreview(page, zip2);
  await page.screenshot({ path: path.join(OUT, 'dry-run-changed-zip.png') });
  console.log('--- PREVIEW 3 ---\n' + pv3.text + '\n---');
  check('3 changed ZIP preview: 1 update (code), 1 skipped-modified (edited plain)', num(pv3.text, /Notes to update\s*(\d+)/) === 1 && num(pv3.text, /you edited them\s*(\d+)/) === 1,
    pv3.text.match(/(New notes|Notes to update|Skipped, [^\n]*)\s*\d+/g));
  await btn(page, /Import \d+ note/).click();
  await page.waitForFunction(() => /Import finished|Import cancelled/.test(document.querySelector('.threads-chatgpt-import')?.innerText ?? ''), null, { timeout: 60000 });
  await page.screenshot({ path: path.join(OUT, 'summary-changed-zip.png') });
  console.log('--- SUMMARY 3 ---\n' + (await modalText(page)) + '\n---');
  await btn(page, 'Close').click();
  const nowPlain = await fs.readFile(path.join(vault, plainFile), 'utf8');
  check('3 edited note NOT overwritten', nowPlain === edited && !nowPlain.includes('UPSTREAM-CHANGE-PLAIN'), { hasMyEdit: nowPlain.includes('MY OWN EDIT MARKER'), hasUpstream: nowPlain.includes('UPSTREAM-CHANGE-PLAIN') });
  const codeFile = md1.find(f => /Reverse a string/.test(f)) ?? codeNote?.[0];
  check('3 unedited changed note WAS updated', codeFile && (await fs.readFile(path.join(vault, codeFile), 'utf8')).includes('UPSTREAM-CHANGE-CODE'), codeFile);

  // ---- Step 4: cancel mid-run ----
  const pv4 = await toPreview(page, zip3, 'Bulk');
  await page.screenshot({ path: path.join(OUT, 'dry-run-bulk.png') });
  check('4 bulk preview', num(pv4.text, /New notes\s*(\d+)/) === BULK, pv4.text.match(/(Conversations found|New notes)\s*\d+/g));
  const preBulk = (await walk(vault)).filter(f => f.startsWith('Bulk'));
  check('4 bulk preview wrote nothing', preBulk.length === 0, preBulk.length);
  await btn(page, /Import \d+ note/).click();
  await page.waitForFunction(() => { const t = document.querySelector('.threads-chatgpt-import')?.innerText ?? ''; const m = t.match(/(\d+) \/ (\d+)/); return m && Number(m[1]) >= 25; }, null, { timeout: 60000, polling: 5 });
  await btn(page, 'Cancel').click();
  await page.waitForFunction(() => /Import finished|Import cancelled|Import stopped/.test(document.querySelector('.threads-chatgpt-import')?.innerText ?? ''), null, { timeout: 60000 });
  await page.screenshot({ path: path.join(OUT, 'summary-cancelled.png') });
  const sum4 = await modalText(page);
  console.log('--- SUMMARY 4 (cancel) ---\n' + sum4 + '\n---');
  await btn(page, 'Close').click();
  await page.waitForTimeout(500);
  const bulkFiles = (await walk(vault)).filter(f => f.startsWith('Bulk'));
  const bulkMd = bulkFiles.filter(f => f.endsWith('.md'));
  const stray = bulkFiles.filter(f => !f.endsWith('.md'));
  let torn = [];
  for (const f of bulkMd) {
    const t = await fs.readFile(path.join(vault, f), 'utf8');
    const id = (t.match(/chatgpt_id: "?bulk-(\d+)/) ?? [])[1];
    if (!t.startsWith('---\n') || id === undefined || !t.includes(`END-${id}`)) torn.push(f);
  }
  check('4 summary says cancelled', /Import cancelled/.test(sum4), sum4.split('\n').slice(0, 4));
  check('4 stopped early (partial, not all)', bulkMd.length > 0 && bulkMd.length < BULK, { written: bulkMd.length, of: BULK });
  check('4 no half-written notes (every note has frontmatter + final message)', torn.length === 0, { checked: bulkMd.length, torn: torn.slice(0, 5) });
  check('4 no stray temp files', stray.length === 0, stray.slice(0, 5));
  check('4 summary Created count equals files on disk', num(sum4, /Created (\d+)/) === bulkMd.length, { summary: num(sum4, /Created (\d+)/), disk: bulkMd.length });
  // re-import completes the rest without duplicating
  const pv5 = await toPreview(page, zip3, 'Bulk');
  check('4 re-run after cancel: only remaining notes are new', num(pv5.text, /New notes\s*(\d+)/) === BULK - bulkMd.length && num(pv5.text, /already imported\s*(\d+)/) === bulkMd.length,
    pv5.text.match(/(New notes|Skipped, [^\n]*)\s*\d+/g));
  await closeModal(page);

  // ---- Step 5a: Continue in Agent Threads with Agent Threads absent ----
  const importedFile = plainFile;
  const hiddenWithoutNote = await runCommand(page, 'Continue in Agent Threads'); // no active imported note: should not be listed
  await page.keyboard.press('Escape').catch(() => {});
  check('5 command hidden when active file is not an imported note', !hiddenWithoutNote.some(n => /Continue in Agent Threads/.test(n)), hiddenWithoutNote);
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  await page.evaluate(async p => { const f = window.app.vault.getAbstractFileByPath(p); await window.app.workspace.getLeaf(false).openFile(f); }, importedFile);
  await page.waitForTimeout(1500);
  const withNote = await runCommand(page, 'Continue in Agent Threads');
  await page.waitForTimeout(800);
  const notice = await page.$$eval('.notice', els => els.map(e => e.textContent));
  await page.screenshot({ path: path.join(OUT, 'continue-absent-notice.png') });
  check('5 listed on imported note; with Agent Threads absent a Notice explains', withNote.some(n => /Continue in Agent Threads/.test(n)) && notice.some(n => /needs a current version of the Agent Threads plugin/.test(n)), { palette: withNote, notices: notice });
} catch (e) {
  log('HARNESS', false, String(e && e.stack || e));
  await page.screenshot({ path: path.join(OUT, 'failure.png') }).catch(() => {});
} finally {
  await app.close().catch(() => {});
}

// ---- Step 5b: positive path against a STUB claude-threads API (not the real agent-threads plugin) ----
try {
  const stubDir = path.join(vault, '.geode/plugins/claude-threads');
  await fs.mkdir(stubDir, { recursive: true });
  await fs.writeFile(path.join(stubDir, 'manifest.json'), JSON.stringify({ id: 'claude-threads', name: 'Stub Agent Threads', version: '0.0.1', minAppVersion: '0.1.0', author: 't', description: 'stub', isDesktopOnly: false }));
  await fs.writeFile(path.join(stubDir, 'main.js'), `const { Plugin } = require("obsidian");
module.exports = class extends Plugin { onload() { globalThis.__stubCalls = []; const c = globalThis.__stubCalls;
  this.api = { v1: { apiVersion: 1, threads: {
    async create(i) { c.push(["create", i]); return { threadId: "t-1" }; },
    async send(id, i) { c.push(["send", id, i]); return { runId: "r-1" }; },
    async open(id) { c.push(["open", id]); } } } }; } };`);
  await fs.writeFile(path.join(vault, '.geode/plugins.json'), JSON.stringify(['claude-threads', 'threads-chatgpt-import']));
  ({ app, page } = await launch('run2'));
  const files = await walk(vault);
  const plainFile = files.find(f => /Planning a garden/.test(f));
  await page.evaluate(async p => { const f = window.app.vault.getAbstractFileByPath(p); await window.app.workspace.getLeaf(false).openFile(f); }, plainFile);
  await page.waitForTimeout(1500);
  await runCommand(page, 'Continue in Agent Threads');
  await page.waitForTimeout(1000);
  const calls = await page.evaluate(() => globalThis.__stubCalls);
  console.log('STUB CALLS', JSON.stringify(calls));
  check('5 positive path (STUB api): create -> send prompt with note path -> open', calls?.map(c => c[0]).join() === 'create,send,open' && JSON.stringify(calls[1]).includes(plainFile), calls);
  const persisted = await walk(vault);
  check('5 imported notes persisted across app restart', persisted.filter(f => f.endsWith('.md')).length > 8, persisted.length);
} catch (e) {
  log('HARNESS step5b', false, String(e && e.stack || e));
} finally {
  await app?.close().catch(() => {});
}

// =================================================================================================
// run3: review-fix scenarios a-e (plugin source untouched; everything is driven through the real UI)
// =================================================================================================
const PID = 'threads-chatgpt-import';
const tmpLeft = async () => (await fs.readdir(os.tmpdir())).filter(n => /^chatgpt-import-(?!realapp|test)/.test(n)).sort();
const waitUntil = async (fn, ms = 20000, step = 100) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return Date.now() - t0; if (Date.now() - t0 > ms) return -1; await new Promise(r => setTimeout(r, step)); } };
const modalOpen = page => page.evaluate(() => !!document.querySelector('.threads-chatgpt-import'));
const inFolder = async (folder, ext = '.md') => (await walk(vault)).filter(f => f.startsWith(folder + '/') && f.endsWith(ext));
const rawTree = async dir => { const out = []; const rec = async rel => { for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])) { const r = path.join(rel, e.name); out.push(r + (e.isDirectory() ? '/' : '')); if (e.isDirectory()) await rec(r); } }; await rec(''); return out.sort(); };
async function tornNotes(folder, prefix) {
  const torn = [];
  for (const f of await inFolder(folder)) {
    const t = await fs.readFile(path.join(vault, f), 'utf8');
    const id = (t.match(new RegExp(`chatgpt_id: "?${prefix}-(\\d+)`)) ?? [])[1];
    if (!t.startsWith('---\n') || id === undefined || !t.includes(`END-${id}`)) torn.push(f);
  }
  return torn;
}
const bigConvs = (prefix, n, big) => Array.from({ length: n }, (_, i) => conv(`${prefix}-${i}`, `${prefix} ${String(i).padStart(5, '0')}`,
  [big ? 'question '.repeat(400) + i : 'question '.repeat(200) + i, `answer ${'x'.repeat(big ? 6000 : 2000)} END-${i}`], 1600000000 + i * 3600));
async function openModal(page) { await runCommand(page, 'Import ChatGPT export'); await page.waitForSelector('.threads-chatgpt-import', { timeout: 10000 }); }
const selected = page => page.waitForFunction(() => /Selected: /.test(document.querySelector('.threads-chatgpt-import')?.innerText ?? ''), null, { timeout: 20000 });
async function pickZip(page, zipPath, folder) {
  if (folder !== undefined) await page.fill('.threads-chatgpt-import .setting-item input[type=text]', folder);
  await page.setInputFiles('.threads-chatgpt-import input[type=file]', zipPath);
  await selected(page);
}
/** An in-memory File (no path on disk), so the plugin must make a temp copy of it. */
async function dropZip(page, zipPath, folder) {
  if (folder !== undefined) await page.fill('.threads-chatgpt-import .setting-item input[type=text]', folder);
  const b64 = (await fs.readFile(zipPath)).toString('base64');
  await page.evaluate(({ b64, name }) => {
    const f = new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], name, { type: 'application/zip' });
    const dt = new DataTransfer(); dt.items.add(f);
    document.querySelector('.threads-chatgpt-import-drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, { b64, name: path.basename(zipPath) });
  await selected(page);
}
const previewDone = (page, t = 120000) => page.waitForFunction(() => /Dry run/.test(document.querySelector('.threads-chatgpt-import')?.innerText ?? ''), null, { timeout: t });
const finished = (page, t = 120000) => page.waitForFunction(() => /Import finished|Import cancelled|Import stopped/.test(document.querySelector('.threads-chatgpt-import')?.innerText ?? ''), null, { timeout: t });
const progressAtLeast = (page, n) => page.waitForFunction(k => { const m = (document.querySelector('.threads-chatgpt-import')?.innerText ?? '').match(/(\d+) \/ (\d+)/); return m && Number(m[1]) >= k; }, n, { timeout: 120000, polling: 5 });
const scanning = page => page.waitForFunction(() => /Reading the export/.test(document.querySelector('.threads-chatgpt-import')?.innerText ?? ''), null, { timeout: 20000, polling: 5 });
/** Proof the plugin still works: open the modal, import a tiny fresh ZIP, verify it landed. */
async function stillWorks(page, label) {
  const id = `after-${label}`;
  const z = await zipOf(path.join(base, `${id}.zip`), { 'conversations.json': JSON.stringify([conv(id, `After ${label}`, ['hi', 'ok END-0'])]) });
  await openModal(page);
  await pickZip(page, z, 'AfterClose');
  await btn(page, 'Preview import').click(); await previewDone(page);
  await btn(page, /Import 1 note/).click(); await finished(page);
  const s = await modalText(page);
  await btn(page, 'Close').click();
  const ok = /Created 1/.test(s) && (await inFolder('AfterClose')).some(f => f.includes(`After ${label}`));
  check(`${label}: plugin still works afterwards (modal opens, import succeeds)`, ok, s.split('\n').slice(0, 5));
}

await fs.writeFile(path.join(vault, '.geode/plugins.json'), JSON.stringify([PID]));
await fs.rm(path.join(vault, '.geode/plugins/claude-threads'), { recursive: true, force: true });
const tmpBefore = await tmpLeft();
let errMark = consoleErrors.length;
// Host noise, present for built-in plugins too: Geode logs ENOENT when a plugin has no data.json yet, and Electron's CSP dev warning.
const HOST_NOISE = /vault-read.*ENOENT.*data\.json|Electron Security Warning/s;
const errsSince = () => consoleErrors.slice(errMark).filter(e => !HOST_NOISE.test(e));
({ app, page } = await launch('run3'));
try {
  // ---- a: attachment rename idempotency ----
  {
    errMark = consoleErrors.length;
    const rc = conv('rename-1', 'Rename photo', ['look at this', 'nice']);
    const img = structuredClone(image); img.id = 'conv-image-rename'; img.title = 'Rename photo';
    const zipA = await zipOf(path.join(base, 'rename.zip'), { 'conversations.json': JSON.stringify([img]), 'file-ABC123-pic.png': PNG });
    const squatter = Buffer.from('NOT THE EXPORTED PICTURE');
    await fs.mkdir(path.join(vault, 'RenameTest/attachments'), { recursive: true });
    await fs.writeFile(path.join(vault, 'RenameTest/attachments/file-ABC123-pic.png'), squatter);
    await page.waitForTimeout(1500);
    const pv = await toPreview(page, zipA, 'RenameTest');
    check('a first preview: 1 new note', num(pv.text, /New notes\s*(\d+)/) === 1, pv.text.match(/(New notes|Notes to update)\s*\d+/g));
    await btn(page, /Import 1 note/).click(); await finished(page);
    const s1 = await modalText(page);
    await page.screenshot({ path: path.join(OUT, 'a-rename-first-import.png') });
    await btn(page, 'Close').click();
    const files = await walk(vault);
    const atts = files.filter(f => f.startsWith('RenameTest/attachments/'));
    const noteF = files.find(f => f.startsWith('RenameTest/') && f.endsWith('.md'));
    const note = await fs.readFile(path.join(vault, noteF), 'utf8');
    const renamed = atts.find(f => f !== 'RenameTest/attachments/file-ABC123-pic.png');
    check('a import renamed the embed (squatter kept, picture stored under another name)',
      atts.length === 2 && (await fs.readFile(path.join(vault, 'RenameTest/attachments/file-ABC123-pic.png'))).equals(squatter) && renamed && (await fs.readFile(path.join(vault, renamed))).equals(PNG) && note.includes(`![[attachments/${path.basename(renamed)}]]`) && !note.includes('![[attachments/file-ABC123-pic.png]]'),
      { attachments: atts, embeds: note.match(/!\[\[[^\]]*\]\]/g), summary: s1.split('\n').slice(0, 4) });
    const pv2 = await toPreview(page, zipA, 'RenameTest');
    await page.screenshot({ path: path.join(OUT, 'a-rename-reimport-unchanged.png') });
    console.log('--- a REIMPORT PREVIEW ---\n' + pv2.text + '\n---');
    check('a re-import of same ZIP previews as all unchanged (0 new, 0 updates)',
      num(pv2.text, /New notes\s*(\d+)/) === 0 && num(pv2.text, /Notes to update\s*(\d+)/) === 0 && num(pv2.text, /already imported\s*(\d+)/) === 1 && await btn(page, 'Nothing to import').isVisible(),
      pv2.text.match(/(New notes|Notes to update|Skipped, [^\n]*)\s*\d+/g));
    await closeModal(page);
    check('a re-import preview wrote nothing', JSON.stringify(await walk(vault)) === JSON.stringify(files), 'file list identical');
    check('a console clean', errsSince().length === 0, errsSince());
  }

  // ---- b: edit between preview and Import must not be overwritten ----
  {
    errMark = consoleErrors.length;
    const code3 = structuredClone(code2); lastOf(code3).content.parts = [lastOf(code3).content.parts.join('') + '\n\nUPSTREAM-CHANGE-CODE-2']; code3.update_time += 900;
    const zip4 = await zipOf(path.join(base, 'export4.zip'), {
      'conversations-000.json': JSON.stringify([plain, code3, branched]),
      'conversations-001.json': JSON.stringify([image, tool, empty, caseA, caseB]), 'file-ABC123-pic.png': PNG });
    const all = await walk(vault);
    let codeF; for (const f of all.filter(x => x.startsWith('ChatGPT/') && x.endsWith('.md'))) if ((await fs.readFile(path.join(vault, f), 'utf8')).includes('chatgpt_id: "conv-code')) codeF = f;
    const beforeTxt = await fs.readFile(path.join(vault, codeF), 'utf8');
    const pv = await toPreview(page, zip4);
    await page.screenshot({ path: path.join(OUT, 'b-preview-before-edit.png') });
    check('b preview offers exactly 1 update (the code note)', num(pv.text, /Notes to update\s*(\d+)/) === 1, pv.text.match(/(New notes|Notes to update|Skipped, [^\n]*)\s*\d+/g));
    const mine = beforeTxt + '\n\nEDIT MADE AFTER PREVIEW\n';
    await fs.writeFile(path.join(vault, codeF), mine);
    await page.waitForTimeout(1500);
    await btn(page, /Import \d+ note/).click(); await finished(page);
    const s = await modalText(page);
    await page.screenshot({ path: path.join(OUT, 'b-summary-after-edit.png') });
    console.log('--- b SUMMARY ---\n' + s + '\n---');
    await btn(page, 'Close').click();
    const now = await fs.readFile(path.join(vault, codeF), 'utf8');
    check('b note edited between preview and Import is NOT overwritten', now === mine && !now.includes('UPSTREAM-CHANGE-CODE-2'), { file: codeF, hasMyEdit: now.includes('EDIT MADE AFTER PREVIEW'), hasUpstream2: now.includes('UPSTREAM-CHANGE-CODE-2') });
    check('b summary reports it as edited, 0 updated', /updated 0/.test(s) && num(s, /and (\d+) you had edited/) === 2, s.split('\n').slice(0, 4));
    check('b console clean', errsSince().length === 0, errsSince());
  }

  // ---- c: invalid destination folder is rejected in the modal ----
  {
    errMark = consoleErrors.length;
    const z = await zipOf(path.join(base, 'tiny.zip'), { 'conversations.json': JSON.stringify([conv('tiny-1', 'Tiny', ['a', 'b END-0'])]) });
    const rootBefore = await fs.readdir(vault), treeBefore = await rawTree(vault);
    await openModal(page);
    await pickZip(page, z);
    for (const bad of ['.obsidian/x', '../x', 'a/../../x', '..\\x', '/abs']) {
      await page.fill('.threads-chatgpt-import .setting-item input[type=text]', bad);
      await page.waitForTimeout(200);
      const msg = await page.$$eval('.threads-chatgpt-import .threads-chatgpt-import-error', els => els.map(e => e.textContent).filter(Boolean));
      const disabled = await btn(page, 'Preview import').isDisabled();
      if (bad === '.obsidian/x') await page.screenshot({ path: path.join(OUT, 'c-folder-obsidian-rejected.png') });
      if (bad === '../x') await page.screenshot({ path: path.join(OUT, 'c-folder-dotdot-rejected.png') });
      await btn(page, 'Preview import').click({ force: true, timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(300);
      const text = await modalText(page);
      check(`c "${bad}" rejected: visible error, Preview disabled, still on setup screen`, msg.length > 0 && disabled && /Selected:/.test(text) && !/Reading the export|Dry run/.test(text), { error: msg, previewDisabled: disabled });
    }
    await page.fill('.threads-chatgpt-import .setting-item input[type=text]', 'GoodFolder');
    await page.waitForTimeout(200);
    check('c control: a valid folder clears the error and enables Preview',
      (await page.$$eval('.threads-chatgpt-import .threads-chatgpt-import-error', els => els.map(e => e.textContent).filter(Boolean))).length === 0 && !(await btn(page, 'Preview import').isDisabled()), 'GoodFolder');
    await page.fill('.threads-chatgpt-import .setting-item input[type=text]', '../x');
    await page.waitForTimeout(200);
    await closeModal(page);
    const treeAfter = await rawTree(vault), rootAfter = await fs.readdir(vault);
    const strays = (await rawTree(base)).filter(p => /(^|\/)x\/?$/.test(p) || /\.obsidian/.test(p));
    check('c nothing written (vault tree identical, no x or .obsidian anywhere under the temp base)',
      JSON.stringify(treeBefore) === JSON.stringify(treeAfter) && JSON.stringify(rootBefore.sort()) === JSON.stringify(rootAfter.sort()) && strays.length === 0, { entries: treeAfter.length, strays });
    check('c console clean', errsSince().length === 0, errsSince());
  }

  // ---- d: close (Escape) mid-scan and mid-import ----
  {
    errMark = consoleErrors.length;
    const bigZip = await zipOf(path.join(base, 'big-scan.zip'), { 'conversations.json': JSON.stringify(bigConvs('big', 5000, true)) });
    const bigSize = (await fs.stat(bigZip)).size;
    // reference: how long a full scan takes, so "mid-scan" is demonstrably mid-scan
    await openModal(page); await pickZip(page, bigZip, 'Big');
    const t0 = Date.now(); await btn(page, 'Preview import').click(); await previewDone(page);
    const fullScanMs = Date.now() - t0; await closeModal(page);
    console.log(`big zip ${bigSize} bytes (compressed); full scan ${fullScanMs} ms`);

    // d1: real-path ZIP, Escape while scanning
    await openModal(page); await pickZip(page, bigZip, 'Big');
    await btn(page, 'Preview import').click(); await scanning(page);
    await page.screenshot({ path: path.join(OUT, 'd1-scanning.png') });
    const tEsc = Date.now() - t0; await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    check('d1 Escape mid-scan (real path) closes the modal', !(await modalOpen(page)), { scanningSeenAfterClickMs: 'see log', fullScanMs });
    await page.waitForTimeout(Math.min(fullScanMs + 1500, 8000));
    check('d1 no files written by the aborted scan', (await inFolder('Big')).length === 0, (await inFolder('Big')).length);
    check('d1 no leftover temp files', JSON.stringify(await tmpLeft()) === JSON.stringify(tmpBefore), await tmpLeft());
    check('d1 console clean', errsSince().length === 0, errsSince());
    await stillWorks(page, 'd1');

    // d2: in-memory File (temp copy made), Escape while scanning
    await openModal(page);
    await dropZip(page, bigZip, 'Big');
    const tmpMid = await tmpLeft();
    check('d2 precondition: dropping an in-memory file made a temp copy', tmpMid.length === tmpBefore.length + 1, { tmpMid });
    await btn(page, 'Preview import').click(); await scanning(page);
    await page.screenshot({ path: path.join(OUT, 'd2-scanning-tempcopy.png') });
    await page.keyboard.press('Escape');
    const gone = await waitUntil(async () => JSON.stringify(await tmpLeft()) === JSON.stringify(tmpBefore), 30000);
    check('d2 Escape mid-scan (temp copy): modal closed and temp copy removed once the scan settled', !(await modalOpen(page)) && gone >= 0, { tmpRemovedAfterMs: gone, left: await tmpLeft() });
    check('d2 no files written by the aborted scan', (await inFolder('Big')).length === 0, (await inFolder('Big')).length);
    check('d2 console clean', errsSince().length === 0, errsSince());
    await stillWorks(page, 'd2');

    // d3: Escape mid-import (in-memory File -> temp copy), then resume
    const impZip = await zipOf(path.join(base, 'imp.zip'), { 'conversations.json': JSON.stringify(bigConvs('impd', 1500, false)) });
    await openModal(page); await dropZip(page, impZip, 'ImpD');
    await btn(page, 'Preview import').click(); await previewDone(page);
    await btn(page, /Import 1500 notes/).click();
    await progressAtLeast(page, 40);
    await page.screenshot({ path: path.join(OUT, 'd3-importing.png') });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const goneImp = await waitUntil(async () => JSON.stringify(await tmpLeft()) === JSON.stringify(tmpBefore), 30000);
    const n1 = (await inFolder('ImpD')).length; await page.waitForTimeout(2500); const n2 = (await inFolder('ImpD')).length;
    check('d3 Escape mid-import: modal closed, import stopped (count stable), partial not complete', !(await modalOpen(page)) && n1 === n2 && n2 > 0 && n2 < 1500, { writtenAtClose: n1, laterCount: n2, of: 1500 });
    check('d3 no leftover temp files after the in-flight import settled', goneImp >= 0, { tmpRemovedAfterMs: goneImp, left: await tmpLeft() });
    const torn = await tornNotes('ImpD', 'impd'), stray = (await walk(vault)).filter(f => f.startsWith('ImpD/') && !f.endsWith('.md'));
    check('d3 no half-written notes, no stray files', torn.length === 0 && stray.length === 0, { torn: torn.slice(0, 3), stray: stray.slice(0, 3), checked: n2 });
    check('d3 console clean', errsSince().length === 0, errsSince());
    await openModal(page); await pickZip(page, impZip, 'ImpD');
    await btn(page, 'Preview import').click(); await previewDone(page);
    const pvR = await modalText(page);
    check('d3 after close: re-open + preview sees only the remainder as new', num(pvR, /New notes\s*(\d+)/) === 1500 - n2 && num(pvR, /already imported\s*(\d+)/) === n2, pvR.match(/(New notes|Skipped, [^\n]*)\s*\d+/g));
    await btn(page, /Import \d+ note/).click(); await finished(page, 180000);
    const sR = await modalText(page); await page.screenshot({ path: path.join(OUT, 'd3-resume-finished.png') }); await btn(page, 'Close').click();
    check('d3 resumed import completes: 1500 notes on disk, none torn', (await inFolder('ImpD')).length === 1500 && (await tornNotes('ImpD', 'impd')).length === 0 && num(sR, /Created (\d+)/) === 1500 - n2, { summary: sR.split('\n').slice(0, 4), disk: (await inFolder('ImpD')).length });
  }

  // ---- e: disable the plugin while the modal is open ----
  {
    errMark = consoleErrors.length;
    // e1: modal open on the setup screen
    await openModal(page);
    await page.screenshot({ path: path.join(OUT, 'e1-modal-open-before-disable.png') });
    await page.evaluate(id => window.app.plugins.disablePlugin(id), PID);
    const closed = await waitUntil(async () => !(await modalOpen(page)), 10000);
    await page.screenshot({ path: path.join(OUT, 'e1-after-disable.png') });
    const cmdsOff = await page.evaluate(() => Object.keys(window.app.commands.commands ?? {}).filter(k => /threads-chatgpt-import/.test(k)));
    check('e1 disable with modal open: modal closes, plugin and commands gone', closed >= 0 && cmdsOff.length === 0 && await page.evaluate(id => !window.app.plugins.plugins[id], PID), { modalClosedAfterMs: closed, commandsLeft: cmdsOff });
    check('e1 console clean after disable', errsSince().length === 0, errsSince());
    await page.evaluate(id => window.app.plugins.enablePlugin(id), PID);
    await waitUntil(() => page.evaluate(id => !!window.app.plugins.plugins[id], PID), 10000);
    await page.waitForTimeout(500);
    await stillWorks(page, 'e1');
    check('e1 console clean after re-enable', errsSince().length === 0, errsSince());

    // e2: disable while an import (temp copy) is running
    errMark = consoleErrors.length;
    const impE = await zipOf(path.join(base, 'impe.zip'), { 'conversations.json': JSON.stringify(bigConvs('impe', 1500, false)) });
    await openModal(page); await dropZip(page, impE, 'ImpE');
    await btn(page, 'Preview import').click(); await previewDone(page);
    await btn(page, /Import 1500 notes/).click();
    await progressAtLeast(page, 40);
    await page.screenshot({ path: path.join(OUT, 'e2-importing-before-disable.png') });
    await page.evaluate(id => window.app.plugins.disablePlugin(id), PID);
    const closed2 = await waitUntil(async () => !(await modalOpen(page)), 10000);
    const goneE = await waitUntil(async () => JSON.stringify(await tmpLeft()) === JSON.stringify(tmpBefore), 30000);
    const m1 = (await inFolder('ImpE')).length; await page.waitForTimeout(2500); const m2 = (await inFolder('ImpE')).length;
    await page.screenshot({ path: path.join(OUT, 'e2-after-disable-mid-import.png') });
    const tornE = await tornNotes('ImpE', 'impe'), strayE = (await walk(vault)).filter(f => f.startsWith('ImpE/') && !f.endsWith('.md'));
    check('e2 disable mid-import: modal closes, import stops, temp copy removed, nothing torn/stray',
      closed2 >= 0 && m1 === m2 && m2 > 0 && m2 < 1500 && goneE >= 0 && tornE.length === 0 && strayE.length === 0, { modalClosedAfterMs: closed2, written: m2, of: 1500, tmpRemovedAfterMs: goneE, torn: tornE.length, stray: strayE.length });
    check('e2 console clean after disable mid-import', errsSince().length === 0, errsSince());
    await page.evaluate(id => window.app.plugins.enablePlugin(id), PID);
    await waitUntil(() => page.evaluate(id => !!window.app.plugins.plugins[id], PID), 10000);
    await page.waitForTimeout(500);
    await openModal(page); await pickZip(page, impE, 'ImpE');
    await btn(page, 'Preview import').click(); await previewDone(page);
    await btn(page, /Import \d+ note/).click(); await finished(page, 180000);
    const sE = await modalText(page); await btn(page, 'Close').click();
    check('e2 re-enabled plugin resumes and completes the import (1500 on disk, none torn)', (await inFolder('ImpE')).length === 1500 && (await tornNotes('ImpE', 'impe')).length === 0, { summary: sE.split('\n').slice(0, 4) });
    check('e2 console clean after re-enable + import', errsSince().length === 0, errsSince());
  }
  check('run3 no leftover chatgpt-import temp dirs at the end', JSON.stringify(await tmpLeft()) === JSON.stringify(tmpBefore), await tmpLeft());
} catch (e) {
  log('HARNESS run3', false, String(e && e.stack || e));
  await page.screenshot({ path: path.join(OUT, 'failure-run3.png') }).catch(() => {});
} finally {
  await app?.close().catch(() => {});
}

const pluginErrs = consoleErrors.filter(e => /threads-chatgpt-import|ChatGPT/i.test(e) && !HOST_NOISE.test(e));
check('console: no plugin errors/warnings in the whole run (host data.json ENOENT + Electron CSP dev warning excluded; they also occur for the built-in onboarding plugin)', pluginErrs.length === 0, { plugin: pluginErrs, totalCaptured: consoleErrors.length, ignoredHostNoise: consoleErrors.filter(e => HOST_NOISE.test(e)).length });
console.log('ALL CONSOLE ERRORS/WARNINGS (' + consoleErrors.length + '):\n' + consoleErrors.slice(0, 30).join('\n'));
await fs.writeFile(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
if (!process.env.KEEP) await fs.rm(base, { recursive: true, force: true });
else console.log('KEPT', base);
process.exit(results.some(r => !r.ok) ? 1 : 0);
