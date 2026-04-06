const { tables, getTable }                           = require('../game/table/tableManager');
const { broadcastTable, activePlayers }              = require('../game/table/tableUtils');
const { checkAutoStart, endHand }                    = require('../game/table/tableFlow');
const { handleAction }                               = require('../game/table/tableActions');
const { getOrCreatePlayer }                          = require('../database/players');

const paidStarsSessions = new Map();

function getPaidStarsSessions() { return paidStarsSessions; }

function registerTableHandlers(socket, io) {
  let currentTableId  = null;
  let currentTelegramId = null;

  socket.on('joinTable', async ({ tableId, name, photo, telegramId, configId }) => {
    tableId=String(tableId||'1'); currentTableId=tableId; currentTelegramId=telegramId;
    const t=getTable(tableId,configId);
    socket.join('table_' + tableId);
    if (t.config.type==='stars') {
      const sessionKey=telegramId+':'+t.configId;
      const sessionExpiry=paidStarsSessions.get(sessionKey);
      const existing=t.players.find(p=>p.telegramId===telegramId);
      if (!existing) {
        if (!sessionExpiry||Date.now()>sessionExpiry) { socket.emit('error',{message:'Оплата не найдена. Зайди через лобби.'}); return; }
        paidStarsSessions.delete(sessionKey);
      }
    }
    t.players=t.players.filter(p=>{ if(p.telegramId===telegramId)return true; return !!io.sockets.sockets.get(p.socketId); });
    const existing=t.players.find(p=>p.telegramId===telegramId);
    if (existing) { existing.socketId=socket.id; existing.name=name||existing.name; existing.photo=photo||existing.photo; }
    else if (t.players.length<6) {
      const dbPlayer=await getOrCreatePlayer(telegramId,name,photo);
      const stack=t.config.type==='stars'?dbPlayer.stars_balance||0:dbPlayer.balance||1000;
      const isWaiting=t.status==='playing';
      t.players.push({ socketId:socket.id, telegramId, name:name||'Player', photo:photo||null, stack, dbBalance:dbPlayer.balance, dbStarsBalance:dbPlayer.stars_balance, cards:[], bet:0, folded:isWaiting, hasActed:isWaiting, isWaiting });
      if (isWaiting) socket.emit('waiting',{message:'Ждёшь следующей раздачи...'});
    }
    broadcastTable(t);
    if (t.status==='waiting') checkAutoStart(t);
  });

  socket.on('action', ({ action, amount }) => {
    const t=tables[currentTableId];
    if (!t||t.status!=='playing') return;
    handleAction(t,currentTelegramId,action,amount||0);
  });

  socket.on('leaveTable', () => {
    const t=tables[currentTableId];
    if (!t) return;
    t.players=t.players.filter(p=>p.telegramId!==currentTelegramId);
    if (t.players.length>0) { broadcastTable(t); if(activePlayers(t).length<2&&t.status==='playing')endHand(t); }
    else { if(t.autoStartTimer)clearTimeout(t.autoStartTimer); if(t.nextHandTimer)clearTimeout(t.nextHandTimer); t.status='waiting'; t.countdown=0; t.handInProgress=false; }
  });

  socket.on('reaction', ({ emoji, tableId, telegramId, name }) => {
    io.to('table_' + tableId).emit('reaction', { emoji, telegramId, name });
  });

  socket.on('chatMsg', ({ msg, tableId, telegramId, name }) => {
    io.to('table_' + tableId).emit('chatMsg', { msg, telegramId, name });
  });

  return { getCurrentTableId: ()=>currentTableId, getCurrentTelegramId: ()=>currentTelegramId };
}

module.exports = { registerTableHandlers, getPaidStarsSessions };
