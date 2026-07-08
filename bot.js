// PDF Toolbox Bot — bot Telegram utilitaire PDF avec monetisation Telegram Stars
// Fonctions gratuites limitees/jour, premium = illimite via paiement Stars natif.
// Necessite Node >= 18 (fetch global).

const { Telegraf } = require('telegraf');
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const pdfParse = require('pdf-parse');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('Erreur: variable d\'environnement BOT_TOKEN manquante (recupere-la via @BotFather).');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

const DB_FILE = path.join(__dirname, 'users.json');
const FREE_DAILY_QUOTA = 3;
const PREMIUM_PRICE_WEEK = 50; // Stars
const PREMIUM_PRICE_MONTH = 150; // Stars

function loadDB() {
  if (!fs.existsSync(DB_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function getUser(db, id) {
  if (!db[id]) db[id] = { premiumUntil: 0, usage: 0, lastReset: todayStr() };
  const u = db[id];
  if (u.lastReset !== todayStr()) {
    u.usage = 0;
    u.lastReset = todayStr();
  }
  return u;
}
function isPremium(u) {
  return u.premiumUntil > Date.now();
}
function canUse(u) {
  return isPremium(u) || u.usage < FREE_DAILY_QUOTA;
}

// Sessions en memoire pour les actions multi-etapes (fusion, action en attente)
const sessions = new Map(); // chatId -> { mode, files/file }

bot.start((ctx) => {
  ctx.reply(
    "Bienvenue sur PDF Genie !\n\n" +
      "Envoie-moi un PDF et choisis une action, ou utilise les commandes :\n" +
      "/fusionner - Fusionner plusieurs PDF\n" +
      "/premium - Debloquer l'usage illimite (paiement Telegram Stars)\n" +
      "/quota - Voir ton quota restant\n\n" +
      `Gratuit : ${FREE_DAILY_QUOTA} operations/jour. Premium : illimite.`
  );
});

bot.command('quota', (ctx) => {
  const db = loadDB();
  const u = getUser(db, ctx.from.id);
  saveDB(db);
  if (isPremium(u)) {
    ctx.reply(`Premium actif jusqu'au ${new Date(u.premiumUntil).toLocaleDateString('fr-FR')}. Usage illimite.`);
  } else {
    ctx.reply(`Utilisations aujourd'hui : ${u.usage}/${FREE_DAILY_QUOTA}`);
  }
});

bot.command('premium', (ctx) => {
  ctx.reply("Choisis ton abonnement (paiement en Telegram Stars, aucune carte requise) :", {
    reply_markup: {
      inline_keyboard: [
        [{ text: `1 semaine - ${PREMIUM_PRICE_WEEK} Stars`, callback_data: 'buy_week' }],
        [{ text: `1 mois - ${PREMIUM_PRICE_MONTH} Stars`, callback_data: 'buy_month' }],
      ],
    },
  });
});

bot.action(['buy_week', 'buy_month'], async (ctx) => {
  const isWeek = ctx.match === 'buy_week';
  const amount = isWeek ? PREMIUM_PRICE_WEEK : PREMIUM_PRICE_MONTH;
  const title = isWeek ? 'Premium - 1 semaine' : 'Premium - 1 mois';
  await ctx.answerCbQuery();
  await ctx.replyWithInvoice({
    title,
    description: 'Acces illimite a toutes les fonctions de PDF Toolbox Bot.',
    payload: isWeek ? 'premium_week' : 'premium_month',
    provider_token: '', // vide = paiement natif en Telegram Stars
    currency: 'XTR',
    prices: [{ label: title, amount }],
  });
});

bot.on('pre_checkout_query', (ctx) => ctx.answerPreCheckoutQuery(true));

bot.on('successful_payment', (ctx) => {
  const db = loadDB();
  const u = getUser(db, ctx.from.id);
  const payload = ctx.message.successful_payment.invoice_payload;
  const days = payload === 'premium_week' ? 7 : 30;
  const base = Math.max(u.premiumUntil, Date.now());
  u.premiumUntil = base + days * 24 * 60 * 60 * 1000;
  saveDB(db);
  ctx.reply(`Merci ! Premium actif jusqu'au ${new Date(u.premiumUntil).toLocaleDateString('fr-FR')}.`);
});

bot.command('fusionner', (ctx) => {
  sessions.set(ctx.chat.id, { mode: 'merge', files: [] });
  ctx.reply("Envoie-moi les PDF a fusionner un par un, puis tape /terminer.");
});

bot.command('terminer', async (ctx) => {
  const session = sessions.get(ctx.chat.id);
  if (!session || session.mode !== 'merge' || session.files.length < 2) {
    return ctx.reply("Envoie au moins 2 PDF apres /fusionner avant de taper /terminer.");
  }
  const db = loadDB();
  const u = getUser(db, ctx.from.id);
  if (!canUse(u)) {
    sessions.delete(ctx.chat.id);
    return ctx.reply(`Quota gratuit atteint (${FREE_DAILY_QUOTA}/jour). Tape /premium pour debloquer l'illimite.`);
  }
  try {
    const merged = await PDFDocument.create();
    for (const buf of session.files) {
      const src = await PDFDocument.load(buf);
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach((p) => merged.addPage(p));
    }
    const bytes = await merged.save();
    if (!isPremium(u)) u.usage += 1;
    saveDB(db);
    await ctx.replyWithDocument({ source: Buffer.from(bytes), filename: 'fusionne.pdf' });
  } catch (e) {
    console.error(e);
    ctx.reply('Erreur lors de la fusion. Verifie que les fichiers sont bien des PDF valides.');
  } finally {
    sessions.delete(ctx.chat.id);
  }
});

bot.on('document', async (ctx) => {
  const doc = ctx.message.document;
  if (!doc.mime_type || !doc.mime_type.includes('pdf')) {
    return ctx.reply('Envoie-moi un fichier PDF.');
  }
  const link = await ctx.telegram.getFileLink(doc.file_id);
  const res = await fetch(link.href);
  const buf = Buffer.from(await res.arrayBuffer());

  const session = sessions.get(ctx.chat.id);
  if (session && session.mode === 'merge') {
    session.files.push(buf);
    return ctx.reply(`PDF ajoute (${session.files.length} au total). Envoie-en d'autres ou tape /terminer.`);
  }

  sessions.set(ctx.chat.id, { mode: 'single', file: buf });
  await ctx.reply('Que veux-tu faire avec ce PDF ?', {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Extraire le texte', callback_data: 'act_extract' }],
        [{ text: 'Diviser en pages seules', callback_data: 'act_split' }],
      ],
    },
  });
});

bot.action('act_extract', async (ctx) => {
  await ctx.answerCbQuery();
  const session = sessions.get(ctx.chat.id);
  if (!session || !session.file) return ctx.reply("Renvoie-moi un PDF d'abord.");
  const db = loadDB();
  const u = getUser(db, ctx.from.id);
  if (!canUse(u)) return ctx.reply("Quota gratuit atteint. Tape /premium pour debloquer l'illimite.");
  try {
    const data = await pdfParse(session.file);
    if (!isPremium(u)) u.usage += 1;
    saveDB(db);
    const text = data.text.trim() || '(aucun texte detecte - le PDF est peut-etre scanne en image)';
    const chunks = text.match(/[\s\S]{1,3800}/g) || [text];
    for (const chunk of chunks.slice(0, 5)) await ctx.reply(chunk);
  } catch (e) {
    console.error(e);
    ctx.reply("Erreur lors de l'extraction du texte.");
  }
});

bot.action('act_split', async (ctx) => {
  await ctx.answerCbQuery();
  const session = sessions.get(ctx.chat.id);
  if (!session || !session.file) return ctx.reply("Renvoie-moi un PDF d'abord.");
  const db = loadDB();
  const u = getUser(db, ctx.from.id);
  if (!canUse(u)) return ctx.reply("Quota gratuit atteint. Tape /premium pour debloquer l'illimite.");
  try {
    const src = await PDFDocument.load(session.file);
    const count = src.getPageCount();
    if (!isPremium(u)) u.usage += 1;
    saveDB(db);
    const max = isPremium(u) ? count : Math.min(count, 5);
    for (let i = 0; i < max; i++) {
      const single = await PDFDocument.create();
      const [page] = await single.copyPages(src, [i]);
      single.addPage(page);
      const bytes = await single.save();
      await ctx.replyWithDocument({ source: Buffer.from(bytes), filename: `page-${i + 1}.pdf` });
    }
    if (!isPremium(u) && count > 5) {
      await ctx.reply(`Limite aux 5 premieres pages en gratuit (${count} au total). Tape /premium pour tout recevoir.`);
    }
  } catch (e) {
    console.error(e);
    ctx.reply('Erreur lors de la division.');
  }
});

bot.launch();
console.log('Bot demarre.');

// Petit serveur HTTP requis par Render (et utile pour un ping de "keep-alive")
const http = require('http');
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('PDF Genie bot is running.');
  })
  .listen(PORT, () => console.log(`Serveur HTTP pret sur le port ${PORT}.`));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
