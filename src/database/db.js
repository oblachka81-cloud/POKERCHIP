const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

async function initDB() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS players (
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
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS house (
      id SERIAL PRIMARY KEY,
      table_id TEXT,
      table_type TEXT,
      rake_amount INTEGER,
      pot_amount INTEGER,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS sitgo_results (
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
    )`);
    await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS stars_balance INTEGER DEFAULT 0`);
    await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS total_rake INTEGER DEFAULT 0`);
    console.log('✅ БД инициализирована');
  } catch(e) { console.error('❌ Ошибка БД:', e.message); }
}

module.exports = { pool, initDB };
