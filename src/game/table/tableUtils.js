let _io;
function init(io) { _io = io; }

function nextCard(t) { return t.deck[t.deckIdx++]; }
function activePlayers(t) { return t.players.filter(p=>!p.folded&&p.stack>0); }

function findNextActive(t, fromIdx) {
  let idx = (fromIdx+1)%t.players.length;
  for (let i=0;i<t.players.length;i++) {
    if (!t.players[idx].folded&&t.players[idx].stack>0) return idx;
    idx = (idx+1)%t.players.length;
  }
  return -1;
}

function allActed(t) {
  return t.players.filter(p=>!p.folded&&p.stack>0)
    .every(p=>p.hasActed&&p.bet===t.currentBet||p.stack===0&&p.hasActed);
}

function broadcastTable(t) {
  t.players.forEach(player => {
    const sock = _io.sockets.sockets.get(player.socketId);
    if (!sock) return;
    sock.emit('gameState', {
      ...t,
      deck: undefined,
      autoStartTimer: undefined,
      nextHandTimer: undefined,
      players: t.players.map(p => ({
        id: p.socketId,
        telegramId: p.telegramId,
        name: p.name,
        photo: p.photo || null,
        stack: p.stack,
        bet: p.bet,
        folded: p.folded,
        isWaiting: p.isWaiting || false,
        cards: p.telegramId === player.telegramId ? p.cards : p.cards.map(() => ({ hidden: true })),
      }))
    });
  });
}

function broadcastShowdown(t) {
  _io.to('table_' + t.id).emit('gameState', {
    ...t,
    deck: undefined,
    autoStartTimer: undefined,
    nextHandTimer: undefined,
    players: t.players.map(p => ({
      id: p.socketId,
      telegramId: p.telegramId,
      name: p.name,
      photo: p.photo || null,
      stack: p.stack,
      bet: p.bet,
      folded: p.folded,
      isWaiting: p.isWaiting || false,
      cards: p.cards
    }))
  });
}

module.exports = { init, nextCard, activePlayers, findNextActive, allActed, broadcastTable, broadcastShowdown };
