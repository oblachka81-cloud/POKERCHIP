const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const { pool } = require('./database/db');
const { TABLE_CONFIG, SITGO_CONFIG } = require('./config/constants');
const { tables, createTable, getOrCreateTableForConfig } = require('./game/table/tableManager');
const { sitgoLobbies, startSitGo } = require('./game/sitgo/sitgoManager');
const { getPaidStarsSessions } = require('./socket/tableSocket');
const { setupAdminRoutes } = require('./admin/adminAuth');
const { setupBot } = require('./bot/telegramBot');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

function noCache(req, res, next) {
  res.setHeader('Cache-Control','no-cache, no-store, must-revalidate');
  res.setHeader('Pragma','no-cache');
  res.setHeader('Expires','0');
  next();
}

app.get('/profile',    noCache, (req,res) => res.sendFile(path.join(__dirname,'../public/profile.html')));
app.get('/lobby',      noCache, (req,res) => res.sendFile(path.join(__dirname,'../public/lobby.html')));
app.get('/game',       noCache, (req,res) => res.sendFile(path.join(__dirname,'../public/index.html')));
app.get('/admin',      noCache, (req,res) => res.sendFile(path.join(__dirname,'../public/admin.html')));
app.get('/leaderboard',noCache, (req,res) => res.sendFile(path.join(__dirname,'../public/leaderboard.html')));
app.get('/sitgo',      noCache, (req,res) => res.sendFile(path.join(__dirname,'../public/Sitgo.html')));

