// Admin mode: everything the public page must not do. Loaded only when the page is
// opened with ?admin, and otherwise inert.
//
// Publishing a result is now a single small write to data.json. index.html never
// changes again, so there is no HTML to merge, no markup to rewrite, and nothing that
// can drift between the two pages -- because there is only one page.

import {
  serialize, normalize, emptyArchive, archiveBaseName, teamPlayers, formatPlayer,
  fileNameOf,
} from './model.js';

const CACHE_KEY = 'rengoBracketDraft';
const IDB_NAME = 'rengoAdmin';
const IDB_STORE = 'handles';
const IDB_KEY = 'repoDir';

let app = null;
let repoDir = null;
let editor = null;

export function initAdmin(application) {
  app = application;
  buildToolbar();
  buildEditor();
  app.openArchive = openArchiveEditor;
  app.persist = saveDraft;
  restoreRepoDir();
}

// --- Draft persistence -------------------------------------------------------------
// The page is a static file with no server, so without this every refresh would throw
// away unpublished edits. The draft is the data itself, so a change to the page's
// markup can never invalidate it.

function saveDraft() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(serialize(app.data)));
  } catch (err) {
    console.warn('本地草稿保存失败：', err);
  }
}

export function loadDraft() {
  let saved;
  try { saved = localStorage.getItem(CACHE_KEY); } catch (err) { return null; }
  if (!saved) return null;
  try { return normalize(JSON.parse(saved)); } catch (err) {
    console.warn('本地草稿无法解析，已忽略：', err);
    return null;
  }
}

function discardDraft() {
  if (!confirm('确定丢弃本地草稿并重新载入 data.json 吗？未保存的编辑会全部丢失。')) return;
  try { localStorage.removeItem(CACHE_KEY); } catch (err) { /* nothing to do */ }
  location.reload();
}

// --- Writing to disk ---------------------------------------------------------------
// showDirectoryPicker() needs a secure context with a real origin, which a file:// page
// does not have. Serving the folder (python3 -m http.server) is what enables it. The
// granted handle is kept in IndexedDB, which unlike localStorage can store it.

function fsAvailable() {
  return typeof window.showDirectoryPicker === 'function';
}

function idb(mode, run) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(IDB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(IDB_STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const req = run(open.result.transaction(IDB_STORE, mode).objectStore(IDB_STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    };
  });
}

async function connectRepoDir() {
  if (!fsAvailable()) {
    alert('当前环境无法直接写入磁盘。\n\n请在项目目录下运行 `python3 -m http.server 8000`，'
      + '然后通过 http://localhost:8000/?admin 打开本页。file:// 打开的页面没有真实来源，'
      + '浏览器不会开放文件系统接口。');
    return;
  }
  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'rengoRepo' });
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    alert('选择项目目录失败：' + (err.message || err));
    return;
  }
  // Fail here rather than at save time if this is not the project root.
  try {
    await handle.getFileHandle('data.json');
  } catch (err) {
    alert('所选目录下没有 data.json，请选择项目根目录。');
    return;
  }
  repoDir = handle;
  try { await idb('readwrite', s => s.put(handle, IDB_KEY)); } catch (err) {
    console.warn('目录句柄保存失败（本次会话仍可用）：', err);
  }
  updateStatus();
}

async function restoreRepoDir() {
  if (!fsAvailable()) { updateStatus(); return; }
  try { repoDir = await idb('readonly', s => s.get(IDB_KEY)) || null; } catch (err) {
    repoDir = null;
  }
  updateStatus();
}

// Chrome only shows the permission prompt during a user gesture, so this must be
// reached from a click.
async function canWrite() {
  if (!repoDir) return false;
  try {
    if (await repoDir.queryPermission({ mode: 'readwrite' }) === 'granted') return true;
    return await repoDir.requestPermission({ mode: 'readwrite' }) === 'granted';
  } catch (err) {
    return false;
  }
}

async function writeRepoFile(segments, contents) {
  let dir = repoDir;
  for (const segment of segments.slice(0, -1)) {
    dir = await dir.getDirectoryHandle(segment, { create: true });
  }
  const handle = await dir.getFileHandle(segments[segments.length - 1], { create: true });
  const writable = await handle.createWritable();
  await writable.write(contents);
  await writable.close();
}

function download(contents, filename, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([contents], { type }));
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function beijingTimestamp() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t).value;
  return `${get('year')}/${get('month')}/${get('day')} ${get('hour')}:${get('minute')}`;
}

