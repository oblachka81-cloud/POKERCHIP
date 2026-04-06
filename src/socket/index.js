const { registerTableHandlers, getPaidStarsSessions } = require('./tableSocket');
const { registerSitGoHandlers } = require('./sitgoSocket');
const { tables } = require('../game/table/tableManager');
const { sitgoLobbies } = require('../game/sitgo/sitgoManager');
const { broadcastTable, activePlayers } = require('../game/table/tableUtils');
const { endHand } = require('../game/table/tableFlow');

function setupSocket(io) {
  io.on('connection', (socket) => {
    let currentSitGoId = null;

    const { getCurrentTableId, getCurrentTelegramId } = registerTableHandlers(socket, io);

    registerSitGoHandlers(
      socket, io,
      getCurrentTelegramId,
      (id) => { currentSitGoId = id; },
      () => currentSitGoId
    );

    socket.on('disconnect', () => {
      const t = tables[getCurrentTableId()];
      if (t) {
        const tgId = getCurrentTelegramId();
        setTimeout(async () => {
          const player = t.players.find(p => p.telegramId === tgId);
          if (player && !io.sockets.sockets.get(player.socketId)) {
            const removedIdx = t.players.findIndex(p => p.telegramId === tgId);
            t.players = t.players.filter(p => p.telegramId !== tgId);

            if (typeof t.activePlayer === 'number' && removedIdx !== -1) {
              if (t.players.length === 0) {
                t.activePlayer = -1;
              } else if (removedIdx < t.activePlayer) {
                t.activePlayer = Math.max(0, t.activePlayer - 1);
              } else if (t.activePlayer >= t.players.length) {
                t.activePlayer = 0;
              }
            }

            if (t.players.length > 0) {
              broadcastTable(t);
              if (activePlayers(t).length < 2 && t.status === 'playing') {
                try {
                  await endHand(t);
                } catch (e) {
                  console.error('endHand error on disconnect:', e);
                }
              }
            } else {
              t.handInProgress = false;
            }
          }
        }, 5000);
      }

      const sg = sitgoLobbies[currentSitGoId];
      if (sg) {
        const player = sg.players.find(p => p.telegramId === getCurrentTelegramId());
        if (player) player.socketId = null;
      }
    });
  });
}

module.exports = { setupSocket };

