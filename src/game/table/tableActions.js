const { allActed, findNextActive, broadcastTable } = require('./tableUtils');
const { advanceRound, endHand }                    = require('./tableFlow');

function handleAction(t, telegramId, action, amount) {
  const idx=t.players.findIndex(p=>p.telegramId===telegramId);
  if (idx!==t.activePlayer) return;
  const player=t.players[idx];
  if (player.isWaiting) return;
  switch(action) {
    case 'fold':
      player.folded=true; player.hasActed=true;
      break;
    case 'call': {
      const ca=Math.max(0,t.currentBet-player.bet);
      const ac=Math.min(ca,player.stack);
      player.stack-=ac; player.bet+=ac; t.pot+=ac; player.hasActed=true;
      break;
    }
    case 'raise': {
      const minRaise=Math.max(t.config.bb, t.currentBet*2);
      const ra=Math.min(Math.max(amount,minRaise),player.stack);
      player.stack-=ra; player.bet+=ra; t.pot+=ra;
      if(player.bet>t.currentBet){
        t.currentBet=player.bet;
        t.players.forEach(p=>{ if(p.telegramId!==telegramId&&!p.folded) p.hasActed=false; });
      }
      player.hasActed=true;
      break;
    }
    case 'allin': {
      const al=player.stack;
      player.bet+=al; player.stack=0; t.pot+=al;
      if(player.bet>t.currentBet){
        t.currentBet=player.bet;
        t.players.forEach(p=>{ if(p.telegramId!==telegramId&&!p.folded) p.hasActed=false; });
      }
      player.hasActed=true;
      break;
    }
  }
  if (t.players.filter(p=>!p.folded&&!p.isWaiting).length===1) { endHand(t); return; }
  if (allActed(t)) { advanceRound(t); return; }
  const next=findNextActive(t,idx);
  if (next===-1) { advanceRound(t); return; }
  t.activePlayer=next; broadcastTable(t);
}

module.exports = { handleAction };
