let _io;
function init(io) { _io = io; }

function findNextActiveSitGo(sg, fromIdx) {
  const players=sg.players;
  let idx=(fromIdx+1)%players.length;
  for (let i=0;i<players.length;i++) {
    if (!players[idx].folded&&!players[idx].eliminated&&players[idx].stack>0) return idx;
    idx=(idx+1)%players.length;
  }
  return -1;
}

function allActedSitGo(sg) {
  return sg.players.filter(p=>!p.folded&&!p.eliminated&&p.stack>0)
    .every(p=>p.hasActed&&p.bet===sg.currentBet||p.stack===0&&p.hasActed);
}

function broadcastSitGo(sg) {
  sg.players.forEach(player => {
    const sock=_io.sockets.sockets.get(player.socketId);
    if (!sock) return;
    sock.emit('sitgoState', {
      id:sg.id, configId:sg.configId, status:sg.status, round:sg.round, pot:sg.pot,
      communityCards:sg.communityCards, currentBet:sg.currentBet, countdown:sg.countdown||0,
      blindLevel:sg.blindLevel, handsPlayed:sg.handsPlayed, sb:sg.currentSb, bb:sg.currentBb,
      winner:sg.winner||null, prizePool:sg.prizePool,
      players: sg.players.map(p => ({
        telegramId:p.telegramId, name:p.name, photo:p.photo,
        stack:p.stack, bet:p.bet, folded:p.folded, eliminated:p.eliminated, place:p.place, isWaiting:p.isWaiting||false,
        cards: p.telegramId===player.telegramId&&!p.eliminated ? p.cards : p.cards?p.cards.map(()=>({hidden:true})):[],
      }))
    });
  });
}

function broadcastSitGoShowdown(sg) {
  _io.to('sitgo_' + sg.id).emit('sitgoState', {
    id:sg.id, configId:sg.configId, status:sg.status, round:sg.round, pot:sg.pot,
    communityCards:sg.communityCards, currentBet:sg.currentBet, countdown:sg.countdown||0,
    blindLevel:sg.blindLevel, handsPlayed:sg.handsPlayed, sb:sg.currentSb, bb:sg.currentBb,
    winner:sg.winner||null, prizePool:sg.prizePool,
    players: sg.players.map(p => ({ telegramId:p.telegramId, name:p.name, photo:p.photo, stack:p.stack, bet:p.bet, folded:p.folded, eliminated:p.eliminated, place:p.place, isWaiting:p.isWaiting||false, cards:p.cards||[] }))
  });
}

module.exports = { init, findNextActiveSitGo, allActedSitGo, broadcastSitGo, broadcastSitGoShowdown };
