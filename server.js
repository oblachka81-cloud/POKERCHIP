const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(__dirname));

const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*" },
  transports: ['websocket', 'polling']
});

// ========== ПОКЕРНАЯ ЛОГИКА ==========

function rankToNumber(rank) {
  const map = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };
  return map[rank];
}

function evaluateHand(cards) {
  const ranks = cards.map(c => rankToNumber(c.rank)).sort((a,b) => b - a);
  const suits = cards.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);
  
  let isStraight = false;
  for (let i = 0; i <= ranks.length - 5; i++) {
    if (ranks[i] - ranks[i+4] === 4) {
      isStraight = true;
      break;
    }
  }
  if (!isStraight && ranks[0] === 14 && ranks[1] === 5 && ranks[2] === 4 && ranks[3] === 3 && ranks[4] === 2) {
    isStraight = true;
  }
  
  if (isStraight && isFlush) return { rank: 9, value: [ranks[0]], name: 'Стрит-флеш' };
  if (isFlush) return { rank: 6, value: ranks.slice(0,5), name: 'Флеш' };
  if (isStraight) return { rank: 5, value: [ranks[0]], name: 'Стрит' };
  
  return { rank: 1, value: ranks.slice(0,5), name: 'Старшая карта' };
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
  const activePlayers = gameState.players.filter(p => p.isActive !== false);
  
  for (let i = 0; i < gameState.players.length; i++) {
    if (gameState.players[i].isActive !== false) {
      gameState.players[i].cards = [deck[cardIndex++], deck[cardIndex++]];
      gameState.players[i].bet = 0;
      gameState.players[i].hasActed = false;
    }
  }
  
  if (activePlayers.length >= 2) {
    const sb = gameState.players.find(p => p.isActive !== false);
    const bb = gameState.players.filter(p => p.isActive !== false)[1];
    if (sb && bb) {
      const sbAmount = Math.min(5, sb.stack);
      const bbAmount = Math.min(10, bb.stack);
      if (sbAmount > 0) { sb.stack -= sbAmount; sb.bet = sbAmount; gameState.pot += sbAmount; }
      if (bbAmount > 0) { bb.stack -= bbAmount; bb.bet = bbAmount; gameState.pot += bbAmount; }
      gameState.currentBet = bbAmount;
    }
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
          nextPlayer();
        }
        break;
      case 'allin':
        const allinAmount = player.stack;
        player.bet += allinAmount;
        gameState.pot += allinAmount;
        player.stack = 0;
        if (player.bet > gameState.currentBet) gameState.currentBet = player.bet;
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

// ========== ЗАПУСК ==========
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
  🃏 ПОКЕР-ПРИЛОЖЕНИЕ ЗАПУЩЕНО! 🃏
  
  📱 Открой в браузере: http://localhost:${PORT}
  🔗 Для Telegram Mini App: https://t.me/PokerChipBot
  
  💰 Рейк: 5% (будет добавлен позже)
  👥 Чтобы сыграть:
  1. Открой несколько вкладок браузера
  2. Нажми "Присоединиться" в каждой
  3. Нажми "Начать игру"
  `);
});
