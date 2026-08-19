// Click and text-edit handling for the two editable modes (public 编辑模式 and admin).
//
// Every handler mutates the data and then asks for a re-render. Nothing reads results
// back out of the DOM, and nothing has to push a winner's name downstream by hand --
// later rounds are derived from the data, so they simply come out right on re-render.

import { WIRING, matchWinner } from './model.js';
import { applyBoundEdit } from './render.js';

// One delegated listener for the whole bracket, so no element carries an inline
// onclick and nothing needs its handlers rewritten when the mode changes.
export function installInteractions(app) {
  const bracket = document.getElementById('bracket');

  bracket.addEventListener('click', e => {
    if (app.mode === 'view') return;

    const stone = e.target.closest('.stone');
    if (stone && bracket.contains(stone)) {
      const row = stone.closest('.teamrow');
      if (!row) return;                       // the legend's sample stones
      e.stopPropagation();
      cycleStone(app, row, Number(stone.dataset.game));
      app.changed();
      return;
    }

    const row = e.target.closest('.teamrow');
    if (row) {
      recordWin(app, row.closest('.match').id, Number(row.dataset.slot));
      app.changed();
    }
  });

  // Text edits (names, ranks, title, note) write straight back into the data. No
  // re-render here: the DOM already shows the new text, and re-rendering mid-typing
  // would move the caret.
  bracket.addEventListener('input', e => {
    const el = e.target.closest('[data-bind]');
    if (!el) return;
    if (applyBoundEdit(app.data, el.dataset.bind, el.textContent.trim())) {
      app.persist();
    }
  });
}

// Stone colours are chosen per game and always paired: setting one team to black makes
// the other white. Cycles 未定 → 黑/白 → 白/黑 → 未定.
function cycleStone(app, row, gameIndex) {
  const matchId = row.closest('.match').id;
  const slot = Number(row.dataset.slot);
  const game = app.data.matches[matchId].games[gameIndex];
  const own = game.stones[slot];
  game.stones[slot] = own === null ? 'black' : own === 'black' ? 'white' : null;
  game.stones[1 - slot] = game.stones[slot] === null
    ? null
    : game.stones[slot] === 'black' ? 'white' : 'black';
}

// Clicking a team awards it the next game. Once the match is settled the click acts on
// the deciding game instead of adding an impossible extra win: clicking the winner
// takes that win back, clicking the loser hands the deciding game to it. For a
// best-of-1 this reads exactly as before -- click to set, click again to clear, click
// the opponent to reverse.
function recordWin(app, matchId, slot) {
  const match = app.data.matches[matchId];
  const winner = matchWinner(match);

  if (winner === null) {
    const next = match.games.find(g => g.winner === null);
    if (!next) return;
    next.winner = slot;
  } else {
    const decided = match.games.filter(g => g.winner !== null);
    const deciding = decided[decided.length - 1];
    deciding.winner = winner === slot ? null : slot;
  }
  clearDownstream(app.data, matchId);
}

// A changed result makes anything already recorded in later rounds meaningless.
function clearDownstream(data, matchId) {
  const next = WIRING[matchId].next;
  if (!next) return;
  data.matches[next].games.forEach(g => { g.winner = null; });
  clearDownstream(data, next);
}

export function clearAllResults(app) {
  Object.values(app.data.matches).forEach(match => {
    match.games.forEach(g => {
      g.winner = null;
      g.stones = [null, null];
    });
  });
  app.changed();
}