async function publish() {
  app.data.updated = beijingTimestamp();
  app.changed();
  const json = JSON.stringify(serialize(app.data), null, 2) + '\n';
  if (await canWrite()) {
    try {
      await writeRepoFile(['data.json'], json);
      alert('已写入 data.json，提交推送即可上线。');
      return;
    } catch (err) {
      console.warn('直接写入失败，回退为下载。', err);
    }
  }
  download(json, 'data.json', 'application/json');
  alert('已下载 data.json，请覆盖项目目录中的同名文件。\n\n'
    + '（连接项目目录后可以直接写入，省掉这一步。）');
}

async function reloadFromDisk() {
  if (!confirm('确定用 data.json 的内容覆盖当前编辑状态吗？')) return;
  try {
    const res = await fetch('data.json?t=' + Date.now());
    app.data = normalize(await res.json());
    saveDraft();
    app.changed();
  } catch (err) {
    alert('读取 data.json 失败：' + (err.message || err));
  }
}

// --- Toolbar -----------------------------------------------------------------------

function buildToolbar() {
  const bar = document.getElementById('toolbar');
  bar.innerHTML = `
<button class="primary" data-act="publish">保存到 data.json</button>
<button data-act="connect">连接项目目录</button>
<button data-act="reload">从 data.json 重新载入</button>
<button data-act="print">打印 / 导出 PDF</button>
<button data-act="clear">清空赛果</button>
<button data-act="discard">丢弃本地草稿</button>
<span class="status" id="repoStatus"></span>
<span class="hint">编辑内容会自动存为本地草稿 · 「保存到 data.json」才会真正发布 ·
连接项目目录后可直接写盘（需通过 http://localhost 打开）· 点击队伍记一胜，再点可撤销/反转 ·
棋色联动切换：未定 → 黑/白 → 白/黑</span>`;
  // Assignment rather than addEventListener: this replaces the public toolbar's
  // handler outright, instead of leaving both attached to the same element.
  bar.onclick = e => {
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'publish') publish();
    else if (act === 'connect') connectRepoDir();
    else if (act === 'reload') reloadFromDisk();
    else if (act === 'print') window.print();
    else if (act === 'clear') app.clearResults();
    else if (act === 'discard') discardDraft();
  };
  updateStatus();
}

function updateStatus() {
  const status = document.getElementById('repoStatus');
  const connect = document.querySelector('#toolbar [data-act="connect"]');
  if (!status) return;
  if (!fsAvailable()) {
    status.textContent = '无法写盘（需 http://localhost）';
    status.classList.remove('ok');
    if (connect) connect.disabled = true;
    return;
  }
  status.textContent = repoDir ? '已连接：' + repoDir.name : '未连接项目目录';
  status.classList.toggle('ok', !!repoDir);
  if (connect) connect.textContent = repoDir ? '重新选择目录' : '连接项目目录';
}

// --- Archive editor ----------------------------------------------------------------

let editing = { matchId: null, game: 0 };

function buildEditor() {
  editor = document.createElement('div');
  editor.className = 'modal-overlay';
  editor.style.display = 'none';
  editor.innerHTML = `<div class="modal-box archive-editor">
<button class="modal-close" type="button">&times;</button>
<h3>编辑对局档案</h3>
<div class="archive-tabs" style="display:none"></div>
<label>黑方（每行一位，格式：姓名 [段位]）</label>
<textarea data-field="black" placeholder="HLE2137 [8段]"></textarea>
<label>白方</label>
<textarea data-field="white" placeholder="唐英w [9段, 业6]"></textarea>
<label>对局结果</label>
<input data-field="result" type="text" placeholder="例如：黑中盘胜">
<label>比赛链接</label>
<input data-field="link" type="text" placeholder="https://...">
<label>棋谱</label>
<input type="file" data-upload="sgf">
<div class="current" data-current="sgf"></div>
<label>复盘报告</label>
<input type="file" data-upload="report">
<div class="current" data-current="report"></div>
<div class="modal-actions">
<button class="danger" data-act="clear">清空本轮档案</button>
<button class="primary" data-act="save">保存</button>
</div>
</div>`;
  document.getElementById('modal-root').appendChild(editor);

  editor.addEventListener('click', e => {
    if (e.target === editor || e.target.closest('.modal-close')) { closeEditor(); return; }
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'save') { flushForm(); commit(); closeEditor(); }
    else if (act === 'clear') clearCurrentGame();
    const tab = e.target.closest('.archive-tabs button');
    if (tab) { flushForm(); editing.game = Number(tab.dataset.game); fillForm(); }
  });

  editor.querySelectorAll('[data-upload]').forEach(input => {
    input.addEventListener('change', e => uploadArchiveFile(e.target.dataset.upload, e.target));
  });
}

