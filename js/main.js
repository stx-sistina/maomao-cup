// Entry point. Fetches the data, renders it, and wires up whichever of the three modes
// the page was opened in:
//
//   view   default. Read-only, archive buttons open the read-only viewer.
//   edit   public 编辑模式. Anyone may try out results locally; nothing is saved, and
//          the background gets watermarked so an edited screenshot is identifiable.
//   admin  ?admin in the URL, behind a passphrase. Adds the archive editor, a local
//          draft, and writing data.json straight to disk.
//
// The passphrase is emphatically not a security boundary: the check below runs in the
// visitor's own browser, in code they already have, so anyone willing to open the
// developer console can import js/admin.js directly and skip it. It exists to stop
// somebody stumbling into the editor by guessing at the URL. What actually protects
// the published bracket is push access to the repository, which lives on GitHub and
// has nothing to do with this file.

import { normalize } from './model.js';
import { render } from './render.js';
import { installInteractions, clearAllResults } from './interact.js';
import { openArchiveViewer, installArchiveButtons } from './archive.js';
import { loadBackground, stampEdited } from './watermark.js';

const isAdmin = new URLSearchParams(location.search).has('admin');

// SHA-256 of the admin passphrase. Storing the digest rather than the passphrase only
// keeps it from being read straight off the page; it is not resistant to a guessing
// attack, since the digest is public and unsalted.
const ADMIN_HASH = '5b265ae76c8f59b017deb523ab708f5bf32ac69016f8b2a35b85f8d4c23ee272';
const UNLOCK_KEY = 'rengoAdminUnlocked';

const app = {
  data: null,
  mode: 'view',

  // Re-render from the data, then let the active mode persist it if it wants to.
  changed() {
    render(app);
    app.persist();
  },
  // Replaced by admin mode; in the public modes edits are deliberately transient.
  persist() {},
  openArchive(matchId) { openArchiveViewer(app, matchId); },
  clearResults() { clearAllResults(app); },
};

function buildPublicToolbar() {
  const bar = document.getElementById('toolbar');
  if (app.mode === 'edit') {
    bar.innerHTML = `
<button data-act="exit">回到官方结果</button>
<button data-act="print">打印 / 导出 PDF</button>
<button data-act="clear">清空赛果</button>
<span class="hint">可直接编辑选手名与段位 · 点击队伍设置/取消胜者，点击对手可反转 ·
晋级队伍自动填入下一轮 · 棋色联动切换：未定 → 黑/白 → 白/黑 ·
本地改动不会影响官方页面，刷新即还原</span>`;
  } else {
    bar.innerHTML = `<button data-act="enter">编辑模式</button>`;
  }
  bar.onclick = e => {
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'enter') enterEditMode();
    else if (act === 'exit') location.reload();
    else if (act === 'print') window.print();
    else if (act === 'clear') app.clearResults();
  };
}

function enterEditMode() {
  app.mode = 'edit';
  document.body.classList.add('edit-mode', 'editing');
  buildPublicToolbar();
  render(app);
  stampEdited(document.getElementById('bgCanvas'));
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

// Remembered for the tab's lifetime, so a refresh mid-editing does not re-prompt. The
// stored value is the expected digest, so changing the passphrase invalidates it.
async function unlockAdmin() {
  try {
    if (sessionStorage.getItem(UNLOCK_KEY) === ADMIN_HASH) return true;
  } catch (err) { /* private browsing can refuse sessionStorage */ }

  // crypto.subtle only exists in a secure context, i.e. https or localhost.
  if (!window.crypto || !crypto.subtle) {
    alert('无法校验口令：本页需通过 https 或 http://localhost 打开。');
    return false;
  }
  const input = prompt('请输入管理口令：');
  if (input === null) return false;
  if (await sha256Hex(input) !== ADMIN_HASH) {
    alert('口令不正确。');
    return false;
  }
  try { sessionStorage.setItem(UNLOCK_KEY, ADMIN_HASH); } catch (err) { /* fine */ }
  return true;
}

async function enterAdminMode() {
  if (!await unlockAdmin()) return;   // stays in the read-only public view
  app.mode = 'admin';
  document.body.classList.add('editing');
  const admin = await import('./admin.js');
  const draft = admin.loadDraft();
  if (draft) app.data = draft;
  render(app);
  admin.initAdmin(app);
}

function showLoadError(err) {
  document.getElementById('bracket').innerHTML =
    `<div style="padding:40px;line-height:1.7">
<strong>无法载入 data.json。</strong><br>
本页需要通过 http:// 打开才能读取数据文件。<br>
本地预览请在项目目录下运行 <code>python3 -m http.server 8000</code>，
再访问 <code>http://localhost:8000/</code>。
<div style="color:#8a3a3a;margin-top:12px">${err}</div></div>`;
}

async function boot() {
  let raw;
  try {
    raw = await fetch('data.json', { cache: 'no-cache' }).then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  } catch (err) {
    showLoadError(err.message || err);
    return;
  }
  app.data = normalize(raw);

  // Render the public view first so the page looks finished behind the passphrase
  // dialog, and so a failed unlock simply leaves the visitor on the normal page.
  buildPublicToolbar();
  render(app);
  installInteractions(app);
  installArchiveButtons(app);
  loadBackground(document.getElementById('bgCanvas'));

  if (isAdmin) await enterAdminMode();
}

boot();