app.get('/api/player/:telegramId', async (req,res) => {
  try {
    const player = await pool.query('SELECT * FROM players WHERE telegram_id=$1', [req.params.telegramId]);
    if (!player.rows[0]) return res.json({ balance:1000, stars_balance:0, games_played:0, games_won:0, rank:'—' });
    const rankRes = await pool.query('SELECT COUNT(*) as rank FROM players WHERE balance>$1', [player.rows[0].balance]);
    res.json({ ...player.rows[0], rank: parseInt(rankRes.rows[0].rank)+1 });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get('/api/leaderboard', async (req,res) => {
  try {
    const result = await pool.query('SELECT telegram_id,name,photo,balance,stars_balance,games_played,games_won FROM players ORDER BY balance DESC LIMIT 10');
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get('/api/leaderboard/:telegramId', async (req,res) => {
  try {
    const { telegramId } = req.params;
    const top = await pool.query('SELECT telegram_id,name,photo,balance,games_played,games_won FROM players ORDER BY balance DESC LIMIT 10');
    const rankRes = await pool.query('SELECT COUNT(*) as rank FROM players WHERE balance>(SELECT balance FROM players WHERE telegram_id=$1)', [telegramId]);
    const totalRes = await pool.query('SELECT COUNT(*) as total FROM players');
    res.json({ top:top.rows, myRank:parseInt(rankRes.rows[0].rank)+1, total:parseInt(totalRes.rows[0].total) });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/join-stars-table', async (req,res) => {
  const { telegramId, tableConfigId } = req.body;
  const config = TABLE_CONFIG[tableConfigId];
  if (!config || config.type !== 'stars') return res.status(400).json({ error:'Invalid table' });
  try {
    const player = await pool.query('SELECT stars_balance FROM players WHERE telegram_id=$1', [telegramId]);
    if (!player.rows[0]) return res.status(404).json({ error:'Player not found' });
    if (player.rows[0].stars_balance < config.entryStars) return res.json({ ok:false, error:`Нужно ${config.entryStars} Stars` });
    await pool.query('UPDATE players SET stars_balance=stars_balance-$2, updated_at=NOW() WHERE telegram_id=$1', [telegramId, config.entryStars]);
    getPaidStarsSessions().set(`${telegramId}:${tableConfigId}`, Date.now()+120000);
    res.json({ ok:true, entryPaid:config.entryStars });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get('/tables', (req, res) => {
  Object.keys(TABLE_CONFIG).forEach(configId => {
    const hasFree = Object.values(tables).some(t => t.configId === configId && t.players.length < 6);
    if (!hasFree) {
      const newId = configId + '_' + Date.now() + '_' + Math.random().toString(36).substr(2,4);
      tables[newId] = createTable(newId, configId);
    }
  });
  res.json(Object.values(tables).map(t => ({
    id: t.id, configId: t.configId, config: t.config,
    players: t.players.length, status: t.status, maxPlayers: 6
  })));
});

app.get('/api/auto-table', (req, res) => {
  const { configId } = req.query;
  if (!configId || !TABLE_CONFIG[configId]) return res.status(400).json({ error: 'Invalid configId' });
  const t = getOrCreateTableForConfig(configId);
  res.json({ tableId: t.id, configId: t.configId, players: t.players.length, status: t.status });
});

app.get('/api/sitgo/list', (req,res) => {
  const list = Object.entries(sitgoLobbies).map(([id,lobby]) => ({
    id, configId:lobby.configId, config:SITGO_CONFIG[lobby.configId],
    players:lobby.players.length, maxPlayers:SITGO_CONFIG[lobby.configId].maxPlayers, status:lobby.status,
  }));
  res.json(list);
});

app.post('/api/sitgo/register', async (req,res) => {
  const { telegramId, configId } = req.body;
  const config = SITGO_CONFIG[configId];
  if (!config) return res.status(400).json({ error:'Invalid config' });
  try {
    const player = await pool.query('SELECT * FROM players WHERE telegram_id=$1', [telegramId]);
    if (!player.rows[0]) return res.status(404).json({ error:'Player not found' });
    const totalCost = config.buyIn + config.rake;
    if (player.rows[0].stars_balance < totalCost) return res.json({ ok:false, error:`Нужно ${totalCost} Stars`, balance:player.rows[0].stars_balance });
    let lobby = Object.values(sitgoLobbies).find(l => l.configId===configId && l.status==='waiting' && l.players.length<config.maxPlayers);
    if (!lobby) {
      const lobbyId = `sg_${configId}_${Date.now()}`;
      sitgoLobbies[lobbyId] = { id:lobbyId, configId, config, players:[], status:'waiting', prizePool:0, totalRake:0, handsPlayed:0, blindLevel:0 };
      lobby = sitgoLobbies[lobbyId];
    }
    if (lobby.players.find(p => p.telegramId===telegramId)) return res.json({ ok:true, lobbyId:lobby.id, alreadyIn:true });
    await pool.query('UPDATE players SET stars_balance=stars_balance-$2, updated_at=NOW() WHERE telegram_id=$1', [telegramId, totalCost]);
    lobby.players.push({ telegramId, name:player.rows[0].name, photo:player.rows[0].photo, stack:config.startStack, place:null, socketId:null });
    lobby.prizePool += config.buyIn;
    lobby.totalRake += config.rake;
    if (lobby.players.length === config.maxPlayers) {
      lobby.status = 'starting';
      const io = require('./index').getIo();
      setTimeout(() => startSitGo(lobby), 3000);
      io.to(`sitgo_lobby_${lobby.id}`).emit('sitgoLobbyUpdate', {
        players: lobby.players.map(p => ({ name:p.name, photo:p.photo, telegramId:p.telegramId })),
        status: lobby.status, maxPlayers: config.maxPlayers, prizePool: lobby.prizePool,
      });
    } else {
      const io = require('./index').getIo();
      io.to(`sitgo_lobby_${lobby.id}`).emit('sitgoLobbyUpdate', {
        players: lobby.players.map(p => ({ name:p.name, photo:p.photo, telegramId:p.telegramId })),
        status: lobby.status, maxPlayers: config.maxPlayers, prizePool: lobby.prizePool,
      });
    }
    res.json({ ok:true, lobbyId:lobby.id });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/sitgo/unregister', async (req,res) => {
  const { telegramId, lobbyId } = req.body;
  const lobby = sitgoLobbies[lobbyId];
  if (!lobby || lobby.status !== 'waiting') return res.json({ ok:false, error:'Нельзя отменить' });
  const idx = lobby.players.findIndex(p => p.telegramId===telegramId);
  if (idx===-1) return res.json({ ok:false, error:'Игрок не найден' });
  const config = SITGO_CONFIG[lobby.configId];
  const totalCost = config.buyIn + config.rake;
  try {
    await pool.query('UPDATE players SET stars_balance=stars_balance+$2, updated_at=NOW() WHERE telegram_id=$1', [telegramId, totalCost]);
    lobby.players.splice(idx,1);
    lobby.prizePool -= config.buyIn;
    lobby.totalRake -= config.rake;
    const io = require('./index').getIo();
    io.to(`sitgo_lobby_${lobby.id}`).emit('sitgoLobbyUpdate', {
      players: lobby.players.map(p => ({ name:p.name, photo:p.photo, telegramId:p.telegramId })),
      status: lobby.status, maxPlayers: config.maxPlayers, prizePool: lobby.prizePool,
    });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get('/balance/:telegramId', async (req,res) => {
  try {
    const result=await pool.query('SELECT * FROM players WHERE telegram_id=$1',[req.params.telegramId]);
    res.json(result.rows[0]||{balance:0,stars_balance:0});
  } catch(e) { res.status(500).json({error:e.message}); }
});

setupAdminRoutes(app);
setupBot(app);

module.exports = app;
