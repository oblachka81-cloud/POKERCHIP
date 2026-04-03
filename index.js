const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { Telegraf } = require('telegraf');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*" },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
});

const PORT = process.env.PORT || 3000;
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://chippoker.bothost.tech';
const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// ===== КОНФИГ СТОЛОВ =====
const TABLE_CONFIG = {
  test_bronze:  { type:'test',  tier:'bronze',  sb:10,  bb:20,  rake:0.03, rakeCap:10,  entryStars:0   },
  test_silver:  { type:'test',  tier:'silver',  sb:25,  bb:50,  rake:0.03, rakeCap:25,  entryStars:0   },
  test_gold:    { type:'test',  tier:'gold',    sb:50,  bb:100, rake:0.03, rakeCap:50,  entryStars:0   },
  stars_bronze: { type:'stars', tier:'bronze',  sb:10,  bb:20,  rake:0.03, rakeCap:30,  entryStars:50  },
  stars_silver: { type:'stars', tier:'silver',  sb:25,  bb:50,  rake:0.03, rakeCap:75,  entryStars:200 },
  stars_gold:   { type:'stars', tier:'gold',    sb:50,  bb:100, rake:0.03, rakeCap:150, entryStars:500 },
};

// ===== КОНФИГ SIT & GO =====
const SITGO_CONFIG = {
  sitgo_3_bronze: { maxPlayers:3, tier:'bronze', buyIn:100, rake:10, startStack:1500, sb:10, bb:20 },
  sitgo_3_silver: { maxPlayers:3, tier:'silver', buyIn:500, rake:50, startStack:1500, sb:25, bb:50 },
  sitgo_3_gold:   { maxPlayers:3, tier:'gold',   buyIn:1000, rake:100, startStack:1500, sb:50, bb:100 },
  sitgo_6_bronze: { maxPlayers:6, tier:'bronze', buyIn:100, rake:10, startStack:1500, sb:10, bb:20 },
  sitgo_6_silver: { maxPlayers:6, tier:'silver', buyIn:500, rake:50, startStack:1500, sb:25, bb:50 },
  sitgo_6_gold:   { maxPlayers:6, tier:'gold',   buyIn:1000, rake:100, startStack:1500, sb:50, bb:100 },
};

// Призовые проценты
const PRIZE_DIST = { 1: [100], 2: [100], 3: [60, 30, 10], 4: [60, 30, 10], 5: [60, 30, 10], 6: [60, 30, 10] };

// Структура блайндов -- растут каждые 5 раздач
const BLIND_LEVELS = [
  { sb:10,  bb:20  },
  { sb:20,  bb:40  },
  { sb:40,  bb:80  },
  { sb:75,  bb:150 },
  { sb:150, bb:300 },
  { sb:300, bb:600 },
];

// ===== POSTGRESQL =====
const pool = new Pool({ connectionString: DATABASE_URL, ssl: false });

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS players (
        telegram_id TEXT PRIMARY KEY,
        name TEXT,
        photo TEXT,
        balance INTEGER DEFAULT 1000,
        stars_balance INTEGER DEFAULT 0,
        games_played INTEGER DEFAULT 0,
        games_won INTEGER DEFAULT 0,
        total_rake INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS house (
        id SERIAL PRIMARY KEY,
        table_id TEXT,
        table_type TEXT,
        rake_amount INTEGER,
        pot_amount INTEGER,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sitgo_results (
        id SERIAL PRIMARY KEY,
        sitgo_id TEXT,
        config_id TEXT,
        telegram_id TEXT,
        player_name TEXT,
        place INTEGER,
        prize_stars INTEGER,
        buy_in INTEGER,
        rake INTEGER,
        hands_played INTEGER,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS stars_balance INTEGER DEFAULT 0`);
    await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS total_rake INTEGER DEFAULT 0`);
    console.log('✅ БД инициализирована');
  } catch (e) {
    console.error('❌ Ошибка инициализации БД:', e.message);
  }
}

async function getOrCreatePlayer(telegramId, name, photo) {
  try {
    const res = await pool.query(
      `INSERT INTO players (telegram_id, name, photo, balance, stars_balance)
       VALUES ($1, $2, $3, 1000, 0)
       ON CONFLICT (telegram_id) DO UPDATE
       SET name = $2, photo = $3, updated_at = NOW()
       RETURNING *`,
      [telegramId, name, photo]
    );
    return res.rows[0];
  } catch (e) {
    console.error('❌ getOrCreatePlayer:', e.message);
    return { telegram_id: telegramId, name, balance: 1000, stars_balance: 0 };
  }
}

async function saveBalance(telegramId, balance, starsBalance, won, rakeAmount, tableId, tableType) {
  try {
    await pool.query(
      `UPDATE players SET
        balance = $2,
        stars_balance = $3,
        games_played = games_played + 1,
        games_won = games_won + $4,
        total_rake = total_rake + $5,
        updated_at = NOW()
       WHERE telegram_id = $1`,
      [telegramId, balance, starsBalance, won ? 1 : 0, rakeAmount]
    );
    if (rakeAmount > 0) {
      await pool.query(
        `INSERT INTO house (table_id, table_type, rake_amount, pot_amount) VALUES ($1, $2, $3, $4)`,
        [tableId, tableType, rakeAmount, 0]
      );
    }
  } catch (e) {
    console.error('❌ saveBalance:', e.message);
  }
}

