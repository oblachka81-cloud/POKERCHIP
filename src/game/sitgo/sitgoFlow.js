const { createValidDeck, bestHand } = require('../pokerLogic');
const { pool }                      = require('../../database/db');
const { SITGO_CONFIG, PRIZE_DIST, BLIND_LEVELS } = require('../../config/constants');
const { sitgoLobbies, getSitGoNonEliminated } = require('./sitgoManager');
const { findNextActiveSitGo, allActedSitGo, broadcastSitGo, broadcastSitGoShowdown } = require('./sitgoUtils');

function startSitGoHand(sg) {
  if (sg.handInProgress) return;
  sg.handInProgress=true;
  const newBlindLevel=Math.min(Math.floor(sg.handsPlayed/10),BLIND_LEVELS.length-1);
  if (newBlindLevel!==sg.blindLevel) {
    sg.blindLevel=newBlindLevel; sg.currentSb=BLIND_LEVELS[newBlindLevel].sb; sg.currentBb=BLIND_LEVELS[newBlindLevel].bb;
    console.log('📈 Sit&Go ' + sg.id + ': блайнды ' + sg.currentSb + '/' + sg.currentBb);
  }
  sg.deck=createValidDeck(); sg.deckIdx=0; sg.communityCards=[]; sg.pot=0; sg.currentBet=0;
  sg.status='playing'; sg.round='preflop'; sg.winner=null; sg.countdown=0; sg.handsPlayed++;
  const activePlrs=getSitGoNonEliminated(sg);
  activePlrs.forEach(p=>{ p.cards=[sg.deck[sg.deckIdx++],sg.deck[sg.deckIdx++]]; p.bet=0; p.folded=false; p.hasActed=false; });
  if (activePlrs.length<2) { sg.handInProgress=false; return; }
  const sbIdx = sg.dealerIndex % activePlrs.length;
  const bbIdx = (sbIdx + 1) % activePlrs.length;
  const sb = activePlrs[sbIdx], bb = activePlrs[bbIdx];
  sg.dealerIndex++;
  const sbAmt=Math.min(sg.currentSb,sb.stack), bbAmt=Math.min(sg.currentBb,bb.stack);
  sb.stack-=sbAmt; sb.bet=sbAmt; sg.pot+=sbAmt;
  bb.stack-=bbAmt; bb.bet=bbAmt; sg.pot+=bbAmt;
  sg.currentBet=bbAmt; sg.activePlayer=findNextActiveSitGo(sg,sg.players.indexOf(bb));
  broadcastSitGo(sg);
}

function advanceRoundSitGo(sg) {
  sg.players.forEach(p=>{ p.bet=0; p.hasActed=false; }); sg.currentBet=0;
  sg.activePlayer=findNextActiveSitGo(sg,-1);
  if (sg.round==='preflop') { sg.communityCards=[sg.deck[sg.deckIdx++],sg.deck[sg.deckIdx++],sg.deck[sg.deckIdx++]]; sg.round='flop'; }
  else if (sg.round==='flop') { sg.communityCards.push(sg.deck[sg.deckIdx++]); sg.round='turn'; }
  else if (sg.round==='turn') { sg.communityCards.push(sg.deck[sg.deckIdx++]); sg.round='river'; }
  else if (sg.round==='river') { endSitGoHand(sg); return; }
  broadcastSitGo(sg);
}

async function endSitGoHand(sg) {
  sg.round='showdown';
  const active=sg.players.filter(p=>!p.folded&&!p.eliminated);
  let winnerPlayer=null;
  if (active.length===1) { active[0].stack+=sg.pot; sg.winner={name:active[0].name,handName:'Все спасовали'}; winnerPlayer=active[0]; }
  else if (active.length>1) {
    const evals=active.map(p=>({player:p,hand:bestHand([...p.cards,...sg.communityCards])}));
    let best=evals[0];
    for (const e of evals.slice(1)) {
      if (e.hand.rank>best.hand.rank){best=e;continue;}
      if (e.hand.rank===best.hand.rank){for(let i=0;i<Math.min(e.hand.val.length,best.hand.val.length);i++){if(e.hand.val[i]>best.hand.val[i]){best=e;break;}if(e.hand.val[i]<best.hand.val[i])break;}}
    }
    best.player.stack+=sg.pot; sg.winner={name:best.player.name,handName:best.hand.name}; winnerPlayer=best.player;
  }
  sg.status='finished_hand'; broadcastSitGoShowdown(sg);
  const currentPlacesAwarded=sg.players.filter(p=>p.eliminated).length;
  let _io;
  try { _io = require('../../../src/index').__io; } catch(e) {}
  sg.players.forEach(p=>{
    if (!p.eliminated&&p.stack<=0) {
      p.eliminated=true; p.place=sg.players.length-currentPlacesAwarded;
      console.log('💀 ' + p.name + ' выбыл на ' + p.place + ' месте');
      const { getIo } = require('../../index');
      const io = getIo();
      if (io) { const sock=io.sockets.sockets.get(p.socketId); if (sock) sock.emit('sitgoEliminated',{place:p.place,prizePool:sg.prizePool}); }
    }
  });
  const remaining=sg.players.filter(p=>!p.eliminated);
  if (remaining.length===1) { remaining[0].place=1; await finishSitGo(sg); return; }
  sg.handInProgress=false; sg.countdown=5; broadcastSitGo(sg);
  sg.nextHandTimer=setTimeout(()=>{ sg.countdown=0; startSitGoHand(sg); }, 5000);
}

