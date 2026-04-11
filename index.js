const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const cron = require('node-cron');
const { loadCookie, saveCookie, getCsrfToken, buildCookieHeader } = require('./cookie');
const {
  getLatestWhatsappSID,
  getTestNumbers,
  addNumber,
  returnAllNumbers,
  getSMSStats
} = require('./ivas');
const {
  startMonitoring,
  stopMonitoring,
  getMonitorStatus,
  saveNumbers,
  loadNumbers,
  clearNumbers
} = require('./monitor');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const config = require('./config.json');
// Mengaktifkan bot
const bot = new TelegramBot(config.telegram_token, { polling: true });

// ─── STATE ────────────────────────────────────────────────────────────────────
let isRunning = false;

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  console.log(`[${ts}] ${msg}`);
}

function escMd(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

async function sendMsg(chatId, text, options = {}) {
  try {
    bot.sendChatAction(chatId, 'typing'); // Indikator bot sedang mengetik
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...options });
  } catch (e) {
    try {
      // Fallback jika Markdown gagal diparse
      await bot.sendMessage(chatId, text.replace(/[*_`\\[\]]/g, ''), options);
    } catch (e2) {
      console.error('Send error:', e2.message);
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractIdFromAction(actionHtml) {
  if (!actionHtml) return null;
  const match =
    actionHtml.match(/AddNumbers\((\d+)\)/) ||
    actionHtml.match(/data-id="(\d+)"/) ||
    actionHtml.match(/\((\d+)\)/);
  return match ? match[1] : null;
}

// ─── AMBIL MY NUMBERS ────────────────────────────────────────────────────────
async function getAssignedNumbers(cookie, rangeName) {
  try {
    const ts = Date.now();
    const params = new URLSearchParams({
      draw: '1',
      'columns[1][data]': 'Number',
      'columns[1][name]': 'Number',
      'columns[2][data]': 'range',
      'columns[2][name]': 'range',
      'columns[7][data]': 'action',
      'order[0][column]': '1',
      'order[0][dir]': 'desc',
      'start': '0',
      'length': '100',
      'search[value]': rangeName || '',
      '_': String(ts)
    });

    const res = await axios.get(
      `https://www.ivasms.com/portal/numbers?${params.toString()}`,
      {
        headers: {
          'Cookie': buildCookieHeader(cookie),
          'X-CSRF-TOKEN': getCsrfToken(cookie),
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'Referer': 'https://www.ivasms.com/portal/numbers',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 15000
      }
    );

    const rows = res.data?.data || [];
    return { expired: false, data: rows };
  } catch (err) {
    if (err.response?.status === 401 || err.response?.status === 419) return { expired: true };
    return { expired: false, data: [], error: err.message };
  }
}

// ─── FORMAT STATS ─────────────────────────────────────────────────────────────
async function formatAndSendStats(chatId, stats, date) {
  if (!stats || stats.length === 0) {
    return sendMsg(chatId, '📊 Tidak ada data SMS Statistics untuk hari ini\\.');
  }
  if (stats[0]?.parse_failed) {
    return sendMsg(chatId, '⚠️ SMS Statistics tersedia tapi gagal di\\-parse\\. Cek manual di portal\\.');
  }

  let totalSMS = 0, totalPaid = 0, totalUnpaid = 0, totalRevenue = 0;
  let msg = `📊 *SMS Statistics — ${escMd(date)}*\n${'─'.repeat(28)}\n\n`;

  for (const r of stats) {
    totalSMS     += parseInt(r.count || 0);
    totalPaid    += parseInt(r.paid || 0);
    totalUnpaid  += parseInt(r.unpaid || 0);
    totalRevenue += parseFloat(r.revenue || 0);

    msg += `📁 *${escMd(r.range_name || '-')}*\n`;
    msg += `  SMS: ${r.count||0} | ✅ ${r.paid||0} | ❌ ${r.unpaid||0}\n`;
    msg += `  💰 \\$${parseFloat(r.revenue||0).toFixed(4)}\n\n`;
  }

  msg += `${'─'.repeat(28)}\n📈 *TOTAL*\n`;
  msg += `• SMS: ${totalSMS} | ✅ ${totalPaid} | ❌ ${totalUnpaid}\n`;
  msg += `• 💰 \\$${totalRevenue.toFixed(4)}`;

  if (msg.length > 4000) {
    const chunks = msg.match(/.{1,4000}/gs) || [];
    for (const chunk of chunks) { await sendMsg(chatId, chunk); await sleep(300); }
  } else {
    await sendMsg(chatId, msg);
  }
}

// ─── KEYBOARD MENU (CANGGIH) ──────────────────────────────────────────────────
const mainKeyboard = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '🚀 Jalankan Flow', callback_data: 'run_flow' },
        { text: '📊 Cek Statistik', callback_data: 'check_stats' }
      ],
      [
        { text: '📱 Cek SID WhatsApp', callback_data: 'check_sid' },
        { text: '📡 Status Monitor', callback_data: 'check_monitor' }
      ],
      [
        { text: '⏹ Stop Monitor', callback_data: 'stop_monitor' },
        { text: '♻️ Return Numbers', callback_data: 'return_nums' }
      ],
      [
        { text: '📖 Bantuan / Help', callback_data: 'help_menu' }
      ]
    ]
  }
};

