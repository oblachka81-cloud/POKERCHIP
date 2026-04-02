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

// ===== POSTGRESQL =====
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: false,
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS players (
        telegram_id TEXT PRIMARY KEY,
        name TEXT,
        photo TEXT,
        balance INTEGER DEFAULT 1000,
        games_played INTEGER DEFAULT 0,
        games_won INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ БД инициализирована');
  } catch (e) {
    console.error('❌ Ошибка инициализации БД:', e.message);
  }
}

async function getOrCreatePlayer(telegramId, name, photo) {
  try {
    const res = await pool.query(
      `INSERT INTO players (telegram_id, name, photo, balance)
       VALUES ($1, $2, $3, 1000)
       ON CONFLICT (telegram_id) DO UPDATE
       SET name = $2, photo = $3, updated_at = NOW()
       RETURNING *`,
      [telegramId, name, photo]
    );
    return res.rows[0];
  } catch (e) {
    console.error('❌ getOrCreatePlayer:', e.message);
    return { telegram_id: telegramId, name, balance: 1000 };
  }
}

async function saveBalance(telegramId, balance, won) {
  try {
    await pool.query(
      `UPDATE players SET
        balance = $2,
        games_played = games_played + 1,
        games_won = games_won + $3,
        updated_at = NOW()
       WHERE telegram_id = $1`,
      [telegramId, balance, won ? 1 : 0]
    );
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
        inline_keyboard: [[{ text: '🎮 Играть', web_app: { url: WEBAPP_URL } }]]
      }
    });
  });

  app.post('/create-invoice', async (req, res) => {
    const { amount } = req.body;
    try {
      const result = await bot.telegram.createInvoiceLink(
        `⭐ ${amount} Stars`, 'Пополнение баланса',
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
    const chips = stars * 10; // 1 Star = 10 фишек
    try {
      await pool.query(
        `UPDATE players SET balance = balance + $2, updated_at = NOW() WHERE telegram_id = $1`,
        [telegramId, chips]
      );
      ctx.reply(`✅ Получено ${stars} Stars! Зачислено ${chips} фишек.`);
    } catch(e) {
      ctx.reply(`✅ Получено ${stars} Stars!`);
    }
  });

  app.post('/webhook', (req, res) => {
    res.sendStatus(200);
    bot.handleUpdate(req.body).catch(err => console.error('Webhook error:', err));
  });

  bot.telegram.setWebhook(`${WEBAPP_URL}/webhook`)
    .then(() => console.log(`🤖 Webhook установлен: ${WEBAPP_URL}/webhook`))
    .catch(err => console.error('❌ Ошибка webhook:', err.message));
}

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

// ===== СТОЛЫ =====
const tables = {};

function createTable(id) {
  return {
    id, players: [], communityCards: [],
    deck: [], deckIdx: 0, pot: 0, currentBet: 0,
    activePlayer: 0, round: 'waiting', status: 'waiting', winner: null,
  };
}

function getTable(id) {
  if (!tables[id]) tables[id] = createTable(id);
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
      ...t, deck: undefined,
      players: t.players.map(p => ({
        id: p.socketId, telegramId: p.telegramId,
        name: p.name, photo: p.photo || null,
        stack: p.stack, bet: p.bet, folded: p.folded,
        cards: p.telegramId === player.telegramId
          ? p.cards : p.cards.map(() => ({ hidden: true })),
      }))
    });
  });
}

function broadcastShowdown(t) {
  io.to(`table_${t.id}`).emit('gameState', {
    ...t, deck: undefined,
    players: t.players.map(p => ({
      id: p.socketId, telegramId: p.telegramId,
      name: p.name, photo: p.photo || null,
      stack: p.stack, bet: p.bet, folded: p.folded, cards: p.cards,
    }))
  });
}

function startHand(t) {
  t.players.forEach(p => { if (p.stack <= 0) p.stack = 1000; });
  t.deck = shuffle(createDeck());
  t.deckIdx = 0; t.communityCards = []; t.pot = 0; t.currentBet = 0;
  t.status = 'playing'; t.round = 'preflop'; t.winner = null;

  t.players.forEach(p => {
    p.cards = [nextCard(t), nextCard(t)];
    p.bet = 0; p.folded = false; p.hasActed = false;
  });

  const active = activePlayers(t);
  if (active.length < 2) return;

  const sb = active[0], bb = active[1];
  const sbAmt = Math.min(5, sb.stack);
  const bbAmt = Math.min(10, bb.stack);
  sb.stack -= sbAmt; sb.bet = sbAmt; t.pot += sbAmt;
  bb.stack -= bbAmt; bb.bet = bbAmt; t.pot += bbAmt;
  t.currentBet = bbAmt;

  t.activePlayer = findNextActive(t, t.players.indexOf(bb));
  broadcastTable(t);
  console.log(`🃏 Новая раздача на столе ${t.id}`);
}

function advanceRound(t) {
  t.players.forEach(p => { p.bet = 0; p.hasActed = false; });
  t.currentBet = 0;
  t.activePlayer = findNextActive(t, -1);

  if (t.round === 'preflop') {
    t.communityCards = [nextCard(t), nextCard(t), nextCard(t)];
    t.round = 'flop';
  } else if (t.round === 'flop') {
    t.communityCards.push(nextCard(t)); t.round = 'turn';
  } else if (t.round === 'turn') {
    t.communityCards.push(nextCard(t)); t.round = 'river';
  } else if (t.round === 'river') {
    endHand(t); return;
  }
  broadcastTable(t);
}

