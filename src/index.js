const http     = require('http');
const socketIo = require('socket.io');
const app      = require('./app');
const { initDB }      = require('./database/db');
const { setupSocket } = require('./socket');
const { init: initTableUtils }  = require('./game/table/tableUtils');
const { init: initSitGoUtils }  = require('./game/sitgo/sitgoUtils');
const { init: initSitGoManager } = require('./game/sitgo/sitgoManager');

const PORT     = process.env.PORT || 3000;
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://chippoker.bothost.tech';

const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Передаём io во все модули которые его используют
initTableUtils(io);
initSitGoUtils(io);
initSitGoManager(io);

setupSocket(io);

function getIo() { return io; }

initDB().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log('🃏 Покер запущен на порту ' + PORT);
    console.log('🌐 URL: ' + WEBAPP_URL);
    console.log('🤖 Бот: @CHIP_POKER_bot');
  });
});

module.exports = { getIo };
