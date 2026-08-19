// Turns the data into DOM. This is the only place that produces bracket markup, so
// the public view, the public edit mode and the admin page can no longer drift apart:
// they render the same elements and differ only in which handlers are active.

import {
  MATCH_IDS, teamNames, matchWinner, winsFor, decidedCount, matchHasArchive, candidateOf,
} from './model.js';

// --- Layout: the bracket's geometry, written once. Positions are hand-tuned rather
// than computed, so they live in a table instead of being buried in markup twice. ---
export const CANVAS = { w: 1800, h: 880 };
const SIZE = {
  candidate: { w: 220, h: 120 },
  match: { w: 220, h: 112 },
  final: { w: 260, h: 134 },
};
const ARCHIVE_GAP = 6;

const MATCH_LAYOUT = {
  qf1: { x: 270, y: 208 },
  qf2: { x: 270, y: 623 },
  sf1: { x: 520, y: 409 },
  final: { x: 770, y: 398, extraClass: 'final' },
  sf2: { x: 1060, y: 409 },
  qf3: { x: 1310, y: 208 },
  qf4: { x: 1310, y: 623 },
};

const CANDIDATE_LAYOUT = {
  qf1: { x: 20, side: 'left', y: [131, 277] },
  qf2: { x: 20, side: 'left', y: [546, 692] },
  qf3: { x: 1560, side: 'right', y: [131, 277] },
  qf4: { x: 1560, side: 'right', y: [546, 692] },
};

const LAYER_LABELS = [
  [130, '参赛队伍'], [380, '四分之一决赛'], [630, '半决赛'], [900, '决赛'],
  [1170, '半决赛'], [1420, '四分之一决赛'], [1670, '参赛队伍'],
];

const CONNECTOR_PATHS = [
  'M240 191 H255 V337 M240 337 H255 M255 264 H270',
  'M240 606 H255 V752 M240 752 H255 M255 679 H270',
  'M490 264 H505 V679 M490 679 H505 M505 465 H520',
  'M740 465 H770',
  'M1030 465 H1060',
  'M1280 465 H1295 V264 M1295 679 V465 M1295 264 H1310 M1295 679 H1310',
  'M1530 264 H1545 V191 M1545 337 V264 M1545 191 H1560 M1545 337 H1560',
  'M1530 679 H1545 V606 M1545 752 V679 M1545 606 H1560 M1545 752 H1560',
];

const LEGEND = `<div class="legend">
<span class="chip"><span class="swatch upper"></span>高种子</span>
<span class="chip"><span class="swatch lower"></span>低种子</span>
<span class="chip"><span class="swatch win"></span>胜者</span>
<span class="chip"><span class="stone black" style="position:static;transform:none;width:14px;height:14px"></span>黑棋</span>
<span class="chip"><span class="stone white" style="position:static;transform:none;width:14px;height:14px"></span>白棋</span>
</div>`;

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// A high seed gets the blue treatment, a low seed the amber one -- read off the seed
// tag rather than stored again as a layout flag.
function toneOf(seedtag) {
  return /低种子/.test(seedtag) ? 'lower' : 'upper';
}

function candidateCard(data, qf, slot) {
  const layout = CANDIDATE_LAYOUT[qf];
  const c = candidateOf(data, qf, slot) || { seedtag: '', players: [] };
  const classes = ['card', 'candidate'];
  if (layout.side === 'right') classes.push('right');
  classes.push(toneOf(c.seedtag));
  const players = c.players.map((p, i) => `<div class="player">`
    + `<span class="name" data-bind="cand:${qf}:${slot}:name:${i}">${esc(p.name)}</span>`
    + `<span class="rank" data-bind="cand:${qf}:${slot}:rank:${i}">${esc(p.rank)}</span>`
    + `</div>`).join('');
  return `<div class="${classes.join(' ')}" data-qf="${qf}" data-slot="${slot}" `
    + `style="left:${layout.x}px;top:${layout.y[slot]}px">`
    + `<div class="seedtag" data-bind="seedtag:${qf}:${slot}">${esc(c.seedtag)}</div>`
    + `${players}</div>`;
}

function teamRow(data, matchId, slot) {
  const match = data.matches[matchId];
  const names = teamNames(data, matchId);
  const winner = matchWinner(match);
  const wins = winsFor(match);

  let state = '';
  if (winner !== null) state = slot === winner ? ' winner' : ' loser';
  else if (wins[slot] > wins[1 - slot]) state = ' leading';

  const stones = match.games.map((g, i) =>
    `<span class="stone${g.stones[slot] ? ' ' + g.stones[slot] : ''}" data-game="${i}"></span>`
  ).join('');

  // A single-game match shows one stone in the row; a series shows a score box and
  // one small stone per game.
  const trailing = match.bestOf > 1
    ? `<span class="score">${decidedCount(match) === 0 ? '' : wins[slot]}</span>`
      + `<span class="finalstones">${stones}</span>`
    : stones;

  return `<div class="teamrow${state}" data-slot="${slot}">`
    + `<span class="teamtext">${esc(names[slot])}</span>${trailing}</div>`;
}

