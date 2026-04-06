const { Telegraf } = require('telegraf');
const { pool }     = require('../database/db');

function setupBot(app) {
  const BOT_TOKEN  = process.env.BOT_TOKEN;
  const WEBAPP_URL = process.env.WEBAPP_URL || 'https://chippoker.bothost.tech';

  if (!BOT_TOKEN) return null;

  const bot = new Telegraf(BOT_TOKEN);

  bot.start((ctx) => {
    ctx.reply('🃏 Добро пожаловать в Chip Poker!', {
      reply_markup: { inline_keyboard: [[{ text:'🎮 Играть', web_app:{ url:`${WEBAPP_URL}/profile` } }]] }
    });
  });

  app.post('/create-invoice', async (req, res) => {
    const { amount } = req.body;
    try {
      const result = await bot.telegram.createInvoiceLink(
        `🌟 ${amount} Stars`, 'Пополнение Stars баланса в Chip Poker',
        `stars_${Date.now()}`, '', 'XTR', [{ label:`${amount} Stars`, amount }]
      );
      res.json({ invoiceLink: result });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  bot.on('pre_checkout_query', (ctx) => ctx.answerPreCheckoutQuery(true));

  bot.on('successful_payment', async (ctx) => {
    const stars = ctx.message.successful_payment.total_amount;
    const telegramId = String(ctx.from.id);
    try {
      await pool.query(`UPDATE players SET stars_balance=stars_balance+$2, updated_at=NOW() WHERE telegram_id=$1`, [telegramId, stars]);
      ctx.reply(`✅ Получено ${stars} Stars!`);
    } catch(e) { ctx.reply(`✅ Получено ${stars} Stars!`); }
  });

  app.post('/webhook', (req, res) => {
    res.sendStatus(200);
    bot.handleUpdate(req.body).catch(err => console.error('Webhook error:', err));
  });

  bot.telegram.setWebhook(`${WEBAPP_URL}/webhook`)
    .then(() => console.log(`🤖 Webhook: ${WEBAPP_URL}/webhook`))
    .catch(err => console.error('❌ Webhook error:', err.message));

  return bot;
}

module.exports = { setupBot };
