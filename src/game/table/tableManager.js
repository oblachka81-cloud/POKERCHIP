const { TABLE_CONFIG } = require('../../config/constants');

const tables = {};
const MIN_PLAYERS_TO_OPEN_NEW = 3;

function createTable(id, configId) {
  const config = TABLE_CONFIG[configId] || TABLE_CONFIG.test_bronze;
  return {
    id, configId, config,
    players:[], communityCards:[], deck:[], deckIdx:0,
    pot:0, currentBet:0, activePlayer:0,
    round:'waiting', status:'waiting', winner:null,
    autoStartTimer:null, nextHandTimer:null, countdown:0,
    handInProgress:false, dealerIndex:0
  };
}

function getTable(id, configId) {
  if (!tables[id]) tables[id] = createTable(id, configId||'test_bronze');
  return tables[id];
}

function getOrCreateTableForConfig(configId) {
  const existing = Object.values(tables).find(t =>
    t.configId === configId && t.players.length < 6 && t.players.length < MIN_PLAYERS_TO_OPEN_NEW
  );
  if (existing) return existing;
  const anyFree = Object.values(tables).find(t =>
    t.configId === configId && t.players.length < 6
  );
  if (anyFree) return anyFree;
  const newId = configId + '_' + Date.now();
  tables[newId] = createTable(newId, configId);
  console.log('🆕 Новый стол создан: ' + newId);
  return tables[newId];
}

function cleanupEmptyTables() {
  const byConfig = {};
  Object.values(tables).forEach(t => {
    if (!byConfig[t.configId]) byConfig[t.configId] = [];
    byConfig[t.configId].push(t);
  });
  Object.entries(byConfig).forEach(([configId, tList]) => {
    const empty = tList.filter(t => t.players.length === 0 && t.status === 'waiting');
    empty.slice(1).forEach(t => {
      console.log('🗑️ Удалён пустой стол: ' + t.id);
      delete tables[t.id];
    });
  });
}

setInterval(cleanupEmptyTables, 5 * 60 * 1000);

module.exports = { tables, createTable, getTable, getOrCreateTableForConfig, cleanupEmptyTables };