// ===== BOT =====
let bot;
if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);

  bot.start((ctx) => {
    ctx.reply('🃏 Добро пожаловать в Chip Poker!', {
      reply_markup: {
        inline_keyboard: [[{ text: '🎮 Играть', web_app: { url: `${WEBAPP_URL}/profile` } }]]
      }
    });
  });

  app.post('/create-invoice', async (req, res) => {
    const { amount } = req.body;
    try {
      const result = await bot.telegram.createInvoiceLink(
        `🌟 ${amount} Stars`, 'Пополнение Stars баланса в Chip Poker',
        `stars_${Date.now()}`, '', 'XTR',
        [{ label: `${amount} Stars`, amount }]
      );
      res.json({ invoiceLink: result });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  bot.on('pre_checkout_query', (ctx) => ctx.answerPreCheckoutQuery(true));
  bot.on('successful_payment', async (ctx) => {
    const stars = ctx.message.successful_payment.total_amount;
    const telegramId = String(ctx.from.id);
    try {
      await pool.query(
        `UPDATE players SET stars_balance = stars_balance + $2, updated_at = NOW() WHERE telegram_id = $1`,
        [telegramId, stars]
      );
      ctx.reply(`✅ Получено ${stars} Stars! Зачислено на Stars баланс.`);
    } catch(e) { ctx.reply(`✅ Получено ${stars} Stars!`); }
  });

  app.post('/webhook', (req, res) => {
    res.sendStatus(200);
    bot.handleUpdate(req.body).catch(err => console.error('Webhook error:', err));
  });

  bot.telegram.setWebhook(`${WEBAPP_URL}/webhook`)
    .then(() => console.log(`🤖 Webhook установлен: ${WEBAPP_URL}/webhook`))
    .catch(err => console.error('❌ Ошибка webhook:', err.message));
}

// ===== СТРАНИЦЫ =====
function noCache(req, res, next) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
}

app.get('/profile', noCache, (req, res) => res.sendFile(__dirname + '/profile.html'));
app.get('/lobby', noCache, (req, res) => res.sendFile(__dirname + '/lobby.html'));
app.get('/game', noCache, (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/admin', noCache, (req, res) => res.sendFile(__dirname + '/admin.html'));
app.get('/leaderboard', noCache, (req, res) => res.sendFile(__dirname + '/leaderboard.html'));
app.get('/sitgo', noCache, (req, res) => res.sendFile(__dirname + '/sitgo.html'));

// ===== API =====
app.get('/api/player/:telegramId', async (req, res) => {
  try {
    const { telegramId } = req.params;
    const player = await pool.query('SELECT * FROM players WHERE telegram_id = $1', [telegramId]);
    if (!player.rows[0]) return res.json({ balance: 1000, stars_balance: 0, games_played: 0, games_won: 0, rank: '—' });
    const rankRes = await pool.query(
      'SELECT COUNT(*) as rank FROM players WHERE balance > $1',
      [player.rows[0].balance]
    );
    const rank = parseInt(rankRes.rows[0].rank) + 1;
    res.json({ ...player.rows[0], rank });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT telegram_id, name, photo, balance, stars_balance, games_played, games_won FROM players ORDER BY balance DESC LIMIT 10'
    );
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/leaderboard/:telegramId', async (req, res) => {
  try {
    const { telegramId } = req.params;
    const top = await pool.query(
      'SELECT telegram_id, name, photo, balance, games_played, games_won FROM players ORDER BY balance DESC LIMIT 10'
    );
    const rankRes = await pool.query(
      'SELECT COUNT(*) as rank FROM players WHERE balance > (SELECT balance FROM players WHERE telegram_id = $1)',
      [telegramId]
    );
    const myRank = parseInt(rankRes.rows[0].rank) + 1;
    const totalRes = await pool.query('SELECT COUNT(*) as total FROM players');
    res.json({ top: top.rows, myRank, total: parseInt(totalRes.rows[0].total) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// FIX 5: Проверка оплаты Stars + токен сессии
const paidStarsSessions = new Map();

app.post('/api/join-stars-table', async (req, res) => {
  const { telegramId, tableConfigId } = req.body;
  const config = TABLE_CONFIG[tableConfigId];
  if (!config || config.type !== 'stars') return res.status(400).json({ error: 'Invalid table' });

  try {
    const player = await pool.query('SELECT stars_balance FROM players WHERE telegram_id = $1', [telegramId]);
    if (!player.rows[0]) return res.status(404).json({ error: 'Player not found' });

    const starsBalance = player.rows[0].stars_balance;
    if (starsBalance < config.entryStars) {
      return res.json({ ok: false, error: `Нужно ${config.entryStars} Stars`, balance: starsBalance });
    }

    await pool.query(
      'UPDATE players SET stars_balance = stars_balance - $2, updated_at = NOW() WHERE telegram_id = $1',
      [telegramId, config.entryStars]
    );

    paidStarsSessions.set(`${telegramId}:${tableConfigId}`, Date.now() + 120000);
    res.json({ ok: true, entryPaid: config.entryStars });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== SIT & GO API =====

// Список доступных Sit & Go лобби
app.get('/api/sitgo/list', async (req, res) => {
  const list = Object.entries(sitgoLobbies).map(([id, lobby]) => ({
    id,
    configId: lobby.configId,
    config: SITGO_CONFIG[lobby.configId],
    players: lobby.players.length,
    maxPlayers: SITGO_CONFIG[lobby.configId].maxPlayers,
    status: lobby.status,
  }));
  res.json(list);
});

// Зарегистрироваться в Sit & Go
app.post('/api/sitgo/register', async (req, res) => {
  const { telegramId, configId } = req.body;
  const config = SITGO_CONFIG[configId];
  if (!config) return res.status(400).json({ error: 'Invalid config' });

  try {
    const player = await pool.query('SELECT * FROM players WHERE telegram_id = $1', [telegramId]);
    if (!player.rows[0]) return res.status(404).json({ error: 'Player not found' });

    const totalCost = config.buyIn + config.rake;
    if (player.rows[0].stars_balance < totalCost) {
      return res.json({ ok: false, error: `Нужно ${totalCost} Stars (${config.buyIn}+${config.rake})`, balance: player.rows[0].stars_balance });
    }

    // Ищем открытое лобби для этого configId
    let lobby = Object.values(sitgoLobbies).find(l => l.configId === configId && l.status === 'waiting' && l.players.length < config.maxPlayers);

    // Если нет -- создаём новое
    if (!lobby) {
      const lobbyId = `sg_${configId}_${Date.now()}`;
      sitgoLobbies[lobbyId] = {
        id: lobbyId, configId, config,
        players: [], status: 'waiting',
        prizePool: 0, totalRake: 0,
        handsPlayed: 0, blindLevel: 0,
      };
      lobby = sitgoLobbies[lobbyId];
    }

    // Проверяем что игрок ещё не зарегистрирован
    if (lobby.players.find(p => p.telegramId === telegramId)) {
      return res.json({ ok: true, lobbyId: lobby.id, alreadyIn: true });
    }

    // Списываем Stars
    await pool.query(
      'UPDATE players SET stars_balance = stars_balance - $2, updated_at = NOW() WHERE telegram_id = $1',
      [telegramId, totalCost]
    );

    lobby.players.push({
      telegramId,
      name: player.rows[0].name,
      photo: player.rows[0].photo,
      stack: config.startStack,
      place: null,
      socketId: null,
    });
    lobby.prizePool += config.buyIn;
    lobby.totalRake += config.rake;

    console.log(`✅ ${player.rows[0].name} зарегистрировался в Sit&Go ${lobby.id} (${lobby.players.length}/${config.maxPlayers})`);

    // Если набрали всех -- стартуем!
    if (lobby.players.length === config.maxPlayers) {
      lobby.status = 'starting';
      setTimeout(() => startSitGo(lobby), 3000);
    }

    // Уведомляем всех в лобби
    io.to(`sitgo_lobby_${lobby.id}`).emit('sitgoLobbyUpdate', {
      players: lobby.players.map(p => ({ name: p.name, photo: p.photo, telegramId: p.telegramId })),
      status: lobby.status,
      maxPlayers: config.maxPlayers,
      prizePool: lobby.prizePool,
    });

    res.json({ ok: true, lobbyId: lobby.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Отменить регистрацию (возврат Stars если ещё не стартовало)
app.post('/api/sitgo/unregister', async (req, res) => {
  const { telegramId, lobbyId } = req.body;
  const lobby = sitgoLobbies[lobbyId];
  if (!lobby || lobby.status !== 'waiting') return res.json({ ok: false, error: 'Нельзя отменить' });

  const idx = lobby.players.findIndex(p => p.telegramId === telegramId);
  if (idx === -1) return res.json({ ok: false, error: 'Игрок не найден' });

  const config = SITGO_CONFIG[lobby.configId];
  const totalCost = config.buyIn + config.rake;

  try {
    await pool.query(
      'UPDATE players SET stars_balance = stars_balance + $2, updated_at = NOW() WHERE telegram_id = $1',
      [telegramId, totalCost]
    );
    lobby.players.splice(idx, 1);
    lobby.prizePool -= config.buyIn;
    lobby.totalRake -= config.rake;

    io.to(`sitgo_lobby_${lobby.id}`).emit('sitgoLobbyUpdate', {
      players: lobby.players.map(p => ({ name: p.name, photo: p.photo, telegramId: p.telegramId })),
      status: lobby.status,
      maxPlayers: config.maxPlayers,
      prizePool: lobby.prizePool,
    });

    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== ADMIN API =====
app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ ok: true, token: Buffer.from(ADMIN_PASSWORD).toString('base64') });
  } else {
    res.status(401).json({ ok: false, error: 'Неверный пароль' });
  }
});

function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token === Buffer.from(ADMIN_PASSWORD).toString('base64')) next();
  else res.status(401).json({ error: 'Нет доступа' });
}

app.get('/admin/stats', adminAuth, async (req, res) => {
  try {
    const players = await pool.query('SELECT COUNT(*) as count FROM players');
    const topPlayers = await pool.query('SELECT name, balance, stars_balance, games_played, games_won FROM players ORDER BY balance DESC LIMIT 10');
    const totalBalance = await pool.query('SELECT SUM(balance) as total, SUM(stars_balance) as stars_total FROM players');
    const totalRake = await pool.query('SELECT SUM(rake_amount) as total, COUNT(*) as hands FROM house');
    const rakeToday = await pool.query(`SELECT SUM(rake_amount) as today FROM house WHERE created_at > NOW() - INTERVAL '24 hours'`);
    const activeTables = Object.values(tables).filter(t => t.status === 'playing').length;
    const onlinePlayers = Object.values(tables).reduce((acc, t) => acc + t.players.length, 0);
    const activeSitGos = Object.values(sitgoLobbies).filter(l => l.status !== 'finished').length;

    res.json({
      totalPlayers: parseInt(players.rows[0].count),
      topPlayers: topPlayers.rows,
      totalChips: parseInt(totalBalance.rows[0].total) || 0,
      totalStars: parseInt(totalBalance.rows[0].stars_total) || 0,
      totalRake: parseInt(totalRake.rows[0].total) || 0,
      totalHands: parseInt(totalRake.rows[0].hands) || 0,
      rakeToday: parseInt(rakeToday.rows[0].today) || 0,
      activeTables, onlinePlayers, activeSitGos,
      tables: Object.values(tables).map(t => ({
        id: t.id, status: t.status, round: t.round, pot: t.pot,
        tableType: t.config?.type || 'test',
        tier: t.config?.tier || 'bronze',
        players: t.players.map(p => ({ name: p.name, stack: p.stack }))
      }))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/players', adminAuth, async (req, res) => {
  try {
    const search = req.query.search || '';
    const result = await pool.query(
      `SELECT telegram_id, name, balance, stars_balance, games_played, games_won, total_rake, created_at
       FROM players WHERE name ILIKE $1 OR telegram_id ILIKE $1
       ORDER BY balance DESC LIMIT 50`,
      [`%${search}%`]
    );
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// FIX 4: Валидация amount
app.post('/admin/balance', adminAuth, async (req, res) => {
  const { telegramId, amount, type } = req.body;
  const parsedAmount = parseInt(amount);
  if (isNaN(parsedAmount) || parsedAmount < -100000 || parsedAmount > 1000000) {
    return res.status(400).json({ error: 'Некорректная сумма' });
  }
  const field = type === 'stars' ? 'stars_balance' : 'balance';
  try {
    await pool.query(
      `UPDATE players SET ${field} = GREATEST(0, ${field} + $2), updated_at = NOW() WHERE telegram_id = $1`,
      [telegramId, parsedAmount]
    );
    const result = await pool.query('SELECT balance, stars_balance FROM players WHERE telegram_id = $1', [telegramId]);
    res.json({ ok: true, ...result.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/balance/set', adminAuth, async (req, res) => {
  const { telegramId, amount, type } = req.body;
  const parsedAmount = parseInt(amount);
  if (isNaN(parsedAmount) || parsedAmount < 0 || parsedAmount > 10000000) {
    return res.status(400).json({ error: 'Некорректная сумма' });
  }
  const field = type === 'stars' ? 'stars_balance' : 'balance';
  try {
    await pool.query(
      `UPDATE players SET ${field} = $2, updated_at = NOW() WHERE telegram_id = $1`,
      [telegramId, parsedAmount]
    );
    res.json({ ok: true, balance: parsedAmount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/table/close', adminAuth, (req, res) => {
  const { tableId } = req.body;
  if (tables[tableId]) {
    tables[tableId].status = 'waiting';
    tables[tableId].players = [];
    if (tables[tableId].autoStartTimer) clearTimeout(tables[tableId].autoStartTimer);
    if (tables[tableId].nextHandTimer) clearTimeout(tables[tableId].nextHandTimer);
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: 'Стол не найден' });
  }
});

app.get('/admin/rake', adminAuth, async (req, res) => {
  try {
    const byType = await pool.query(`SELECT table_type, SUM(rake_amount) as total, COUNT(*) as hands FROM house GROUP BY table_type ORDER BY total DESC`);
    const byDay = await pool.query(`SELECT DATE(created_at) as day, SUM(rake_amount) as total, COUNT(*) as hands FROM house GROUP BY DATE(created_at) ORDER BY day DESC LIMIT 7`);
    res.json({ byType: byType.rows, byDay: byDay.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== АНАЛИТИКА API =====
app.get('/admin/analytics/finance', adminAuth, async (req, res) => {
  try {
    const rakeByDay = await pool.query(`SELECT DATE(created_at) as day, SUM(rake_amount) as rake, COUNT(*) as hands FROM house WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY DATE(created_at) ORDER BY day ASC`);
    const starsFlow = await pool.query(`SELECT DATE(created_at) as day, SUM(rake_amount) as rake FROM house WHERE table_type LIKE 'stars%' AND created_at > NOW() - INTERVAL '30 days' GROUP BY DATE(created_at) ORDER BY day ASC`);
    const periods = await pool.query(`SELECT SUM(CASE WHEN created_at > NOW() - INTERVAL '1 day' THEN rake_amount ELSE 0 END) as today, SUM(CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN rake_amount ELSE 0 END) as week, SUM(CASE WHEN created_at > NOW() - INTERVAL '30 days' THEN rake_amount ELSE 0 END) as month, SUM(rake_amount) as all_time FROM house`);
    res.json({ rakeByDay: rakeByDay.rows, starsFlow: starsFlow.rows, periods: periods.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/analytics/players', adminAuth, async (req, res) => {
  try {
    const newByDay = await pool.query(`SELECT DATE(created_at) as day, COUNT(*) as count FROM players WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY DATE(created_at) ORDER BY day ASC`);
    const activeToday = await pool.query(`SELECT COUNT(*) as count FROM players WHERE updated_at > NOW() - INTERVAL '1 day'`);
    const activeWeek  = await pool.query(`SELECT COUNT(*) as count FROM players WHERE updated_at > NOW() - INTERVAL '7 days'`);
    const activeMonth = await pool.query(`SELECT COUNT(*) as count FROM players WHERE updated_at > NOW() - INTERVAL '30 days'`);
    const topByStars  = await pool.query(`SELECT name, telegram_id, total_rake, games_played, games_won, stars_balance FROM players ORDER BY total_rake DESC LIMIT 10`);
    const inactive = await pool.query(`SELECT name, telegram_id, balance, stars_balance, EXTRACT(EPOCH FROM (NOW() - updated_at)) as last_seen FROM players WHERE updated_at < NOW() - INTERVAL '7 days' ORDER BY updated_at ASC LIMIT 20`);
    const retention = await pool.query(`SELECT COUNT(*) as total, SUM(CASE WHEN games_played > 1 THEN 1 ELSE 0 END) as returned, SUM(CASE WHEN games_played >= 10 THEN 1 ELSE 0 END) as loyal FROM players`);
    res.json({ newByDay: newByDay.rows, active: { today: parseInt(activeToday.rows[0].count), week: parseInt(activeWeek.rows[0].count), month: parseInt(activeMonth.rows[0].count) }, topByStars: topByStars.rows, inactive: inactive.rows, retention: retention.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/analytics/tables', adminAuth, async (req, res) => {
  try {
    const tablePopularity = await pool.query(`SELECT table_type, COUNT(*) as hands, SUM(rake_amount) as total_rake, MAX(created_at) as last_hand FROM house GROUP BY table_type ORDER BY hands DESC`);
    const peakHours = await pool.query(`SELECT EXTRACT(HOUR FROM created_at) as hour, COUNT(*) as hands FROM house GROUP BY EXTRACT(HOUR FROM created_at) ORDER BY hour ASC`);
    const byDayOfWeek = await pool.query(`SELECT EXTRACT(DOW FROM created_at) as dow, COUNT(*) as hands FROM house GROUP BY EXTRACT(DOW FROM created_at) ORDER BY dow ASC`);
    const handsPerHour = await pool.query(`SELECT COUNT(*) as total_hands, EXTRACT(EPOCH FROM (MAX(created_at) - MIN(created_at)))/3600 as hours FROM house WHERE created_at > NOW() - INTERVAL '7 days'`);
    const hph = handsPerHour.rows[0];
    const avgHandsPerHour = hph.hours > 0 ? (hph.total_hands / hph.hours).toFixed(1) : 0;
    res.json({ tablePopularity: tablePopularity.rows, peakHours: peakHours.rows, byDayOfWeek: byDayOfWeek.rows, avgHandsPerHour });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== КАРТЫ =====
function createDeck() {
  const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  const suits = ['hearts','diamonds','clubs','spades'];
  const deck = [];
  for (const suit of suits)
    for (const rank of ranks)
      deck.push({ rank, suit });
  return deck;
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function validateDeck(deck) {
  const seen = new Set();
  for (const card of deck) {
    const key = `${card.rank}_${card.suit}`;
    if (seen.has(key)) { console.error(`❌ ДУБЛИКАТ: ${key}`); return false; }
    seen.add(key);
  }
  return true;
}

function createValidDeck() {
  let deck;
  do { deck = shuffle(createDeck()); } while (!validateDeck(deck));
  return deck;
}

function rankToNum(r) {
  return {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14}[r];
}

function eval5(cards) {
  const nums = cards.map(c => rankToNum(c.rank)).sort((a,b) => b-a);
  const suits = cards.map(c => c.suit);
  const flush = suits.every(s => s === suits[0]);
  const counts = {};
  nums.forEach(n => counts[n] = (counts[n]||0)+1);
  const groups = Object.entries(counts).map(([r,c]) => ({r:+r,c})).sort((a,b) => b.c-a.c||b.r-a.r);
  const gc = groups.map(g => g.c);
  const gv = groups.map(g => g.r);
  const uniq = [...new Set(nums)];
  let straight = false, sHigh = nums[0];
  if (uniq.length >= 5) {
    for (let i = 0; i <= uniq.length-5; i++) {
      if (uniq[i]-uniq[i+4] === 4) { straight = true; sHigh = uniq[i]; break; }
    }
    if (!straight && [14,5,4,3,2].every(v => uniq.includes(v))) { straight = true; sHigh = 5; }
  }
  if (straight && flush) return { rank:9, val:[sHigh], name:'Стрит-флеш' };
  if (gc[0]===4) return { rank:8, val:gv, name:'Каре' };
  if (gc[0]===3&&gc[1]===2) return { rank:7, val:gv, name:'Фулл-хаус' };
  if (flush) return { rank:6, val:nums, name:'Флеш' };
  if (straight) return { rank:5, val:[sHigh], name:'Стрит' };
  if (gc[0]===3) return { rank:4, val:gv, name:'Тройка' };
  if (gc[0]===2&&gc[1]===2) return { rank:3, val:gv, name:'Две пары' };
  if (gc[0]===2) return { rank:2, val:gv, name:'Пара' };
  return { rank:1, val:nums, name:'Старшая карта' };
}

function bestHand(cards) {
  const result = [];
  for (let a=0; a<cards.length-4; a++)
    for (let b=a+1; b<cards.length-3; b++)
      for (let c=b+1; c<cards.length-2; c++)
        for (let d=c+1; d<cards.length-1; d++)
          for (let e=d+1; e<cards.length; e++)
            result.push(eval5([cards[a],cards[b],cards[c],cards[d],cards[e]]));
  return result.reduce((best, h) => {
    if (!best || h.rank > best.rank) return h;
    if (h.rank === best.rank) {
      for (let i=0; i<Math.min(h.val.length,best.val.length); i++) {
        if (h.val[i] > best.val[i]) return h;
        if (h.val[i] < best.val[i]) return best;
      }
    }
    return best;
  }, null);
}

// ===== ОБЫЧНЫЕ СТОЛЫ =====
const tables = {};

function createTable(id, configId) {
  const config = TABLE_CONFIG[configId] || TABLE_CONFIG.test_bronze;
  return {
    id, configId, config,
    players: [], communityCards: [],
    deck: [], deckIdx: 0, pot: 0, currentBet: 0,
    activePlayer: 0, round: 'waiting', status: 'waiting', winner: null,
    autoStartTimer: null, nextHandTimer: null, countdown: 0,
    handInProgress: false,
  };
}

function getTable(id, configId) {
  if (!tables[id]) tables[id] = createTable(id, configId || 'test_bronze');
  return tables[id];
}

function nextCard(t) { return t.deck[t.deckIdx++]; }
function activePlayers(t) { return t.players.filter(p => !p.folded && p.stack > 0); }

function findNextActive(t, fromIdx) {
  let idx = (fromIdx + 1) % t.players.length;
  for (let i = 0; i < t.players.length; i++) {
    if (!t.players[idx].folded && t.players[idx].stack > 0) return idx;
    idx = (idx + 1) % t.players.length;
  }
  return -1;
}

function allActed(t) {
  return t.players
    .filter(p => !p.folded && p.stack > 0)
    .every(p => p.hasActed && p.bet === t.currentBet || p.stack === 0 && p.hasActed);
}

function broadcastTable(t) {
  t.players.forEach(player => {
    const sock = io.sockets.sockets.get(player.socketId);
    if (!sock) return;
    sock.emit('gameState', {
      ...t, deck: undefined, autoStartTimer: undefined, nextHandTimer: undefined,
      players: t.players.map(p => ({
        id: p.socketId, telegramId: p.telegramId,
        name: p.name, photo: p.photo || null,
        stack: p.stack, bet: p.bet, folded: p.folded,
        isWaiting: p.isWaiting || false,
        cards: p.telegramId === player.telegramId
          ? p.cards : p.cards.map(() => ({ hidden: true })),
      }))
    });
  });
}

function broadcastShowdown(t) {
  io.to(`table_${t.id}`).emit('gameState', {
    ...t, deck: undefined, autoStartTimer: undefined, nextHandTimer: undefined,
    players: t.players.map(p => ({
      id: p.socketId, telegramId: p.telegramId,
      name: p.name, photo: p.photo || null,
      stack: p.stack, bet: p.bet, folded: p.folded,
      isWaiting: p.isWaiting || false, cards: p.cards,
    }))
  });
}

function checkAutoStart(t) {
  if (t.autoStartTimer) { clearTimeout(t.autoStartTimer); t.autoStartTimer = null; }
  const readyPlayers = t.players.filter(p => !p.isWaiting && p.stack > 0);
  if (readyPlayers.length >= 2 && t.status === 'waiting') {
    t.countdown = 3; broadcastTable(t);
    t.autoStartTimer = setTimeout(() => {
      t.autoStartTimer = null;
      const ready = t.players.filter(p => !p.isWaiting && p.stack > 0);
      if (ready.length >= 2 && t.status === 'waiting') startHand(t);
    }, 3000);
  } else { t.countdown = 0; broadcastTable(t); }
}

function scheduleNextHand(t) {
  if (t.nextHandTimer) { clearTimeout(t.nextHandTimer); t.nextHandTimer = null; }
  t.handInProgress = false;
  t.players.forEach(p => { p.isWaiting = false; });
  t.countdown = 5; broadcastTable(t);
  t.nextHandTimer = setTimeout(() => {
    t.nextHandTimer = null;
    if (activePlayers(t).length >= 2) startHand(t);
    else { t.status = 'waiting'; t.countdown = 0; broadcastTable(t); }
  }, 5000);
}

function startHand(t) {
  if (t.handInProgress) { console.warn(`⚠️ startHand повторно стол ${t.id}`); return; }
  t.handInProgress = true;
  t.players.forEach(p => { if (p.stack <= 0) p.stack = 1000; });
  t.deck = createValidDeck();
  t.deckIdx = 0; t.communityCards = []; t.pot = 0; t.currentBet = 0;
  t.status = 'playing'; t.round = 'preflop'; t.winner = null; t.countdown = 0;

  const activePlrs = t.players.filter(p => !p.isWaiting);
  activePlrs.forEach(p => { p.cards = [nextCard(t), nextCard(t)]; p.bet = 0; p.folded = false; p.hasActed = false; });
  t.players.filter(p => p.isWaiting).forEach(p => { p.cards = []; p.bet = 0; p.folded = true; p.hasActed = true; });

  const active = activePlrs.filter(p => p.stack > 0);
  if (active.length < 2) { t.handInProgress = false; return; }

  const sb = active[0], bb = active[1];
  const sbAmt = Math.min(t.config.sb, sb.stack);
  const bbAmt = Math.min(t.config.bb, bb.stack);
  sb.stack -= sbAmt; sb.bet = sbAmt; t.pot += sbAmt;
  bb.stack -= bbAmt; bb.bet = bbAmt; t.pot += bbAmt;
  t.currentBet = bbAmt;
  t.activePlayer = findNextActive(t, t.players.indexOf(bb));
  broadcastTable(t);
}

function advanceRound(t) {
  t.players.forEach(p => { p.bet = 0; p.hasActed = false; });
  t.currentBet = 0;
  t.activePlayer = findNextActive(t, -1);
  if (t.round === 'preflop') { t.communityCards = [nextCard(t), nextCard(t), nextCard(t)]; t.round = 'flop'; }
  else if (t.round === 'flop') { t.communityCards.push(nextCard(t)); t.round = 'turn'; }
  else if (t.round === 'turn') { t.communityCards.push(nextCard(t)); t.round = 'river'; }
  else if (t.round === 'river') { endHand(t); return; }
  broadcastTable(t);
}

async function endHand(t) {
  t.round = 'showdown';
  const active = t.players.filter(p => !p.folded && !p.isWaiting && p.stack >= 0);
  let winnerPlayer = null;
  const rakeAmount = Math.min(Math.floor(t.pot * t.config.rake), t.config.rakeCap);
  const potAfterRake = t.pot - rakeAmount;

  if (active.length === 1) {
    active[0].stack += potAfterRake; t.winner = { name: active[0].name, handName: 'Все спасовали' }; winnerPlayer = active[0];
  } else if (active.length === 0) {
    t.winner = { name: '—', handName: 'Нет активных игроков' };
  } else {
    const evals = active.map(p => ({ player: p, hand: bestHand([...p.cards, ...t.communityCards]) }));
    let best = evals[0];
    for (const e of evals.slice(1)) {
      if (e.hand.rank > best.hand.rank) { best = e; continue; }
      if (e.hand.rank === best.hand.rank) {
        for (let i=0; i<Math.min(e.hand.val.length,best.hand.val.length); i++) {
          if (e.hand.val[i] > best.hand.val[i]) { best = e; break; }
          if (e.hand.val[i] < best.hand.val[i]) break;
        }
      }
    }
    best.player.stack += potAfterRake; t.winner = { name: best.player.name, handName: best.hand.name }; winnerPlayer = best.player;
  }

  t.winner.rake = rakeAmount; t.status = 'finished';
  broadcastShowdown(t);

  for (const p of t.players) {
    if (p.isWaiting) continue;
    const isWinner = p.telegramId === winnerPlayer?.telegramId;
    const playerRake = isWinner ? rakeAmount : 0;
    if (t.config.type === 'stars') {
      const dbPlayer = await pool.query('SELECT balance FROM players WHERE telegram_id = $1', [p.telegramId]);
      const currentBalance = dbPlayer.rows[0]?.balance ?? p.dbBalance ?? 1000;
      await saveBalance(p.telegramId, currentBalance, p.stack, isWinner, playerRake, t.id, t.configId);
    } else {
      const dbPlayer = await pool.query('SELECT stars_balance FROM players WHERE telegram_id = $1', [p.telegramId]);
      const currentStars = dbPlayer.rows[0]?.stars_balance ?? p.dbStarsBalance ?? 0;
      await saveBalance(p.telegramId, p.stack, currentStars, isWinner, playerRake, t.id, t.configId);
    }
  }
  scheduleNextHand(t);
}

function handleAction(t, telegramId, action, amount) {
  const idx = t.players.findIndex(p => p.telegramId === telegramId);
  if (idx !== t.activePlayer) return;
  const player = t.players[idx];
  if (player.isWaiting) return;

  switch (action) {
    case 'fold': player.folded = true; player.hasActed = true; break;
    case 'call': { const callAmt = Math.max(0, t.currentBet - player.bet); const actual = Math.min(callAmt, player.stack); player.stack -= actual; player.bet += actual; t.pot += actual; player.hasActed = true; break; }
    case 'raise': { const raiseAmt = Math.min(amount, player.stack); player.stack -= raiseAmt; player.bet += raiseAmt; t.pot += raiseAmt; if (player.bet > t.currentBet) { t.currentBet = player.bet; t.players.forEach(p => { if (p.telegramId !== telegramId && !p.folded) p.hasActed = false; }); } player.hasActed = true; break; }
    case 'allin': { const all = player.stack; player.bet += all; player.stack = 0; t.pot += all; if (player.bet > t.currentBet) { t.currentBet = player.bet; t.players.forEach(p => { if (p.telegramId !== telegramId && !p.folded) p.hasActed = false; }); } player.hasActed = true; break; }
  }

  if (t.players.filter(p => !p.folded && !p.isWaiting).length === 1) { endHand(t); return; }
  if (allActed(t)) { advanceRound(t); return; }
  const next = findNextActive(t, idx);
  if (next === -1) { advanceRound(t); return; }
  t.activePlayer = next;
  broadcastTable(t);
}

// ===== SIT & GO ЛОГИКА =====
const sitgoLobbies = {};

function broadcastSitGo(sg) {
  const activePlrs = sg.players.filter(p => !p.eliminated);
  sg.players.forEach(player => {
    const sock = io.sockets.sockets.get(player.socketId);
    if (!sock) return;
    sock.emit('sitgoState', {
      id: sg.id, configId: sg.configId,
      status: sg.status, round: sg.round, pot: sg.pot,
      communityCards: sg.communityCards,
      currentBet: sg.currentBet, countdown: sg.countdown || 0,
      blindLevel: sg.blindLevel, handsPlayed: sg.handsPlayed,
      sb: sg.currentSb, bb: sg.currentBb,
      winner: sg.winner || null,
      prizePool: sg.prizePool,
      players: sg.players.map(p => ({
        telegramId: p.telegramId, name: p.name, photo: p.photo,
        stack: p.stack, bet: p.bet, folded: p.folded,
        eliminated: p.eliminated, place: p.place,
        isWaiting: p.isWaiting || false,
        cards: p.telegramId === player.telegramId && !p.eliminated
          ? p.cards : p.cards ? p.cards.map(() => ({ hidden: true })) : [],
      }))
    });
  });
}

function broadcastSitGoShowdown(sg) {
  io.to(`sitgo_${sg.id}`).emit('sitgoState', {
    id: sg.id, configId: sg.configId,
    status: sg.status, round: sg.round, pot: sg.pot,
    communityCards: sg.communityCards,
    currentBet: sg.currentBet, countdown: sg.countdown || 0,
    blindLevel: sg.blindLevel, handsPlayed: sg.handsPlayed,
    sb: sg.currentSb, bb: sg.currentBb,
    winner: sg.winner || null,
    prizePool: sg.prizePool,
    players: sg.players.map(p => ({
      telegramId: p.telegramId, name: p.name, photo: p.photo,
      stack: p.stack, bet: p.bet, folded: p.folded,
      eliminated: p.eliminated, place: p.place,
      isWaiting: p.isWaiting || false, cards: p.cards || [],
    }))
  });
}

function startSitGo(sg) {
  const config = SITGO_CONFIG[sg.configId];
  sg.status = 'playing';
  sg.handsPlayed = 0;
  sg.blindLevel = 0;
  sg.currentSb = BLIND_LEVELS[0].sb;
  sg.currentBb = BLIND_LEVELS[0].bb;
  sg.communityCards = [];
  sg.pot = 0; sg.currentBet = 0;
  sg.deck = []; sg.deckIdx = 0;
  sg.round = 'waiting';
  sg.winner = null;
  sg.handInProgress = false;
  sg.nextHandTimer = null;

  // Все игроки активны
  sg.players.forEach(p => {
    p.stack = config.startStack;
    p.cards = []; p.bet = 0; p.folded = false;
    p.hasActed = false; p.eliminated = false;
    p.place = null; p.isWaiting = false;
  });

  console.log(`🏆 Sit&Go ${sg.id} стартует! ${sg.players.length} игроков`);
  io.to(`sitgo_lobby_${sg.id}`).emit('sitgoStarting', { lobbyId: sg.id });

  setTimeout(() => startSitGoHand(sg), 3000);
}

function getSitGoActivePlayers(sg) {
  return sg.players.filter(p => !p.eliminated && !p.folded && p.stack > 0);
}

function getSitGoNonEliminated(sg) {
  return sg.players.filter(p => !p.eliminated);
}

function findNextActiveSitGo(sg, fromIdx) {
  const players = sg.players;
  let idx = (fromIdx + 1) % players.length;
  for (let i = 0; i < players.length; i++) {
    if (!players[idx].folded && !players[idx].eliminated && players[idx].stack > 0) return idx;
    idx = (idx + 1) % players.length;
  }
  return -1;
}

function allActedSitGo(sg) {
  return sg.players
    .filter(p => !p.folded && !p.eliminated && p.stack > 0)
    .every(p => p.hasActed && p.bet === sg.currentBet || p.stack === 0 && p.hasActed);
}

function startSitGoHand(sg) {
  if (sg.handInProgress) return;
  sg.handInProgress = true;

  // Обновляем уровень блайндов каждые 5 раздач
  const newBlindLevel = Math.min(Math.floor(sg.handsPlayed / 5), BLIND_LEVELS.length - 1);
  if (newBlindLevel !== sg.blindLevel) {
    sg.blindLevel = newBlindLevel;
    sg.currentSb = BLIND_LEVELS[newBlindLevel].sb;
    sg.currentBb = BLIND_LEVELS[newBlindLevel].bb;
    console.log(`📈 Sit&Go ${sg.id}: блайнды выросли до ${sg.currentSb}/${sg.currentBb}`);
  }

  sg.deck = createValidDeck();
  sg.deckIdx = 0; sg.communityCards = []; sg.pot = 0; sg.currentBet = 0;
  sg.status = 'playing'; sg.round = 'preflop'; sg.winner = null; sg.countdown = 0;
  sg.handsPlayed++;

  const activePlrs = getSitGoNonEliminated(sg);
  activePlrs.forEach(p => {
    p.cards = [sg.deck[sg.deckIdx++], sg.deck[sg.deckIdx++]];
    p.bet = 0; p.folded = false; p.hasActed = false;
  });

  if (activePlrs.length < 2) { sg.handInProgress = false; return; }

  const sb = activePlrs[0], bb = activePlrs[1];
  const sbAmt = Math.min(sg.currentSb, sb.stack);
  const bbAmt = Math.min(sg.currentBb, bb.stack);
  sb.stack -= sbAmt; sb.bet = sbAmt; sg.pot += sbAmt;
  bb.stack -= bbAmt; bb.bet = bbAmt; sg.pot += bbAmt;
  sg.currentBet = bbAmt;
  sg.activePlayer = findNextActiveSitGo(sg, sg.players.indexOf(bb));

  broadcastSitGo(sg);
}

function advanceRoundSitGo(sg) {
  sg.players.forEach(p => { p.bet = 0; p.hasActed = false; });
  sg.currentBet = 0;
  sg.activePlayer = findNextActiveSitGo(sg, -1);

  if (sg.round === 'preflop') { sg.communityCards = [sg.deck[sg.deckIdx++], sg.deck[sg.deckIdx++], sg.deck[sg.deckIdx++]]; sg.round = 'flop'; }
  else if (sg.round === 'flop') { sg.communityCards.push(sg.deck[sg.deckIdx++]); sg.round = 'turn'; }
  else if (sg.round === 'turn') { sg.communityCards.push(sg.deck[sg.deckIdx++]); sg.round = 'river'; }
  else if (sg.round === 'river') { endSitGoHand(sg); return; }
  broadcastSitGo(sg);
}

async function endSitGoHand(sg) {
  sg.round = 'showdown';
  const active = sg.players.filter(p => !p.folded && !p.eliminated);
  let winnerPlayer = null;

  if (active.length === 1) {
    active[0].stack += sg.pot;
    sg.winner = { name: active[0].name, handName: 'Все спасовали' };
    winnerPlayer = active[0];
  } else if (active.length > 1) {
    const evals = active.map(p => ({ player: p, hand: bestHand([...p.cards, ...sg.communityCards]) }));
    let best = evals[0];
    for (const e of evals.slice(1)) {
      if (e.hand.rank > best.hand.rank) { best = e; continue; }
      if (e.hand.rank === best.hand.rank) {
        for (let i=0; i<Math.min(e.hand.val.length,best.hand.val.length); i++) {
          if (e.hand.val[i] > best.hand.val[i]) { best = e; break; }
          if (e.hand.val[i] < best.hand.val[i]) break;
        }
      }
    }
    best.player.stack += sg.pot;
    sg.winner = { name: best.player.name, handName: best.hand.name };
    winnerPlayer = best.player;
  }

  sg.status = 'finished_hand';
  broadcastSitGoShowdown(sg);

  // Проверяем выбывших
  const currentPlacesAwarded = sg.players.filter(p => p.eliminated).length;
  sg.players.forEach(p => {
    if (!p.eliminated && p.stack <= 0) {
      p.eliminated = true;
      const totalPlayers = sg.players.length;
      p.place = totalPlayers - currentPlacesAwarded;
      console.log(`💀 ${p.name} выбыл на ${p.place} месте в Sit&Go ${sg.id}`);

      // Уведомляем игрока о выбывании
      const sock = io.sockets.sockets.get(p.socketId);
      if (sock) sock.emit('sitgoEliminated', { place: p.place, prizePool: sg.prizePool });
    }
  });

  // Считаем оставшихся
  const remaining = sg.players.filter(p => !p.eliminated);

  // Если остался один -- турнир окончен!
  if (remaining.length === 1) {
    remaining[0].place = 1;
    await finishSitGo(sg);
    return;
  }

  // Следующая раздача через 5 секунд
  sg.handInProgress = false;
  sg.countdown = 5;
  broadcastSitGo(sg);
  sg.nextHandTimer = setTimeout(() => {
    sg.countdown = 0;
    startSitGoHand(sg);
  }, 5000);
}

async function finishSitGo(sg) {
  sg.status = 'finished';
  const config = SITGO_CONFIG[sg.configId];
  const totalPlayers = sg.players.length;
  const prizeDist = PRIZE_DIST[totalPlayers] || [100];

  console.log(`🏆 Sit&Go ${sg.id} завершён! Призовой фонд: ${sg.prizePool} Stars`);

  // Раздаём призы
  const sorted = [...sg.players].sort((a, b) => a.place - b.place);
  for (let i = 0; i < sorted.length; i++) {
    const player = sorted[i];
    const pct = prizeDist[i] || 0;
    const prize = Math.floor(sg.prizePool * pct / 100);
    player.prizeStars = prize;

    if (prize > 0) {
      try {
        await pool.query(
          'UPDATE players SET stars_balance = stars_balance + $2, updated_at = NOW() WHERE telegram_id = $1',
          [player.telegramId, prize]
        );
        console.log(`💰 ${player.name} получил ${prize} Stars (${pct}% - место ${player.place})`);
      } catch(e) { console.error('❌ Ошибка начисления приза:', e.message); }
    }

    // Сохраняем результат
    try {
      await pool.query(
        `INSERT INTO sitgo_results (sitgo_id, config_id, telegram_id, player_name, place, prize_stars, buy_in, rake, hands_played)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [sg.id, sg.configId, player.telegramId, player.name, player.place, prize, config.buyIn, config.rake, sg.handsPlayed]
      );
    } catch(e) { console.error('❌ Ошибка сохранения результата:', e.message); }

    // Уведомляем игрока о финале
    const sock = io.sockets.sockets.get(player.socketId);
    if (sock) sock.emit('sitgoFinished', { place: player.place, prize, prizePool: sg.prizePool, players: sorted.map(p => ({ name: p.name, place: p.place, prize: p.prizeStars || 0 })) });
  }

  // Записываем рейк
  try {
    await pool.query(
      `INSERT INTO house (table_id, table_type, rake_amount, pot_amount) VALUES ($1, $2, $3, $4)`,
      [sg.id, `sitgo_${sg.configId}`, sg.totalRake, sg.prizePool]
    );
  } catch(e) { console.error('❌ Ошибка записи рейка:', e.message); }

  broadcastSitGoShowdown(sg);

  // Удаляем лобби через 60 секунд
  setTimeout(() => { delete sitgoLobbies[sg.id]; }, 60000);
}

function handleSitGoAction(sg, telegramId, action, amount) {
  const idx = sg.players.findIndex(p => p.telegramId === telegramId);
  if (idx !== sg.activePlayer) return;
  const player = sg.players[idx];
  if (player.eliminated || player.isWaiting) return;

  switch (action) {
    case 'fold': player.folded = true; player.hasActed = true; break;
    case 'call': { const callAmt = Math.max(0, sg.currentBet - player.bet); const actual = Math.min(callAmt, player.stack); player.stack -= actual; player.bet += actual; sg.pot += actual; player.hasActed = true; break; }
    case 'raise': { const raiseAmt = Math.min(amount, player.stack); player.stack -= raiseAmt; player.bet += raiseAmt; sg.pot += raiseAmt; if (player.bet > sg.currentBet) { sg.currentBet = player.bet; sg.players.forEach(p => { if (p.telegramId !== telegramId && !p.folded && !p.eliminated) p.hasActed = false; }); } player.hasActed = true; break; }
    case 'allin': { const all = player.stack; player.bet += all; player.stack = 0; sg.pot += all; if (player.bet > sg.currentBet) { sg.currentBet = player.bet; sg.players.forEach(p => { if (p.telegramId !== telegramId && !p.folded && !p.eliminated) p.hasActed = false; }); } player.hasActed = true; break; }
  }

  if (sg.players.filter(p => !p.folded && !p.eliminated).length === 1) { endSitGoHand(sg); return; }
  if (allActedSitGo(sg)) { advanceRoundSitGo(sg); return; }
  const next = findNextActiveSitGo(sg, idx);
  if (next === -1) { advanceRoundSitGo(sg); return; }
  sg.activePlayer = next;
  broadcastSitGo(sg);
}

// ===== SOCKET.IO =====
io.on('connection', (socket) => {
  let currentTableId = null;
  let currentTelegramId = null;
  let currentSitGoId = null;

  // ===== ОБЫЧНЫЙ СТОЛ =====
  socket.on('joinTable', async ({ tableId, name, photo, telegramId, configId }) => {
    tableId = String(tableId || '1');
    currentTableId = tableId;
    currentTelegramId = telegramId;
    const t = getTable(tableId, configId);
    socket.join(`table_${tableId}`);

    if (t.config.type === 'stars') {
      const sessionKey = `${telegramId}:${t.configId}`;
      const sessionExpiry = paidStarsSessions.get(sessionKey);
      const existing = t.players.find(p => p.telegramId === telegramId);
      if (!existing) {
        if (!sessionExpiry || Date.now() > sessionExpiry) {
          socket.emit('error', { message: 'Оплата не найдена. Зайди через лобби.' });
          return;
        }
        paidStarsSessions.delete(sessionKey);
      }
    }

    t.players = t.players.filter(p => {
      if (p.telegramId === telegramId) return true;
      return !!io.sockets.sockets.get(p.socketId);
    });

    const existing = t.players.find(p => p.telegramId === telegramId);
    if (existing) {
      existing.socketId = socket.id;
      existing.name = name || existing.name;
      existing.photo = photo || existing.photo;
    } else if (t.players.length < 6) {
      const dbPlayer = await getOrCreatePlayer(telegramId, name, photo);
      const stack = t.config.type === 'stars' ? dbPlayer.stars_balance || 0 : dbPlayer.balance || 1000;
      const isWaiting = t.status === 'playing';
      t.players.push({
        socketId: socket.id, telegramId,
        name: name || 'Player', photo: photo || null,
        stack, dbBalance: dbPlayer.balance, dbStarsBalance: dbPlayer.stars_balance,
        cards: [], bet: 0, folded: isWaiting, hasActed: isWaiting, isWaiting,
      });
      if (isWaiting) socket.emit('waiting', { message: 'Ждёшь следующей раздачи...' });
    }

    broadcastTable(t);
    if (t.status === 'waiting') checkAutoStart(t);
  });

  socket.on('action', ({ action, amount }) => {
    const t = tables[currentTableId];
    if (!t || t.status !== 'playing') return;
    handleAction(t, currentTelegramId, action, amount || 0);
  });

  socket.on('leaveTable', () => {
    const t = tables[currentTableId];
    if (!t) return;
    t.players = t.players.filter(p => p.telegramId !== currentTelegramId);
    if (t.players.length > 0) {
      broadcastTable(t);
      if (activePlayers(t).length < 2 && t.status === 'playing') endHand(t);
    } else {
      if (t.autoStartTimer) clearTimeout(t.autoStartTimer);
      if (t.nextHandTimer) clearTimeout(t.nextHandTimer);
      t.status = 'waiting'; t.countdown = 0; t.handInProgress = false;
    }
  });

  // ===== SIT & GO СОКЕТЫ =====
  socket.on('joinSitGoLobby', ({ lobbyId, telegramId }) => {
    currentSitGoId = lobbyId;
    currentTelegramId = telegramId;
    socket.join(`sitgo_lobby_${lobbyId}`);
    socket.join(`sitgo_${lobbyId}`);

    const lobby = sitgoLobbies[lobbyId];
    if (!lobby) { socket.emit('sitgoError', { message: 'Лобби не найдено' }); return; }

    // Обновляем socketId игрока
    const player = lobby.players.find(p => p.telegramId === telegramId);
    if (player) player.socketId = socket.id;

    socket.emit('sitgoLobbyUpdate', {
      players: lobby.players.map(p => ({ name: p.name, photo: p.photo, telegramId: p.telegramId })),
      status: lobby.status,
      maxPlayers: SITGO_CONFIG[lobby.configId].maxPlayers,
      prizePool: lobby.prizePool,
    });

    if (lobby.status === 'playing' || lobby.status === 'finished_hand') {
      broadcastSitGo(lobby);
    }
  });

  socket.on('sitgoAction', ({ action, amount }) => {
    const sg = sitgoLobbies[currentSitGoId];
    if (!sg || sg.status === 'finished') return;
    handleSitGoAction(sg, currentTelegramId, action, amount || 0);
  });

  socket.on('leaveSitGo', () => {
    const sg = sitgoLobbies[currentSitGoId];
    if (!sg) return;
    const player = sg.players.find(p => p.telegramId === currentTelegramId);
    if (player && player.eliminated) {
      player.socketId = null;
    }
  });

  socket.on('disconnect', () => {
    // Обычный стол
    const t = tables[currentTableId];
    if (t) {
      const tgId = currentTelegramId;
      setTimeout(() => {
        const player = t.players.find(p => p.telegramId === tgId);
        if (player && !io.sockets.sockets.get(player.socketId)) {
          t.players = t.players.filter(p => p.telegramId !== tgId);
          if (t.players.length > 0) {
            broadcastTable(t);
            if (activePlayers(t).length < 2 && t.status === 'playing') endHand(t);
          } else { t.handInProgress = false; }
        }
      }, 5000);
    }

    // Sit & Go -- не удаляем игрока, просто обнуляем socketId
    const sg = sitgoLobbies[currentSitGoId];
    if (sg) {
      const player = sg.players.find(p => p.telegramId === currentTelegramId);
      if (player) player.socketId = null;
    }
  });
});

app.get('/tables', (req, res) => {
  res.json(Object.values(tables).map(t => ({
    id: t.id, configId: t.configId, config: t.config,
    players: t.players.length, status: t.status, maxPlayers: 6,
  })));
});

app.get('/balance/:telegramId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM players WHERE telegram_id = $1', [req.params.telegramId]);
    res.json(result.rows[0] || { balance: 0, stars_balance: 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

initDB().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🃏 Покер запущен на порту ${PORT}`);
    console.log(`🌐 URL: ${WEBAPP_URL}`);
    console.log(`🤖 Бот: @CHIP_POKER_bot`);
  });
