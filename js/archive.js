// Read-only per-game archive viewer. A best-of-1 match shows a single record; the
// final shows one tab per game that actually has content.

import { archiveHasContent, matchHasArchive } from './model.js';
import { esc } from './render.js';

const FIELDS = [
  ['black', '黑方'],
  ['white', '白方'],
  ['result', '对局结果'],
  ['link', '比赛链接'],
  ['sgf', '棋谱'],
  ['report', '复盘报告'],
];

let overlay = null;

function ensureOverlay() {
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'none';
  overlay.innerHTML = `<div class="modal-box">
<button class="modal-close" type="button">&times;</button>
<div class="archive-tabs" style="display:none"></div>
<div class="fields"></div>
</div>`;
  overlay.addEventListener('click', e => {
    if (e.target === overlay || e.target.closest('.modal-close')) close();
  });
  document.getElementById('modal-root').appendChild(overlay);
  return overlay;
}

function close() {
  if (overlay) overlay.style.display = 'none';
}

function renderFields(archive) {
  const rows = FIELDS.map(([key, label]) => {
    const raw = archive[key];
    if (!raw) return '';
    let value;
    if (key === 'link') {
      value = `<a href="${esc(raw)}" target="_blank" rel="noopener">${esc(raw)}</a>`;
    } else if (key === 'sgf' || key === 'report') {
      // Always one of our own repo-relative archive/... paths; a browser never exposes
      // the uploader's real local path, so this cannot leak a personal directory.
      value = `<a href="${esc(raw)}" download>${key === 'sgf' ? '下载棋谱' : '下载报告'}</a>`;
    } else {
      value = esc(raw);
    }
    return `<div class="archive-field"><div class="archive-label">${label}</div>`
      + `<div class="archive-value">${value}</div></div>`;
  });
  overlay.querySelector('.fields').innerHTML = rows.join('');
}

export function openArchiveViewer(app, matchId) {
  const match = app.data.matches[matchId];
  if (!matchHasArchive(match)) return;
  ensureOverlay();

  const rounds = match.games
    .map((g, i) => (archiveHasContent(g.archive) ? i : -1))
    .filter(i => i >= 0);

  const tabs = overlay.querySelector('.archive-tabs');
  if (rounds.length < 2) {
    tabs.style.display = 'none';
    tabs.innerHTML = '';
  } else {
    tabs.style.display = 'flex';
    tabs.innerHTML = rounds.map(i =>
      `<button type="button" data-round="${i}">第${i + 1}轮</button>`).join('');
    tabs.onclick = e => {
      const btn = e.target.closest('button');
      if (!btn) return;
      show(match, Number(btn.dataset.round), rounds);
    };
  }

  show(match, rounds[0], rounds);
  overlay.style.display = 'flex';
}

function show(match, roundIndex, rounds) {
  renderFields(match.games[roundIndex].archive);
  if (rounds.length >= 2) {
    overlay.querySelectorAll('.archive-tabs button').forEach(btn => {
      btn.classList.toggle('active', Number(btn.dataset.round) === roundIndex);
    });
  }
}

// The archive button is rendered by render.js; the click is delegated here so the
// public page and the admin page can route it to the viewer or the editor.
export function installArchiveButtons(app) {
  document.getElementById('bracket').addEventListener('click', e => {
    const btn = e.target.closest('.archive-link button');
    if (!btn) return;
    e.stopPropagation();
    app.openArchive(btn.dataset.match);
  });
}