async function endHand(t) {
  t.round = 'showdown';
  const active = activePlayers(t);
  let winnerPlayer = null;

  if (active.length === 1) {
    active[0].stack += t.pot;
    t.winner = { name: active[0].name, handName: 'Все спасовали' };
    winnerPlayer = active[0];
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
    best.player.stack += t.pot;
    t.winner = { name: best.player.name, handName: best.hand.name };
    winnerPlayer = best.player;
  }

  t.status = 'finished';
  broadcastShowdown(t);
  console.log(`🏆 Стол ${t.id}: победил ${t.winner.name} (${t.winner.handName})`);

  // Сохраняем балансы в PostgreSQL
  for (const p of t.players) {
    await saveBalance(p.telegramId, p.stack, p.telegramId === winnerPlayer?.telegramId);
  }
}

function handleAction(t, telegramId, action, amount) {
  const idx = t.players.findIndex(p => p.telegramId === telegramId);
  if (idx !== t.activePlayer) return;
  const player = t.players[idx];

  switch (action) {
    case 'fold': player.folded = true; player.hasActed = true; break;
    case 'call': {
      const callAmt = Math.max(0, t.currentBet - player.bet);
      const actual = Math.min(callAmt, player.stack);
      player.stack -= actual; player.bet += actual; t.pot += actual;
      player.hasActed = true; break;
    }
    case 'raise': {
      const raiseAmt = Math.min(amount, player.stack);
      player.stack -= raiseAmt; player.bet += raiseAmt; t.pot += raiseAmt;
      if (player.bet > t.currentBet) {
        t.currentBet = player.bet;
        t.players.forEach(p => { if (p.telegramId !== telegramId && !p.folded) p.hasActed = false; });
      }
      player.hasActed = true; break;
    }
    case 'allin': {
      const all = player.stack;
      player.bet += all; player.stack = 0; t.pot += all;
      if (player.bet > t.currentBet) {
        t.currentBet = player.bet;
        t.players.forEach(p => { if (p.telegramId !== telegramId && !p.folded) p.hasActed = false; });
      }
      player.hasActed = true; break;
    }
  }

  if (t.players.filter(p => !p.folded).length === 1) { endHand(t); return; }
  if (allActed(t)) { advanceRound(t); return; }

  const next = findNextActive(t, idx);
  if (next === -1) { advanceRound(t); return; }
  t.activePlayer = next;
  broadcastTable(t);
}

// ===== SOCKET.IO =====
io.on('connection', (socket) => {
  let currentTableId = null;
  let currentTelegramId = null;

  socket.on('joinTable', async ({ tableId, name, photo, telegramId }) => {
    tableId = String(tableId || '1');
    currentTableId = tableId;
    currentTelegramId = telegramId;

    const t = getTable(tableId);
    socket.join(`table_${tableId}`);

    // Чистим призраков
    t.players = t.players.filter(p => {
      if (p.telegramId === telegramId) return true;
      return !!io.sockets.sockets.get(p.socketId);
    });

    const existing = t.players.find(p => p.telegramId === telegramId);
    if (existing) {
      existing.socketId = socket.id;
      existing.name = name || existing.name;
      existing.photo = photo || existing.photo;
      console.log(`🔄 ${name} переподключился к столу ${tableId}`);
    } else if (t.players.length < 6) {
      // Загружаем баланс из БД
      const dbPlayer = await getOrCreatePlayer(telegramId, name, photo);
      t.players.push({
        socketId: socket.id,
        telegramId,
        name: name || 'Игрок',
        photo: photo || null,
        stack: dbPlayer.balance || 1000,
        cards: [], bet: 0,
        folded: false, hasActed: false,
      });
      console.log(`✅ ${name} за столом ${tableId} (баланс: ${dbPlayer.balance})`);
    }
    broadcastTable(t);
  });

  socket.on('startGame', () => {
    const t = tables[currentTableId];
    if (!t) return;
    if (activePlayers(t).length >= 2 && (t.status === 'waiting' || t.status === 'finished')) {
      startHand(t);
    }
  });

  socket.on('action', ({ action, amount }) => {
    const t = tables[currentTableId];
    if (!t || t.status !== 'playing') return;
    handleAction(t, currentTelegramId, action, amount || 0);
  });

  socket.on('disconnect', () => {
    const t = tables[currentTableId];
    if (!t) return;
    const tgId = currentTelegramId;
    setTimeout(() => {
      const player = t.players.find(p => p.telegramId === tgId);
      if (player && !io.sockets.sockets.get(player.socketId)) {
        t.players = t.players.filter(p => p.telegramId !== tgId);
        console.log('👋 Отключился:', player.name);
        if (t.players.length > 0) broadcastTable(t);
      }
    }, 5000);
  });
});

// API для получения баланса
app.get('/balance/:telegramId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM players WHERE telegram_id = $1', [req.params.telegramId]);
    res.json(result.rows[0] || { balance: 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/tables', (req, res) => {
  res.json(Object.values(tables).map(t => ({
    id: t.id, players: t.players.length, status: t.status, maxPlayers: 6,
  })));
});

// Запуск
initDB().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🃏 Покер запущен на порту ${PORT}`);
    console.log(`🌐 URL: ${WEBAPP_URL}`);
    console.log(`🤖 Бот: @CHIP_POKER_bot`);
  });
});
