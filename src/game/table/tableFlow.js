const { createValidDeck, bestHand } = require('../pokerLogic');
const { saveBalance }               = require('../../database/players');
const { pool }                      = require('../../database/db');
const { nextCard, activePlayers, findNextActive, allActed, broadcastTable, broadcastShowdown } = require('./tableUtils');

function checkAutoStart(t) {
  if (t.autoStartTimer) { clearTimeout(t.autoStartTimer); t.autoStartTimer=null; }
  const ready = t.players.filter(p=>!p.isWaiting&&p.stack>0);
  if (ready.length>=2&&t.status==='waiting') {
    t.countdown=3; broadcastTable(t);
    t.autoStartTimer = setTimeout(() => {
      t.autoStartTimer=null;
      const r = t.players.filter(p=>!p.isWaiting&&p.stack>0);
      if (r.length>=2&&t.status==='waiting') startHand(t);
    }, 3000);
  } else { t.countdown=0; broadcastTable(t); }
}

function scheduleNextHand(t) {
  if (t.nextHandTimer) { clearTimeout(t.nextHandTimer); t.nextHandTimer=null; }
  t.handInProgress=false;
  t.players.forEach(p=>{ p.isWaiting=false; });
  t.countdown=5; broadcastTable(t);
  t.nextHandTimer = setTimeout(() => {
    t.nextHandTimer=null;
    if (activePlayers(t).length>=2) startHand(t);
    else { t.status='waiting'; t.countdown=0; broadcastTable(t); }
  }, 5000);
}

function startHand(t) {
  if (t.handInProgress) { console.warn('⚠️ startHand повторно ' + t.id); return; }
  t.handInProgress=true;
  t.players.forEach(p=>{ if(p.stack<=0) p.stack=1000; });
  t.deck=createValidDeck(); t.deckIdx=0; t.communityCards=[]; t.pot=0; t.currentBet=0;
  t.status='playing'; t.round='preflop'; t.winner=null; t.countdown=0;
  const activePlrs = t.players.filter(p=>!p.isWaiting);
  activePlrs.forEach(p=>{ p.cards=[nextCard(t),nextCard(t)]; p.bet=0; p.folded=false; p.hasActed=false; });
  t.players.filter(p=>p.isWaiting).forEach(p=>{ p.cards=[]; p.bet=0; p.folded=true; p.hasActed=true; });
  const active = activePlrs.filter(p=>p.stack>0);
  if (active.length<2) { t.handInProgress=false; return; }
  const sbIdx = t.dealerIndex % active.length;
  const bbIdx = (sbIdx + 1) % active.length;
  const sb = active[sbIdx], bb = active[bbIdx];
  t.dealerIndex++;
  const sbAmt=Math.min(t.config.sb,sb.stack), bbAmt=Math.min(t.config.bb,bb.stack);
  sb.stack-=sbAmt; sb.bet=sbAmt; t.pot+=sbAmt;
  bb.stack-=bbAmt; bb.bet=bbAmt; t.pot+=bbAmt;
  t.currentBet=bbAmt;
  t.activePlayer=findNextActive(t,t.players.indexOf(bb));
  broadcastTable(t);
}

function advanceRound(t) {
  t.players.forEach(p=>{ p.bet=0; p.hasActed=false; }); t.currentBet=0;
  t.activePlayer=findNextActive(t,-1);
  if (t.round==='preflop') { t.communityCards=[nextCard(t),nextCard(t),nextCard(t)]; t.round='flop'; }
  else if (t.round==='flop') { t.communityCards.push(nextCard(t)); t.round='turn'; }
  else if (t.round==='turn') { t.communityCards.push(nextCard(t)); t.round='river'; }
  else if (t.round==='river') { endHand(t); return; }
  broadcastTable(t);
}

async function endHand(t) {
  t.round='showdown';
  const active = t.players.filter(p=>!p.folded&&!p.isWaiting&&p.stack>=0);
  let winnerPlayer=null;
  const rakeAmount=Math.min(Math.floor(t.pot*t.config.rake),t.config.rakeCap);
  const potAfterRake=t.pot-rakeAmount;
  if (active.length===1) { active[0].stack+=potAfterRake; t.winner={name:active[0].name,handName:'Все спасовали'}; winnerPlayer=active[0]; }
  else if (active.length===0) { t.winner={name:'—',handName:'Нет активных игроков'}; }
  else {
    const evals=active.map(p=>({player:p,hand:bestHand([...p.cards,...t.communityCards])}));
    let best=evals[0];
    for (const e of evals.slice(1)) {
      if (e.hand.rank>best.hand.rank) { best=e; continue; }
      if (e.hand.rank===best.hand.rank) {
        for (let i=0;i<Math.min(e.hand.val.length,best.hand.val.length);i++) {
          if (e.hand.val[i]>best.hand.val[i]) { best=e; break; }
          if (e.hand.val[i]<best.hand.val[i]) break;
        }
      }
    }
    best.player.stack+=potAfterRake; t.winner={name:best.player.name,handName:best.hand.name}; winnerPlayer=best.player;
  }
  t.winner.rake=rakeAmount; t.status='finished';
  broadcastShowdown(t);
  for (const p of t.players) {
    if (p.isWaiting) continue;
    const isWinner=p.telegramId===winnerPlayer?.telegramId;
    const playerRake=isWinner?rakeAmount:0;
    if (t.config.type==='stars') {
      const dbPlayer=await pool.query('SELECT balance FROM players WHERE telegram_id=$1',[p.telegramId]);
      const currentBalance=dbPlayer.rows[0]?.balance??p.dbBalance??1000;
      await saveBalance(p.telegramId,currentBalance,p.stack,isWinner,playerRake,t.id,t.configId);
    } else {
      const dbPlayer=await pool.query('SELECT stars_balance FROM players WHERE telegram_id=$1',[p.telegramId]);
      const currentStars=dbPlayer.rows[0]?.stars_balance??p.dbStarsBalance??0;
      await saveBalance(p.telegramId,p.stack,currentStars,isWinner,playerRake,t.id,t.configId);
    }
  }
  scheduleNextHand(t);
}

module.exports = { checkAutoStart, scheduleNextHand, startHand, advanceRound, endHand };
