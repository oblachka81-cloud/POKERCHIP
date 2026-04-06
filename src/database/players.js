const { pool } = require('./db');

async function getOrCreatePlayer(telegramId, name, photo) {
  try {
    const res = await pool.query(
      `INSERT INTO players (telegram_id, name, photo, balance, stars_balance)
       VALUES ($1, $2, $3, 1000, 0)
       ON CONFLICT (telegram_id) DO UPDATE
       SET name=EXCLUDED.name, photo=EXCLUDED.photo, updated_at=NOW()
       RETURNING *`,
      [telegramId, name, photo]
    );
    return res.rows[0];
  } catch(e) { console.error('getOrCreatePlayer error:', e.message); return null; }
}

async function saveBalance(telegramId, balance, starsBalance, isWinner, rakeAmount, tableId, tableType) {
  try {
    await pool.query(
      `UPDATE players SET
        balance=$2,
        stars_balance=$3,
        games_played=games_played+1,
        games_won=games_won+$4,
        total_rake=total_rake+$5,
        updated_at=NOW()
       WHERE telegram_id=$1`,
      [telegramId, balance, starsBalance, isWinner ? 1 : 0, rakeAmount || 0]
    );
    if (rakeAmount > 0) {
      await pool.query(
        `INSERT INTO house (table_id, table_type, rake_amount, pot_amount) VALUES ($1, $2, $3, 0)`,
        [tableId, tableType, rakeAmount]
      );
    }
  } catch(e) { console.error('saveBalance error:', e.message); }
}

module.exports = { getOrCreatePlayer, saveBalance };
Также нужно исправить мёртвый код в sitgoFlow.js -- убрать три строки:

let _io;
try { _io = require('../../../src/index').__io; } catch(e) {}