function matchCard(data, matchId) {
  const layout = MATCH_LAYOUT[matchId];
  const extra = layout.extraClass ? ' ' + layout.extraClass : '';
  return `<div class="card match${extra}" id="${matchId}" `
    + `style="left:${layout.x}px;top:${layout.y}px">`
    + teamRow(data, matchId, 0) + teamRow(data, matchId, 1)
    + `</div>`;
}

function archiveButton(data, matchId, mode) {
  const layout = MATCH_LAYOUT[matchId];
  const size = layout.extraClass === 'final' ? SIZE.final : SIZE.match;
  const has = matchHasArchive(data.matches[matchId]);
  // Admin always needs a way in, even for an empty archive; the public page only
  // offers the viewer when there is something to view.
  const label = mode === 'admin' ? '编辑档案' : '对局档案';
  const cls = mode === 'admin' && has ? ' class="filled"' : '';
  const hidden = mode !== 'admin' && !has ? ' style="display:none"' : '';
  return `<div class="archive-link" style="left:${layout.x}px;`
    + `top:${layout.y + size.h + ARCHIVE_GAP}px;width:${size.w}px">`
    + `<button data-match="${matchId}"${cls}${hidden}>${label}</button></div>`;
}

export function render(app) {
  const { data, mode } = app;
  const parts = [];

  parts.push(`<canvas id="bgCanvas" width="${CANVAS.w}" height="${CANVAS.h}" aria-hidden="true"></canvas>`);
  parts.push(`<div class="title" data-bind="title">${esc(data.title)}</div>`);
  parts.push(`<div class="subtitle">更新时间：${esc(data.updated)}</div>`);
  LAYER_LABELS.forEach(([x, label]) => {
    parts.push(`<div class="layer" style="left:${x}px">${esc(label)}</div>`);
  });
  parts.push(`<svg aria-hidden="true" class="paths" height="${CANVAS.h}" `
    + `viewBox="0 0 ${CANVAS.w} ${CANVAS.h}" width="${CANVAS.w}">`
    + CONNECTOR_PATHS.map(d => `<path d="${d}"></path>`).join('') + `</svg>`);

  // Left candidates, then every match with its archive button, then right candidates.
  ['qf1', 'qf2'].forEach(qf => [0, 1].forEach(s => parts.push(candidateCard(data, qf, s))));
  MATCH_IDS.forEach(id => {
    parts.push(matchCard(data, id));
    parts.push(archiveButton(data, id, mode));
  });
  ['qf3', 'qf4'].forEach(qf => [0, 1].forEach(s => parts.push(candidateCard(data, qf, s))));

  const noteLines = data.note.map((line, i) =>
    `<div data-bind="note:${i}">${esc(line)}</div>`).join('');
  parts.push(`<div class="footer">${LEGEND}<div class="note">${noteLines}</div></div>`);

  const bracket = document.getElementById('bracket');
  // The background canvas holds drawn pixels (and possibly a watermark) that markup
  // cannot carry, so it survives a re-render instead of being rebuilt and reloaded.
  const existing = document.getElementById('bgCanvas');
  bracket.innerHTML = parts.join('\n');
  if (existing && existing.dataset.loaded) {
    bracket.replaceChild(existing, document.getElementById('bgCanvas'));
  }
  setEditable(mode !== 'view');
}

const EDITABLE_SELECTOR = '[data-bind]';

export function setEditable(on) {
  document.querySelectorAll(EDITABLE_SELECTOR).forEach(el => {
    el.contentEditable = on ? 'true' : 'false';
  });
}

// Writes an edited text field back into the data. The element's data-bind attribute
// names the exact place it came from, so text edits never need to be discovered by
// scanning the DOM.
export function applyBoundEdit(data, bind, text) {
  const parts = bind.split(':');
  if (parts[0] === 'title') { data.title = text; return true; }
  if (parts[0] === 'note') { data.note[Number(parts[1])] = text; return true; }
  const [kind, qf, slotStr, field, indexStr] = parts;
  const c = candidateOf(data, qf, Number(slotStr));
  if (!c) return false;
  if (kind === 'seedtag') { c.seedtag = text; return true; }
  if (kind === 'cand' && c.players[Number(indexStr)]) {
    c.players[Number(indexStr)][field] = text;
    return true;
  }
  return false;
}
