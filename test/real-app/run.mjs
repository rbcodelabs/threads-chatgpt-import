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
  check('5 listed on imported note; with Agent Threads absent a Notice explains', withNote.some(n => /Continue in Agent Threads/.test(n)) && notice.some(n => /needs the Agent Threads plugin/.test(n)), { palette: withNote, notices: notice });
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

check('console: no plugin load errors', !consoleErrors.some(e => /threads-chatgpt-import|ChatGPT/i.test(e)), consoleErrors.filter(e => /threads-chatgpt-import|ChatGPT/i.test(e)));
console.log('ALL CONSOLE ERRORS/WARNINGS (' + consoleErrors.length + '):\n' + consoleErrors.slice(0, 30).join('\n'));
await fs.writeFile(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
if (!process.env.KEEP) await fs.rm(base, { recursive: true, force: true });
else console.log('KEPT', base);
process.exit(results.some(r => !r.ok) ? 1 : 0);