function currentGame() {
  return app.data.matches[editing.matchId].games[editing.game];
}

function openArchiveEditor(matchId) {
  editing = { matchId, game: 0 };
  const match = app.data.matches[matchId];
  const tabs = editor.querySelector('.archive-tabs');
  if (match.bestOf <= 1) {
    tabs.style.display = 'none';
    tabs.innerHTML = '';
  } else {
    tabs.style.display = 'flex';
    tabs.innerHTML = match.games.map((g, i) =>
      `<button type="button" data-game="${i}">第${i + 1}轮</button>`).join('');
  }
  editor.querySelector('h3').textContent = '编辑对局档案 · ' + matchId;
  fillForm();
  editor.style.display = 'flex';
}

function closeEditor() {
  editor.style.display = 'none';
  editing = { matchId: null, game: 0 };
}

// Prefills 黑方/白方 from the roster whenever the stones are known and the fields are
// still blank, and commits that straight into the data so it is not lost if the editor
// is closed without saving.
function fillForm() {
  const game = currentGame();
  let inferred = false;
  [0, 1].forEach(slot => {
    const color = game.stones[slot];
    if (!color || game.archive[color]) return;
    const lines = teamPlayers(app.data, editing.matchId, slot).map(formatPlayer).join('\n');
    if (lines) { game.archive[color] = lines; inferred = true; }
  });
  if (inferred) commit();

  editor.querySelectorAll('[data-field]').forEach(el => {
    el.value = game.archive[el.dataset.field] || '';
  });
  editor.querySelectorAll('[data-upload]').forEach(el => { el.value = ''; });

  const base = archiveBaseName(editing.matchId, editing.game, app.data.matches[editing.matchId].bestOf);
  showCurrent('sgf', game.archive.sgf, `archive/sgf/${base}.sgf`);
  showCurrent('report', game.archive.report, `archive/report/${base}.pdf`);

  if (app.data.matches[editing.matchId].bestOf > 1) {
    editor.querySelectorAll('.archive-tabs button').forEach(btn => {
      btn.classList.toggle('active', Number(btn.dataset.game) === editing.game);
    });
  }
}

function showCurrent(kind, path, expected) {
  editor.querySelector(`[data-current="${kind}"]`).textContent = path
    ? '当前文件：' + path
    : '尚未登记（上传后将保存为 ' + expected + '）';
}

function flushForm() {
  const game = currentGame();
  editor.querySelectorAll('[data-field]').forEach(el => {
    game.archive[el.dataset.field] = el.value.trim();
  });
}

function commit() {
  app.changed();
}

async function uploadArchiveFile(kind, input) {
  const file = input.files && input.files[0];
  if (!file || !editing.matchId) return;
  const match = app.data.matches[editing.matchId];
  const base = archiveBaseName(editing.matchId, editing.game, match.bestOf);
  const ext = (file.name.split('.').pop() || (kind === 'sgf' ? 'sgf' : 'pdf')).toLowerCase();
  const subdir = kind === 'sgf' ? 'sgf' : 'report';
  const path = `archive/${subdir}/${base}.${ext}`;

  // One field, not a name/path pair: the display name is derived from the path, so the
  // two can no longer disagree the way they did before.
  currentGame().archive[kind] = path;
  commit();
  showCurrent(kind, path, path);

  if (await canWrite()) {
    try {
      await writeRepoFile(['archive', subdir, `${base}.${ext}`], file);
      alert('已写入 ' + path + '，提交即可。');
      return;
    } catch (err) {
      console.warn('直接写入失败，回退为下载。', err);
    }
  }
  download(file, `${base}.${ext}`, file.type || 'application/octet-stream');
  alert('已下载 ' + fileNameOf(path) + '，请放到项目的 ' + subdir + ' 目录：' + path);
}

function clearCurrentGame() {
  if (!confirm('确定清空本轮的全部档案吗？（不会删除已放置的文件）')) return;
  app.data.matches[editing.matchId].games[editing.game].archive = emptyArchive();
  commit();
  fillForm();
}
