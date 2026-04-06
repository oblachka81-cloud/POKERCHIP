const crypto = require('crypto');
const { pool }   = require('../database/db');
const { tables } = require('../game/table/tableManager');
const { sitgoLobbies } = require('../game/sitgo/sitgoManager');

// SEC1 — падаем при старте если пароль не задан
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error('❌ ADMIN_PASSWORD env variable is required');
  process.exit(1);
}

// SEC2 — сессии в памяти, токен = random hex
const adminSessions = new Set();

function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token && adminSessions.has(token)) next();
  else res.status(401).json({ error: 'Нет доступа' });
}

// SEC3 — whitelist для полей баланса
const BALANCE_FIELDS = { balance: 'balance', stars: 'stars_balance' };

function setupAdminRoutes(app) {
  app.post('/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
      const token = crypto.randomBytes(32).toString('hex');
      adminSessions.add(token);
      res.json({ ok: true, token });
    } else {
      res.status(401).json({ ok: false, error: 'Неверный пароль' });
    }
  });

  app.post('/admin/logout', adminAuth, (req, res) => {
    adminSessions.delete(req.headers['x-admin-token']);
    res.json({ ok: true });
  });

  app.get('/admin/stats', adminAuth, async (req, res) => {
    try {
      const players      = await pool.query('SELECT COUNT(*) as count FROM players');
      const topPlayers   = await pool.query('SELECT name,balance,stars_balance,games_played,games_won FROM players ORDER BY balance DESC LIMIT 10');
      const totalBalance = await pool.query('SELECT SUM(balance) as total, SUM(stars_balance) as stars_total FROM players');
      const totalRake    = await pool.query('SELECT SUM(rake_amount) as total, COUNT(*) as hands FROM house');
      const rakeToday    = await pool.query(`SELECT SUM(rake_amount) as today FROM house WHERE created_at>NOW()-INTERVAL '24 hours'`);
      const activeTables  = Object.values(tables).filter(t => t.status === 'playing').length;
      const onlinePlayers = Object.values(tables).reduce((acc, t) => acc + t.players.length, 0);
      const activeSitGos  = Object.values(sitgoLobbies).filter(l => l.status !== 'finished').length;
      res.json({
        totalPlayers:  parseInt(players.rows[0].count),
        topPlayers:    topPlayers.rows,
        totalChips:    parseInt(totalBalance.rows[0].total)       || 0,
        totalStars:    parseInt(totalBalance.rows[0].stars_total)  || 0,
        totalRake:     parseInt(totalRake.rows[0].total)           || 0,
        totalHands:    parseInt(totalRake.rows[0].hands)           || 0,
        rakeToday:     parseInt(rakeToday.rows[0].today)           || 0,
        activeTables, onlinePlayers, activeSitGos,
        tables: Object.values(tables).map(t => ({
          id: t.id, status: t.status, round: t.round, pot: t.pot,
          tableType: t.config?.type || 'test', tier: t.config?.tier || 'bronze',
          players: t.players.map(p => ({ name: p.name, stack: p.stack }))
        }))
      });
    } catch (e) { console.error('admin/stats error:', e); res.status(500).json({ error: e.message }); }
  });

  app.get('/admin/players', adminAuth, async (req, res) => {
    try {
      const search = req.query.search || '';
      const result = await pool.query(
        `SELECT telegram_id,name,balance,stars_balance,games_played,games_won,total_rake,created_at
         FROM players WHERE name ILIKE $1 OR telegram_id ILIKE $1
         ORDER BY balance DESC LIMIT 50`,
        [`%${search}%`]
      );
      res.json(result.rows);
    } catch (e) { console.error('admin/players error:', e); res.status(500).json({ error: e.message }); }
  });

  app.post('/admin/balance', adminAuth, async (req, res) => {
    const { telegramId, amount, type } = req.body;
    const parsedAmount = parseInt(amount);
    if (isNaN(parsedAmount) || parsedAmount < -100000 || parsedAmount > 1000000)
      return res.status(400).json({ error: 'Некорректная сумма' });
    // SEC3 — whitelist, не вставляем строку напрямую
    const field = BALANCE_FIELDS[type] || 'balance';
    try {
      await pool.query(
        `UPDATE players SET ${field}=GREATEST(0,${field}+$2), updated_at=NOW() WHERE telegram_id=$1`,
        [telegramId, parsedAmount]
      );
      const result = await pool.query('SELECT balance,stars_balance FROM players WHERE telegram_id=$1', [telegramId]);
      res.json({ ok: true, ...result.rows[0] });
    } catch (e) { console.error('admin/balance error:', e); res.status(500).json({ error: e.message }); }
  });

  app.post('/admin/balance/set', adminAuth, async (req, res) => {
    const { telegramId, amount, type } = req.body;
    const parsedAmount = parseInt(amount);
    if (isNaN(parsedAmount) || parsedAmount < 0 || parsedAmount > 10000000)
      return res.status(400).json({ error: 'Некорректная сумма' });
    const field = BALANCE_FIELDS[type] || 'balance';
    try {
      await pool.query(
        `UPDATE players SET ${field}=$2, updated_at=NOW() WHERE telegram_id=$1`,
        [telegramId, parsedAmount]
      );
      res.json({ ok: true, balance: parsedAmount });
    } catch (e) { console.error('admin/balance/set error:', e); res.status(500).json({ error: e.message }); }
  });

  app.post('/admin/table/close', adminAuth, (req, res) => {
    const { tableId } = req.body;
    if (tables[tableId]) {
      tables[tableId].status = 'waiting';
      tables[tableId].players = [];
      if (tables[tableId].autoStartTimer) clearTimeout(tables[tableId].autoStartTimer);
      if (tables[tableId].nextHandTimer)  clearTimeout(tables[tableId].nextHandTimer);
      res.json({ ok: true });
    } else {
      res.status(404).json({ error: 'Стол не найден' });
    }
  });

  app.get('/admin/rake', adminAuth, async (req, res) => {
    try {
      const byType = await pool.query(`SELECT table_type,SUM(rake_amount) as total,COUNT(*) as hands FROM house GROUP BY table_type ORDER BY total DESC`);
      const byDay  = await pool.query(`SELECT DATE(created_at) as day,SUM(rake_amount) as total,COUNT(*) as hands FROM house GROUP BY DATE(created_at) ORDER BY day DESC LIMIT 7`);
      res.json({ byType: byType.rows, byDay: byDay.rows });
    } catch (e) { console.error('admin/rake error:', e); res.status(500).json({ error: e.message }); }
  });

  app.get('/admin/analytics/finance', adminAuth, async (req, res) => {
    try {
      const rakeByDay  = await pool.query(`SELECT DATE(created_at) as day,SUM(rake_amount) as rake,COUNT(*) as hands FROM house WHERE created_at>NOW()-INTERVAL '30 days' GROUP BY DATE(created_at) ORDER BY day ASC`);
      const starsFlow  = await pool.query(`SELECT DATE(created_at) as day,SUM(rake_amount) as rake FROM house WHERE table_type LIKE 'stars%' AND created_at>NOW()-INTERVAL '30 days' GROUP BY DATE(created_at) ORDER BY day ASC`);
      const periods    = await pool.query(`SELECT SUM(CASE WHEN created_at>NOW()-INTERVAL '1 day' THEN rake_amount ELSE 0 END) as today, SUM(CASE WHEN created_at>NOW()-INTERVAL '7 days' THEN rake_amount ELSE 0 END) as week, SUM(CASE WHEN created_at>NOW()-INTERVAL '30 days' THEN rake_amount ELSE 0 END) as month, SUM(rake_amount) as all_time FROM house`);
      res.json({ rakeByDay: rakeByDay.rows, starsFlow: starsFlow.rows, periods: periods.rows[0] });
    } catch (e) { console.error('admin/analytics/finance error:', e); res.status(500).json({ error: e.message }); }
  });

  app.get('/admin/analytics/players', adminAuth, async (req, res) => {
    try {
      const newByDay    = await pool.query(`SELECT DATE(created_at) as day,COUNT(*) as count FROM players WHERE created_at>NOW()-INTERVAL '30 days' GROUP BY DATE(created_at) ORDER BY day ASC`);
      const activeToday = await pool.query(`SELECT COUNT(*) as count FROM players WHERE updated_at>NOW()-INTERVAL '1 day'`);
      const activeWeek  = await pool.query(`SELECT COUNT(*) as count FROM players WHERE updated_at>NOW()-INTERVAL '7 days'`);
      const activeMonth = await pool.query(`SELECT COUNT(*) as count FROM players WHERE updated_at>NOW()-INTERVAL '30 days'`);
      const topByStars  = await pool.query(`SELECT name,telegram_id,total_rake,games_played,games_won,stars_balance FROM players ORDER BY total_rake DESC LIMIT 10`);
      const inactive    = await pool.query(`SELECT name,telegram_id,balance,stars_balance,EXTRACT(EPOCH FROM (NOW()-updated_at)) as last_seen FROM players WHERE updated_at<NOW()-INTERVAL '7 days' ORDER BY updated_at ASC LIMIT 20`);
      const retention   = await pool.query(`SELECT COUNT(*) as total,SUM(CASE WHEN games_played>1 THEN 1 ELSE 0 END) as returned,SUM(CASE WHEN games_played>=10 THEN 1 ELSE 0 END) as loyal FROM players`);
      res.json({
        newByDay: newByDay.rows,
        active: {
          today: parseInt(activeToday.rows[0].count),
          week:  parseInt(activeWeek.rows[0].count),
          month: parseInt(activeMonth.rows[0].count)
        },
        topByStars: topByStars.rows,
        inactive:   inactive.rows,
        retention:  retention.rows[0]
      });
    } catch (e) { console.error('admin/analytics/players error:', e); res.status(500).json({ error: e.message }); }
  });

  app.get('/admin/analytics/tables', adminAuth, async (req, res) => {
    try {
      const tablePopularity = await pool.query(`SELECT table_type,COUNT(*) as hands,SUM(rake_amount) as total_rake,MAX(created_at) as last_hand FROM house GROUP BY table_type ORDER BY hands DESC`);
      const peakHours       = await pool.query(`SELECT EXTRACT(HOUR FROM created_at) as hour,COUNT(*) as hands FROM house GROUP BY EXTRACT(HOUR FROM created_at) ORDER BY hour ASC`);
      const byDayOfWeek     = await pool.query(`SELECT EXTRACT(DOW FROM created_at) as dow,COUNT(*) as hands FROM house GROUP BY EXTRACT(DOW FROM created_at) ORDER BY dow ASC`);
      const handsPerHour    = await pool.query(`SELECT COUNT(*) as total_hands,EXTRACT(EPOCH FROM (MAX(created_at)-MIN(created_at)))/3600 as hours FROM house WHERE created_at>NOW()-INTERVAL '7 days'`);
      const hph = handsPerHour.rows[0];
      const avgHandsPerHour = hph.hours > 0 ? (hph.total_hands / hph.hours).toFixed(1) : 0;
      res.json({ tablePopularity: tablePopularity.rows, peakHours: peakHours.rows, byDayOfWeek: byDayOfWeek.rows, avgHandsPerHour });
    } catch (e) { console.error('admin/analytics/tables error:', e); res.status(500).json({ error: e.message }); }
  });
}
