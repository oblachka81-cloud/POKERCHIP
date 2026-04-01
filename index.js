const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { Telegraf } = require('telegraf');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*" },
  transports: ['websocket', 'polling']
});

// ========== НАСТРОЙКИ ==========
const PORT = process.env.APP_PORT || process.env.PORT || 3000;
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://chippoker.bothost.tech';
const BOT_TOKEN = process.env.BOT_TOKEN;

// ========== TELEGRAM БОТ ==========
let bot;
if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);

  bot.start((ctx) => {
    ctx.reply('🃏 Добро пожаловать в Chip Poker!', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🎮 Играть в покер', web_app: { url: WEBAPP_URL } }]
        ]
      }
    });
  });

  app.post('/create-invoice', async (req, res) => {
    const { amount } = req.body;
    try {
      const result = await bot.telegram.createInvoiceLink(
        `⭐ ${amount} Stars для игры`,
        'Пополнение баланса в Chip Poker',
        `stars_${Date.now()}`,
        '',
        'XTR',
        [{ label: `${amount} Stars`, amount }]
      );
      res.json({ invoiceLink: result });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  });

  bot.on('pre_checkout_query', (ctx) => ctx.answerPreCheckoutQuery(true));
  bot.on('successful_payment', (ctx) => {
    const payment = ctx.message.successful_payment;
    const userId = ctx.from.id;
    const stars = payment.total_amount;
    console.log(`✅ Пользователь ${userId} оплатил ${stars} Stars`);
    ctx.reply(`✅ Получено ${stars} Stars! Фишки зачислены.`);
  });

  bot.launch().then(() => console.log('🤖 Telegram бот запущен'));
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

// ========== ПОКЕРНАЯ ЛОГИКА ==========

function rankToNumber(rank) {
  const map = { '2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9, '10':10, 'J':11, 'Q':12, 'K':13, 'A':14 };
  return map[rank];
}

function getCombinations(arr, k) {
  if (k === 0) return [[]];
  if (arr.length === k) return [arr];
  const [first, ...rest] = arr;
  return [
    ...getCombinations(rest, k - 1).map(c => [first, ...c]),
    ...getCombinations(rest, k)
  ];
}

function compareTiebreak(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

function evaluate5(cards) {
  const ranks = cards.map(c => rankToNumber(c.rank)).sort((a,b) => b - a);
  const suits = cards.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);

  const counts = {};
  ranks.forEach(r => counts[r] = (counts[r] || 0) + 1);
  const groups = Object.entries(counts).map(([r,c]) => ({ r: +r, c })).sort((a,b) => b.c - a.c || b.r - a.r);
  const groupCounts = groups.map(g => g.c);
  const v = groups.map(g => g.r);

  let isStraight = false;
  let straightHigh = ranks[0];
  const unique = [...new Set(ranks)];
  if (unique.length >= 5) {
    for (let i = 0; i <= unique.length - 5; i++) {
      if (unique[i] - unique[i+4] === 4) {
        isStraight = true;
        straightHigh = unique[i];
        break;
      }
    }
    if (!isStraight && unique.includes(14) && unique.includes(2) && unique.includes(3) && unique.includes(4) && unique.includes(5)) {
      isStraight = true;
      straightHigh = 5;
    }
  }

  if (isStraight && isFlush) return { rank: 9, value: [straightHigh], name: 'Стрит-флеш' };
  if (groupCounts[0] === 4) return { rank: 8, value: v, name: 'Каре' };
  if (groupCounts[0] === 3 && groupCounts[1] === 2) return { rank: 7, value: v, name: 'Фулл-хаус' };
  if (isFlush) return { rank: 6, value: ranks, name: 'Флеш' };
  if (isStraight) return { rank: 5, value: [straightHigh], name: 'Стрит' };
  if (groupCounts[0] === 3) return { rank: 4, value: v, name: 'Тройка' };
  if (groupCounts[0] === 2 && groupCounts[1] === 2) return { rank: 3, value: v, name: 'Две пары' };
  if (groupCounts[0] === 2) return { rank: 2, value: v, name: 'Пара' };
  return { rank: 1, value: ranks, name: 'Старшая карта' };
}

function evaluateHand(cards) {
  const combos = getCombinations(cards, 5);
  let best = null;
  for (const combo of combos) {
    const result = evaluate5(combo);
    if (!best || result.rank > best.rank || (result.rank === best.rank && compareTiebreak(result.value, best.value) > 0)) {
      best = result;
    }
  }
  return best;
}

function createDeck() {
  const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  const suits = ['hearts', 'diamonds', 'clubs', 'spades'];
  const deck = [];
  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push({ rank, suit });
    }
  }
  return deck;
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// ========== ИГРОВОЕ СОСТОЯНИЕ ==========

let gameState = {
  tableId: 1,
  players: [],
  communityCards: [],
  pot: 0,
  currentBet: 0,
  activePlayer: 0,
  status: 'waiting',
  winner: null,
  deck: []
};

function startNewHand() {
  const deck = shuffle(createDeck());
  gameState.deck = [...deck];

  gameState.communityCards = [];
  gameState.pot = 0;
  gameState.currentBet = 0;
  gameState.status = 'playing';
  gameState.winner = null;

  let cardIndex = 0;

  for (let i = 0; i < gameState.players.length; i++) {
    if (gameState.players[i].isActive !== false) {
      gameState.players[i].cards = [deck[cardIndex++], deck[cardIndex++]];
      gameState.players[i].bet = 0;
      gameState.players[i].hasActed = false;
    }
  }

  const activePlayers = gameState.players.filter(p => p.isActive !== false);
  if (activePlayers.length >= 2) {
    const sb = activePlayers[0];
    const bb = activePlayers[1];
    const sbAmount = Math.min(5, sb.stack);
    const bbAmount = Math.min(10, bb.stack);
    if (sbAmount > 0) { sb.stack -= sbAmount; sb.bet = sbAmount; gameState.pot += sbAmount; }
    if (bbAmount > 0) { bb.stack -= bbAmount; bb.bet = bbAmount; gameState.pot += bbAmount; }
    gameState.currentBet = bbAmount;
  }

  gameState.activePlayer = 2 % gameState.players.length;
  while (gameState.players[gameState.activePlayer]?.isActive === false) {
    gameState.activePlayer = (gameState.activePlayer + 1) % gameState.players.length;
  }

  gameState.communityCards = [deck[cardIndex++], deck[cardIndex++], deck[cardIndex++]];
}

function nextPlayer() {
  let next = (gameState.activePlayer + 1) % gameState.players.length;
  let count = 0;
  while (count < gameState.players.length && (gameState.players[next].isActive === false || gameState.players[next].hasActed === true)) {
    next = (next + 1) % gameState.players.length;
    count++;
  }

  if (count >= gameState.players.length || next === gameState.activePlayer) {
    endHand();
  } else {
    gameState.activePlayer = next;
  }
}

function endHand() {
  const activePlayers = gameState.players.filter(p => p.isActive !== false && p.stack > 0);

  if (activePlayers.length === 1) {
    gameState.winner = activePlayers[0];
    gameState.winner.stack += gameState.pot;
    gameState.status = 'finished';
  } else if (activePlayers.length > 1) {
    const evaluations = activePlayers.map(p => ({
      player: p,
      hand: evaluateHand([...p.cards, ...gameState.communityCards])
    }));
    let best = evaluations[0];
    for (const e of evaluations) {
      if (e.hand.rank > best.hand.rank) best = e;
      else if (e.hand.rank === best.hand.rank) {
        for (let i = 0; i < Math.min(e.hand.value.length, best.hand.value.length); i++) {
          if (e.hand.value[i] > best.hand.value[i]) best = e;
        }
      }
    }
    gameState.winner = best.player;
    gameState.winner.stack += gameState.pot;
    gameState.status = 'finished';
  }

  io.emit('gameState', gameState);
}

// ========== SOCKET.IO ==========

io.on('connection', (socket) => {
  console.log('🎮 Игрок подключился:', socket.id);

  socket.emit('gameState', gameState);

  socket.on('joinGame', (data) => {
    const existing = gameState.players.find(p => p.id === socket.id);
    if (!existing && gameState.players.length < 6) {
      gameState.players.push({
        id: socket.id,
        name: data.name || `Игрок ${gameState.players.length + 1}`,
        stack: 1000,
        cards: [],
        bet: 0,
        isActive: true,
        hasActed: false
      });
      io.emit('gameState', gameState);
      console.log(`✅ ${data.name} присоединился`);
    }
  });

  socket.on('startGame', () => {
    const activePlayers = gameState.players.filter(p => p.isActive !== false);
    if (activePlayers.length >= 2 && gameState.status === 'waiting') {
      startNewHand();
      io.emit('gameState', gameState);
    }
  });

  socket.on('action', (data) => {
    const player = gameState.players.find(p => p.id === socket.id);
    if (!player) return;

    const currentPlayer = gameState.players[gameState.activePlayer];
    if (currentPlayer?.id !== socket.id) return;

    switch (data.action) {
      case 'fold':
        player.isActive = false;
        player.hasActed = true;
        nextPlayer();
        break;
      case 'call':
        const callAmount = gameState.currentBet - (player.bet || 0);
        if (player.stack >= callAmount) {
          player.stack -= callAmount;
          player.bet += callAmount;
          gameState.pot += callAmount;
          player.hasActed = true;
          nextPlayer();
        }
        break;
      case 'raise':
        const raiseAmount = data.amount;
        if (player.stack >= raiseAmount) {
          player.stack -= raiseAmount;
          player.bet += raiseAmount;
          gameState.currentBet = player.bet;
          gameState.pot += raiseAmount;
          player.hasActed = true;
          gameState.players.forEach(p => {
            if (p.id !== player.id && p.isActive !== false) p.hasActed = false;
          });
          nextPlayer();
        }
        break;
      case 'allin':
        const allinAmount = player.stack;
        player.bet += allinAmount;
        gameState.pot += allinAmount;
        player.stack = 0;
        if (player.bet > gameState.currentBet) {
          gameState.currentBet = player.bet;
          gameState.players.forEach(p => {
            if (p.id !== player.id && p.isActive !== false) p.hasActed = false;
          });
        }
        player.hasActed = true;
        nextPlayer();
        break;
    }

    io.emit('gameState', gameState);
  });

  socket.on('disconnect', () => {
    console.log('👋 Игрок отключился:', socket.id);
    gameState.players = gameState.players.filter(p => p.id !== socket.id);
    io.emit('gameState', gameState);
  });
});

// ========== ЗАПУСК СЕРВЕРА ==========
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🃏 Покер запущен на порту ${PORT}`);
  console.log(`🌐 URL: ${WEBAPP_URL}`);
  console.log(`🤖 Бот: @CHIP_POKER_bot`);
});
