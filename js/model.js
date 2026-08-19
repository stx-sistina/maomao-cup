// The bracket as data. Nothing in this file touches the DOM.
//
// The important property: every fact is stored exactly once. A team's name in a
// semifinal is *not* stored -- it is computed from the candidate rosters plus the
// upstream winners, so it can never go stale. Likewise a match's winner is computed
// from its games rather than stored alongside them.

export const TBD = '待定';

// Which match each result feeds into, and which of the two slots it fills.
export const WIRING = {
  qf1: { next: 'sf1', slot: 0 },
  qf2: { next: 'sf1', slot: 1 },
  qf3: { next: 'sf2', slot: 0 },
  qf4: { next: 'sf2', slot: 1 },
  sf1: { next: 'final', slot: 0 },
  sf2: { next: 'final', slot: 1 },
  final: { next: null, slot: null },
};

// Rendering order, matching the left-to-right reading of the bracket.
export const MATCH_IDS = ['qf1', 'qf2', 'sf1', 'final', 'sf2', 'qf3', 'qf4'];
export const QF_IDS = ['qf1', 'qf2', 'qf3', 'qf4'];

export const ARCHIVE_FIELDS = ['black', 'white', 'result', 'link', 'sgf', 'report'];

export function emptyArchive() {
  return { black: '', white: '', result: '', link: '', sgf: '', report: '' };
}

export function emptyGame() {
  return { winner: null, stones: [null, null], archive: emptyArchive() };
}

// data.json omits everything that is empty, to keep it short and readable by hand.
// This fills the gaps back in so no other code has to guard against missing fields.
export function normalize(raw) {
  const data = {
    title: raw.title || '',
    updated: raw.updated || '',
    note: Array.isArray(raw.note) ? raw.note.slice() : (raw.note ? [raw.note] : []),
    candidates: (raw.candidates || []).map(c => ({
      qf: c.qf,
      slot: Number(c.slot),
      seedtag: c.seedtag || '',
      players: (c.players || []).map(p => ({ name: p.name || '', rank: p.rank || '' })),
    })),
    matches: {},
  };
  MATCH_IDS.forEach(id => {
    const m = (raw.matches && raw.matches[id]) || {};
    const bestOf = m.bestOf || 1;
    const games = [];
    for (let i = 0; i < bestOf; i++) {
      const g = (m.games && m.games[i]) || {};
      games.push({
        winner: g.winner === 0 || g.winner === 1 ? g.winner : null,
        stones: [stoneOrNull(g.stones && g.stones[0]), stoneOrNull(g.stones && g.stones[1])],
        archive: Object.assign(emptyArchive(), g.archive || {}),
      });
    }
    data.matches[id] = { bestOf, games };
  });
  return data;
}

function stoneOrNull(v) {
  return v === 'black' || v === 'white' ? v : null;
}

// The inverse of normalize(): drops empty fields so a committed data.json diff shows
// only what actually changed.
export function serialize(data) {
  const out = {
    title: data.title,
    updated: data.updated,
    note: data.note.slice(),
    candidates: data.candidates.map(c => ({
      qf: c.qf, slot: c.slot, seedtag: c.seedtag,
      players: c.players.map(p => ({ name: p.name, rank: p.rank })),
    })),
    matches: {},
  };
  MATCH_IDS.forEach(id => {
    const m = data.matches[id];
    out.matches[id] = {
      bestOf: m.bestOf,
      games: m.games.map(g => {
        const game = { winner: g.winner, stones: g.stones.slice() };
        if (archiveHasContent(g.archive)) {
          const a = {};
          ARCHIVE_FIELDS.forEach(f => { if (g.archive[f]) a[f] = g.archive[f]; });
          game.archive = a;
        }
        return game;
      }),
    };
  });
  return out;
}

// --- Derived facts ---

export function candidateOf(data, qf, slot) {
  return data.candidates.find(c => c.qf === qf && c.slot === slot) || null;
}

export function winsFor(match) {
  const wins = [0, 0];
  match.games.forEach(g => { if (g.winner !== null) wins[g.winner]++; });
  return wins;
}

export function gamesNeeded(match) {
  return Math.ceil(match.bestOf / 2);
}

export function matchWinner(match) {
  const [a, b] = winsFor(match);
  const need = gamesNeeded(match);
  if (a >= need) return 0;
  if (b >= need) return 1;
  return null;
}

export function decidedCount(match) {
  return match.games.filter(g => g.winner !== null).length;
}

export function feedersOf(matchId) {
  return Object.keys(WIRING)
    .filter(id => WIRING[id].next === matchId)
    .sort((a, b) => WIRING[a].slot - WIRING[b].slot);
}

// A quarterfinal's two teams come from candidate cards; every later match takes the
// winners of the two matches feeding it. Recursive, so a name is only ever derived.
export function teamNames(data, matchId) {
  const feeders = feedersOf(matchId);
  if (feeders.length === 0) {
    return [0, 1].map(slot => {
      const c = candidateOf(data, matchId, slot);
      return c && c.players.length ? c.players.map(p => p.name).join(' + ') : TBD;
    });
  }
  return feeders.map(id => {
    const w = matchWinner(data.matches[id]);
    return w === null ? TBD : teamNames(data, id)[w];
  });
}

// The roster behind a match slot, resolved the same way as its name. Used to prefill
// an archive's 黑方/白方 lists -- previously this went through a lookup keyed by the
// joined display string "A + B", which broke whenever a name was edited.
export function teamPlayers(data, matchId, slot) {
  const feeders = feedersOf(matchId);
  if (feeders.length === 0) {
    const c = candidateOf(data, matchId, slot);
    return c ? c.players.slice() : [];
  }
  const feederId = feeders[slot];
  const w = matchWinner(data.matches[feederId]);
  return w === null ? [] : teamPlayers(data, feederId, w);
}

// A rank cell may carry its own bracket, e.g. "9段 [业6]". Folding that into the outer
// brackets we add around the whole rank reads as "9段, 业6" rather than "9段 [业6]".
export function formatPlayer(player) {
  const rank = (player.rank || '').replace(/\s*\[([^\]]*)\]\s*/g, ', $1').replace(/^,\s*/, '');
  return rank ? `${player.name} [${rank}]` : player.name;
}

// --- Archives ---

export function archiveHasContent(archive) {
  return !!archive && ARCHIVE_FIELDS.some(f => archive[f]);
}

export function matchHasArchive(match) {
  return match.games.some(g => archiveHasContent(g.archive));
}

// Archive file names follow the match id, with a "_gN" suffix only where a match can
// have more than one game, e.g. "qf3.sgf" but "final_g2.sgf".
export function archiveBaseName(matchId, gameIndex, bestOf) {
  return bestOf > 1 ? `${matchId}_g${gameIndex + 1}` : matchId;
}

export function fileNameOf(path) {
  return path ? path.split('/').pop() : '';
}
