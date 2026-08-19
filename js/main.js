// Entry point. Fetches the data, renders it, and wires up whichever of the three modes
// the page was opened in:
//
//   view   default. Read-only, archive buttons open the read-only viewer.
//   edit   public 编辑模式. Anyone may try out results locally; nothing is saved, and
//          the background gets watermarked so an edited screenshot is identifiable.
//   admin  ?admin in the URL. Adds the archive editor, a local draft, and writing
//          data.json straight to disk. Not a security boundary -- a static site cannot
//          have one -- just a separate set of controls.

import { normalize } from './model.js';
import { render } from './render.js';
import { installInteractions, clearAllResults } from './interact.js';
import { openArchiveViewer, installArchiveButtons } from './archive.js';
import { loadBackground, stampEdited } from './watermark.js';

const isAdmin = new URLSearchParams(location.search).has('admin');

const app = {
  data: null,
  mode: isAdmin ? 'admin' : 'view',

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

  if (isAdmin) {
    document.body.classList.add('editing');
    const admin = await import('./admin.js');
    const draft = admin.loadDraft();
    if (draft) app.data = draft;
    render(app);
    admin.initAdmin(app);
  } else {
    buildPublicToolbar();
    render(app);
  }

  installInteractions(app);
  installArchiveButtons(app);
  loadBackground(document.getElementById('bgCanvas'));
}

boot();