async function finishSitGo(sg) {
  sg.status='finished';
  const config=SITGO_CONFIG[sg.configId];
  const prizeDist=PRIZE_DIST[sg.players.length]||[100];
  const sorted=[...sg.players].sort((a,b)=>a.place-b.place);
  for (let i=0;i<sorted.length;i++) {
    const player=sorted[i];
    const pct=prizeDist[i]||0;
    const prize=Math.floor(sg.prizePool*pct/100);
    player.prizeStars=prize;
    if (prize>0) {
      try { await pool.query('UPDATE players SET stars_balance=stars_balance+$2,updated_at=NOW() WHERE telegram_id=$1',[player.telegramId,prize]); } catch(e){}
    }
    try {
      await pool.query(`INSERT INTO sitgo_results (sitgo_id,config_id,telegram_id,player_name,place,prize_stars,buy_in,rake,hands_played) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [sg.id,sg.configId,player.telegramId,player.name,player.place,prize,config.buyIn,config.rake,sg.handsPlayed]);
    } catch(e){}
    const { getIo } = require('../../index');
    const io = getIo();
    if (io) { const sock=io.sockets.sockets.get(player.socketId); if (sock) sock.emit('sitgoFinished',{place:player.place,prize,prizePool:sg.prizePool,players:sorted.map(p=>({name:p.name,place:p.place,prize:p.prizeStars||0}))}); }
  }
  try { await pool.query(`INSERT INTO house (table_id,table_type,rake_amount,pot_amount) VALUES ($1,$2,$3,$4)`,[sg.id,'sitgo_'+sg.configId,sg.totalRake,sg.prizePool]); } catch(e){}
  broadcastSitGoShowdown(sg);
  setTimeout(()=>{ delete sitgoLobbies[sg.id]; }, 60000);
}

function handleSitGoAction(sg, telegramId, action, amount) {
  const idx=sg.players.findIndex(p=>p.telegramId===telegramId);
  if (idx!==sg.activePlayer) return;
  const player=sg.players[idx];
  if (player.eliminated||player.isWaiting) return;
  switch(action) {
    case 'fold': player.folded=true; player.hasActed=true; break;
    case 'call': { const ca=Math.max(0,sg.currentBet-player.bet); const ac=Math.min(ca,player.stack); player.stack-=ac; player.bet+=ac; sg.pot+=ac; player.hasActed=true; break; }
    case 'raise': { const minRaise=Math.max(sg.currentBb, sg.currentBet*2); const ra=Math.min(Math.max(amount,minRaise),player.stack); player.stack-=ra; player.bet+=ra; sg.pot+=ra; if(player.bet>sg.currentBet){sg.currentBet=player.bet;sg.players.forEach(p=>{if(p.telegramId!==telegramId&&!p.folded&&!p.eliminated)p.hasActed=false;});} player.hasActed=true; break; }
    case 'allin': { const al=player.stack; player.bet+=al; player.stack=0; sg.pot+=al; if(player.bet>sg.currentBet){sg.currentBet=player.bet;sg.players.forEach(p=>{if(p.telegramId!==telegramId&&!p.folded&&!p.eliminated)p.hasActed=false;});} player.hasActed=true; break; }
  }
  if (sg.players.filter(p=>!p.folded&&!p.eliminated).length===1) { endSitGoHand(sg); return; }
  if (allActedSitGo(sg)) { advanceRoundSitGo(sg); return; }
  const next=findNextActiveSitGo(sg,idx);
  if (next===-1) { advanceRoundSitGo(sg); return; }
  sg.activePlayer=next; broadcastSitGo(sg);
}

module.exports = { startSitGoHand, advanceRoundSitGo, endSitGoHand, finishSitGo, handleSitGoAction };