// ─── FLOW UTAMA ───────────────────────────────────────────────────────────────
async function runFullFlow(chatId) {
  if (isRunning) {
    return sendMsg(chatId, '⚠️ Flow sedang berjalan, tunggu selesai dulu\\.');
  }
  isRunning = true;
  const today = new Date().toISOString().split('T')[0];

  try {
    await sendMsg(chatId, '🚀 *Memulai flow iVAS\\.\\.\\.*');

    const cookie = loadCookie();
    if (!cookie) {
      isRunning = false;
      return sendMsg(chatId, '❌ Cookie tidak ditemukan\\. Update dengan /setcookie');
    }

    // Stop monitor & clear
    if (getMonitorStatus().isRunning) {
      stopMonitoring();
      await sendMsg(chatId, '⏹ Monitor lama dihentikan\\.');
    }
    clearNumbers();

    // [1/5] Return all numbers
    await sendMsg(chatId, '♻️ *\\[1/5\\]* Return semua number\\.\\.\\.');
    const ret = await returnAllNumbers(cookie);
    if (ret.expired) { isRunning = false; return sendMsg(chatId, '🔴 Cookie expired\\! /setcookie'); }
    await sendMsg(chatId, `✅ ${escMd(ret.message || 'Berhasil')}`);
    await sleep(3000);

    // [2/5] Ambil SID WhatsApp
    await sendMsg(chatId, '🔍 *\\[2/5\\]* Mencari SID WhatsApp terbaru\\.\\.\\.');
    const sids = await getLatestWhatsappSID(cookie);
    if (sids.expired) { isRunning = false; return sendMsg(chatId, '🔴 Cookie expired\\! /setcookie'); }
    if (!sids.data?.length) { isRunning = false; return sendMsg(chatId, '⚠️ Tidak ada SID WhatsApp\\.'); }

    const sid = sids.data[0];
    await sendMsg(chatId,
      `✅ *SID Terbaru:*\n` +
      `• Range: \`${escMd(sid.range)}\`\n` +
      `• SID: \`${escMd(sid.originator)}\`\n` +
      `• No: \`${escMd(sid.test_number||'-')}\`\n` +
      `• Pesan: \`${escMd((sid.messagedata||'-').substring(0,50))}\`\n` +
      `• Waktu: \`${escMd(sid.senttime)}\``
    );

    // [3/5] Cari range di Test Numbers
    await sendMsg(chatId, `🔍 *\\[3/5\\]* Mencari range di Test Numbers\\.\\.\\. `);
    const testNums = await getTestNumbers(cookie, sid.range);
    if (testNums.expired) { isRunning = false; return sendMsg(chatId, '🔴 Cookie expired\\! /setcookie'); }
    if (!testNums.data?.length) { isRunning = false; return sendMsg(chatId, `⚠️ Range "${escMd(sid.range)}" tidak ditemukan\\.`); }

    const target = testNums.data[0];
    const rangeId = extractIdFromAction(target.action);
    if (!rangeId) { isRunning = false; return sendMsg(chatId, '⚠️ Gagal ekstrak ID dari action\\.'); }

    await sendMsg(chatId,
      `✅ *Range:* \`${escMd(target.range)}\`\n` +
      `• No: \`${escMd(target.test_number)}\` | Rate: \`${escMd(target.A2P||'-')}\`\n` +
      `• ID: \`${rangeId}\``
    );

    // [4/5] Add number
    await sendMsg(chatId, `➕ *\\[4/5\\]* Add number ID ${rangeId}\\.\\.\\. `);
    await sleep(2000);
    const addRes = await addNumber(cookie, rangeId);
    if (addRes.expired) { isRunning = false; return sendMsg(chatId, '🔴 Cookie expired\\! /setcookie'); }
    await sendMsg(chatId, `✅ ${escMd(addRes.message || 'Berhasil add number')}`);
    await sleep(5000);

    // [5/5] Ambil nomor yang di-assign → simpan ke numbers.txt
    await sendMsg(chatId, `📋 *\\[5/5\\]* Mengambil nomor yang di\\-assign\\.\\.\\. `);
    const assigned = await getAssignedNumbers(cookie, target.range);
    if (assigned.expired) { isRunning = false; return sendMsg(chatId, '🔴 Cookie expired\\! /setcookie'); }

    let numbersToSave = [];
    if (assigned.data?.length > 0) {
      numbersToSave = assigned.data.map(n => ({
        number: n.Number || n.number || '',
        range: n.range || target.range
      })).filter(n => n.number);
    }

    // Fallback ke test_number kalau kosong
    if (numbersToSave.length === 0) {
      numbersToSave = [{ number: target.test_number, range: target.range }];
    }

    saveNumbers(numbersToSave);

    let numMsg = `✅ *${numbersToSave.length} Nomor Disimpan ke numbers\\.txt:*\n\n`;
    for (const n of numbersToSave.slice(0, 10)) {
      numMsg += `• \`${escMd(n.number)}\` — ${escMd(n.range)}\n`;
    }
    if (numbersToSave.length > 10) numMsg += `_\\.\\.\\. dan ${numbersToSave.length - 10} lainnya_`;
    await sendMsg(chatId, numMsg);

    // SMS Statistics
    await sendMsg(chatId, `📊 Mengambil SMS Statistics \\(${today}\\)\\.\\.\\. `);
    const stats = await getSMSStats(cookie, today, today);
    if (!stats.expired && stats.data) await formatAndSendStats(chatId, stats.data, today);

    // Start monitoring
    startMonitoring(bot, chatId, loadCookie);
    await sendMsg(chatId,
      `🟢 *Monitoring Realtime Dimulai\\!*\n` +
      `• Interval: 30 detik\n` +
      `• Nomor dipantau: ${numbersToSave.length}\n` +
      `• Notif otomatis bila ada SMS baru\n\n` +
      `Gunakan /stopmonitor untuk menghentikan\\.`
    );

  } catch (err) {
    log('Flow error: ' + err.message);
    await sendMsg(chatId, `❌ *Error:* \`${escMd(err.message)}\``);
  } finally {
    isRunning = false;
  }
}

