const { sitgoLobbies }          = require('../game/sitgo/sitgoManager');
const { handleSitGoAction }     = require('../game/sitgo/sitgoFlow');
const { broadcastSitGo }        = require('../game/sitgo/sitgoUtils');
const { SITGO_CONFIG }          = require('../config/constants');

function registerSitGoHandlers(socket, io, getCurrentTelegramId, setCurrentSitGoId, getCurrentSitGoId) {

  socket.on('joinSitGoLobby', ({ lobbyId, telegramId }) => {
    setCurrentSitGoId(lobbyId);
    socket.join('sitgo_lobby_' + lobbyId);
    socket.join('sitgo_' + lobbyId);
    const lobby=sitgoLobbies[lobbyId];
    if (!lobby) { socket.emit('sitgoError',{message:'Лобби не найдено'}); return; }
    const player=lobby.players.find(p=>p.telegramId===telegramId);
    if (player) player.socketId=socket.id;
    socket.emit('sitgoLobbyUpdate', {
      players:lobby.players.map(p=>({name:p.name,photo:p.photo,telegramId:p.telegramId})),
      status:lobby.status, maxPlayers:SITGO_CONFIG[lobby.configId].maxPlayers, prizePool:lobby.prizePool,
    });
    if (lobby.status==='playing'||lobby.status==='finished_hand') broadcastSitGo(lobby);
  });

  socket.on('sitgoAction', ({ action, amount }) => {
    const sg=sitgoLobbies[getCurrentSitGoId()];
    if (!sg||sg.status==='finished') return;
    handleSitGoAction(sg, getCurrentTelegramId(), action, amount||0);
  });

  socket.on('leaveSitGo', () => {
    const sg=sitgoLobbies[getCurrentSitGoId()];
    if (!sg) return;
    const player=sg.players.find(p=>p.telegramId===getCurrentTelegramId());
    if (player&&player.eliminated) player.socketId=null;
  });
}

module.exports = { registerSitGoHandlers };
