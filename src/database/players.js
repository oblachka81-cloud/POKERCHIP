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

async function saveBalance(telegramId, balance) {
  try {
    await pool.query(
      `UPDATE players SET balance=$2, updated_at=NOW() WHERE telegram_id=$1`,
      [telegramId, balance]
    );
  } catch(e) { console.error('saveBalance error:', e.message); }
}

module.exports = { getOrCreatePlayer, saveBalance };