// ─── COMMANDS ─────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  await sendMsg(msg.chat.id,
    `🤖 *iVAS Automation Bot*\n\n` +
    `Selamat datang! Pilih menu di bawah ini atau gunakan command manual\\.\n` +
    `Chat ID Anda: \`${msg.chat.id}\``,
    mainKeyboard
  );
});

bot.onText(/\/run/, async (msg) => { await runFullFlow(msg.chat.id); });

bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  const cookie = loadCookie();
  if (!cookie) return sendMsg(chatId, '❌ Cookie belum diset\\.');
  const today = new Date().toISOString().split('T')[0];
  await sendMsg(chatId, `📊 Mengambil Statistics \\(${today}\\)\\.\\.\\. `);
  const stats = await getSMSStats(cookie, today, today);
  if (stats.expired) return sendMsg(chatId, '🔴 Cookie expired\\! /setcookie');
  await formatAndSendStats(chatId, stats.data || [], today);
});

bot.onText(/\/sid/, async (msg) => {
  const chatId = msg.chat.id;
  const cookie = loadCookie();
  if (!cookie) return sendMsg(chatId, '❌ Cookie belum diset\\.');
  await sendMsg(chatId, '🔍 Mencari SID WhatsApp\\.\\.\\. ');
  const sids = await getLatestWhatsappSID(cookie);
  if (sids.expired) return sendMsg(chatId, '🔴 Cookie expired\\! /setcookie');
  if (!sids.data?.length) return sendMsg(chatId, '⚠️ Tidak ada data\\.');
  
  let text = `📱 *SID WhatsApp Terbaru:*\n\n`;
  for (const [i, s] of sids.data.slice(0, 5).entries()) {
    text += `*${i+1}\\.* \`${escMd(s.range)}\`\n`; 
    text += `   SID: \`${escMd(s.originator)}\` | ⏰ ${escMd(s.senttime)}\n\n`;
  }
  await sendMsg(chatId, text);
});

bot.onText(/\/numbers/, async (msg) => {
  const chatId = msg.chat.id;
  const cookie = loadCookie();
  if (!cookie) return sendMsg(chatId, '❌ Cookie belum diset\\.');
  const result = await getTestNumbers(cookie, '');
  if (result.expired) return sendMsg(chatId, '🔴 Cookie expired\\! /setcookie');
  if (!result.data?.length) return sendMsg(chatId, '⚠️ Tidak ada test numbers\\.');
  
  let text = `📋 *Test Numbers \\(Top 10\\):*\n\n`;
  for (const [i, n] of result.data.slice(0, 10).entries()) {
    text += `${i+1}\\. \`${escMd(n.range)}\`\n   No: \`${escMd(n.test_number)}\` | Rate: \`${escMd(n.A2P||'-')}\`\n\n`;
  }
  await sendMsg(chatId, text);
});

bot.onText(/\/mynumbers/, async (msg) => {
  const numbers = loadNumbers();
  if (!numbers.length) return sendMsg(msg.chat.id, '📋 numbers\\.txt kosong\\. Jalankan /run dulu\\.');
  let text = `📋 *numbers\\.txt \\(${numbers.length} nomor\\):*\n\n`;
  for (const [i, n] of numbers.entries()) {
    text += `${i+1}\\. \`${escMd(n.number)}\` — ${escMd(n.range)}\n`;
  }
  await sendMsg(msg.chat.id, text);
});

bot.onText(/\/monitor/, async (msg) => {
  const s = getMonitorStatus();
  let text = `📡 *Status Monitoring:*\n\n`;
  text += `• Status: ${s.isRunning ? '🟢 Aktif' : '🔴 Nonaktif'}\n`;
  text += `• Nomor: ${s.numberCount}\n• Interval: 30 detik\n\n`;
  if (s.numbers.length) {
    text += `*Nomor dipantau:*\n`;
    for (const n of s.numbers) text += `• \`${escMd(n.number)}\` — ${escMd(n.range)}\n`;
  }
  await sendMsg(msg.chat.id, text);
});

bot.onText(/\/stopmonitor/, async (msg) => {
  if (!getMonitorStatus().isRunning) return sendMsg(msg.chat.id, '⚠️ Monitor tidak sedang berjalan\\.');
  stopMonitoring();
  await sendMsg(msg.chat.id, '⏹ *Monitor dihentikan\\.*');
});

bot.onText(/\/returnnumbers/, async (msg) => {
  const cookie = loadCookie();
  if (!cookie) return sendMsg(msg.chat.id, '❌ Cookie belum diset\\.');
  await sendMsg(msg.chat.id, '♻️ Returning semua numbers\\.\\.\\. ');
  const res = await returnAllNumbers(cookie);
  if (res.expired) return sendMsg(msg.chat.id, '🔴 Cookie expired\\! /setcookie');
  await sendMsg(msg.chat.id, `✅ ${escMd(res.message || 'Berhasil')}`);
});

// ─── PERBAIKAN COMMAND /setcookie ─────────────────────────────────────────────
bot.onText(/\/setcookie ([\s\S]+)/, async (msg, match) => {
  try {
    // Ubah baris baru (enter) menjadi titik koma (;) agar tetap bisa di-split dengan benar
    const cookieStr = match[1].replace(/\n/g, '; ').trim();
    const cookieObj = {};
    
    cookieStr.split(';').forEach(p => {
      const [k, ...v] = p.trim().split('=');
      if (k) cookieObj[k.trim()] = v.join('=').trim();
    });
    
    saveCookie(cookieObj, cookieStr);
    await sendMsg(msg.chat.id, '✅ Cookie berhasil disimpan\\!');
  } catch (e) {
    await sendMsg(msg.chat.id, `❌ Format salah: ${escMd(e.message)}`);
  }
});

bot.onText(/\/setcookie$/, async (msg) => {
  await sendMsg(msg.chat.id,
    '📋 *Format:*\n\n`/setcookie XSRF\\-TOKEN=eyJ\\.\\.\\.; ivas\\_sms\\_session=eyJ\\.\\.\\.`\n\n' +
    'Copy dari: F12 → Application → Cookies'
  );
});

bot.onText(/\/cron/, async (msg) => {
  await sendMsg(msg.chat.id,
    `⏰ *Cron:* \`${escMd(config.cron_schedule||'-')}\`\nStatus: ${config.cron_enabled ? '✅ Aktif' : '❌ Nonaktif'}`
  );
});

bot.onText(/\/help/, async (msg) => {
  await sendMsg(msg.chat.id,
    `📖 *Panduan Bot:*\n` +
    `/run — Jalankan flow otomatis\n` +
    `/stats — Statistik SMS\n` +
    `/sid — Cek SID terbaru\n` +
    `/monitor — Status live monitor\n` +
    `/stopmonitor — Matikan monitor\n` +
    `/setcookie [cookie] — Update sesi\n\n` +
    `Atau klik tombol di bawah ini:`,
    mainKeyboard
  );
});

// ─── CALLBACK QUERIES (TOMBOL INTERAKTIF) ─────────────────────────────────────
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  
  // Hapus tanda loading di tombol
  bot.answerCallbackQuery(query.id);
  
  switch (data) {
    case 'run_flow':
      await runFullFlow(chatId);
      break;
    case 'check_stats':
      const cookieStats = loadCookie();
      if (!cookieStats) return sendMsg(chatId, '❌ Cookie belum diset\\.');
      const today = new Date().toISOString().split('T')[0];
      await sendMsg(chatId, `📊 Mengambil Statistics \\(${today}\\)\\.\\.\\. `);
      const stats = await getSMSStats(cookieStats, today, today);
      if (stats.expired) return sendMsg(chatId, '🔴 Cookie expired\\! /setcookie');
      await formatAndSendStats(chatId, stats.data || [], today);
      break;
    case 'check_sid':
      const cookieSid = loadCookie();
      if (!cookieSid) return sendMsg(chatId, '❌ Cookie belum diset\\.');
      await sendMsg(chatId, '🔍 Mencari SID WhatsApp\\.\\.\\. ');
      const sids = await getLatestWhatsappSID(cookieSid);
      if (sids.expired) return sendMsg(chatId, '🔴 Cookie expired\\! /setcookie');
      if (!sids.data?.length) return sendMsg(chatId, '⚠️ Tidak ada data\\.');
      let sidText = `📱 *SID WhatsApp Terbaru:*\n\n`;
      for (const [i, s] of sids.data.slice(0, 5).entries()) {
        sidText += `*${i+1}\\.* \`${escMd(s.range)}\`\n   SID: \`${escMd(s.originator)}\` | ⏰ ${escMd(s.senttime)}\n\n`;
      }
      await sendMsg(chatId, sidText);
      break;
    case 'check_monitor':
      const s = getMonitorStatus();
      let monText = `📡 *Status Monitoring:*\n\n• Status: ${s.isRunning ? '🟢 Aktif' : '🔴 Nonaktif'}\n• Nomor: ${s.numberCount}\n\n`;
      await sendMsg(chatId, monText);
      break;
    case 'stop_monitor':
      if (!getMonitorStatus().isRunning) return sendMsg(chatId, '⚠️ Monitor tidak sedang berjalan\\.');
      stopMonitoring();
      await sendMsg(chatId, '⏹ *Monitor dihentikan\\.*');
      break;
    case 'return_nums':
      const cookieRet = loadCookie();
      if (!cookieRet) return sendMsg(chatId, '❌ Cookie belum diset\\.');
      await sendMsg(chatId, '♻️ Returning semua numbers\\.\\.\\. ');
      const res = await returnAllNumbers(cookieRet);
      if (res.expired) return sendMsg(chatId, '🔴 Cookie expired\\! /setcookie');
      await sendMsg(chatId, `✅ ${escMd(res.message || 'Berhasil')}`);
      break;
    case 'help_menu':
      await sendMsg(chatId, `📖 Fitur siap digunakan\\. Gunakan menu /start untuk memanggil tombol kapan saja\\.`);
      break;
  }
});

// ─── CRON ─────────────────────────────────────────────────────────────────────
if (config.cron_enabled && config.cron_schedule && config.chat_id) {
  cron.schedule(config.cron_schedule, () => {
    log('Cron triggered');
    runFullFlow(config.chat_id);
  }, { timezone: 'Asia/Jakarta' });
  log(`✅ Cron aktif: ${config.cron_schedule}`);
}

// ─── ANTI-CRASH HANDLING ──────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  log(`⚠️ Uncaught Exception: ${err.message}`);
});
process.on('unhandledRejection', (reason, promise) => {
  log(`⚠️ Unhandled Rejection at: ${promise}, reason: ${reason}`);
});

log('✅ iVAS Bot started');
