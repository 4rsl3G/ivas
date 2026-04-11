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
const bot = new TelegramBot(config.telegram_token, { polling: true });

// ─── STATE MANAGEMENT ─────────────────────────────────────────────────────────
let isRunning = false;
const userStates = {}; // Menyimpan status input user untuk wizard cookie

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  console.log(`[${ts}] ${msg}`);
}

// Aman dari karakter aneh karena pakai HTML
function esc(text) {
  if (!text) return '-';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function sendMsg(chatId, text, options = {}) {
  try {
    bot.sendChatAction(chatId, 'typing');
    // Berubah jadi HTML agar teks lebih rapi dan bersih
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...options });
  } catch (e) {
    console.error('Send error:', e.message);
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

// Membersihkan token dari spasi, enter, atau atribut tambahan
function cleanToken(text) {
  let cleaned = text;
  if (cleaned.includes('=')) {
    const parts = cleaned.split(';');
    cleaned = parts[0]; 
    if (cleaned.includes('XSRF-TOKEN=')) cleaned = cleaned.replace(/.*?XSRF-TOKEN=/i, '');
    if (cleaned.includes('ivas_sms_session=')) cleaned = cleaned.replace(/.*?ivas_sms_session=/i, '');
  }
  return cleaned.replace(/[\r\n\s]+/g, ''); // Hapus semua enter & spasi
}

// ─── AMBIL MY NUMBERS ────────────────────────────────────────────────────────
async function getAssignedNumbers(cookie, rangeName) {
  try {
    const params = new URLSearchParams({
      draw: '1', 'columns[1][data]': 'Number', 'columns[2][data]': 'range',
      'columns[7][data]': 'action', 'order[0][column]': '1', 'order[0][dir]': 'desc',
      'start': '0', 'length': '100', 'search[value]': rangeName || '', '_': String(Date.now())
    });

    const res = await axios.get(`https://www.ivasms.com/portal/numbers?${params.toString()}`, {
      headers: {
        'Cookie': buildCookieHeader(cookie), 'X-CSRF-TOKEN': getCsrfToken(cookie),
        'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Referer': 'https://www.ivasms.com/portal/numbers',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 15000
    });
    return { expired: false, data: res.data?.data || [] };
  } catch (err) {
    if (err.response?.status === 401 || err.response?.status === 419) return { expired: true };
    return { expired: false, data: [], error: err.message };
  }
}

// ─── FORMAT STATS ─────────────────────────────────────────────────────────────
async function formatAndSendStats(chatId, stats, date) {
  if (!stats || stats.length === 0) return sendMsg(chatId, '📊 Tidak ada data SMS Statistics untuk hari ini.');
  if (stats[0]?.parse_failed) return sendMsg(chatId, '⚠️ SMS Statistics tersedia tapi gagal di-parse. Cek manual di portal.');

  let totalSMS = 0, totalPaid = 0, totalUnpaid = 0, totalRevenue = 0;
  let msg = `📊 <b>SMS Statistics — ${esc(date)}</b>\n${'─'.repeat(28)}\n\n`;

  for (const r of stats) {
    totalSMS     += parseInt(r.count || 0);
    totalPaid    += parseInt(r.paid || 0);
    totalUnpaid  += parseInt(r.unpaid || 0);
    totalRevenue += parseFloat(r.revenue || 0);

    msg += `📁 <b>${esc(r.range_name || '-')}</b>\n`;
    msg += `  SMS: ${r.count||0} | ✅ ${r.paid||0} | ❌ ${r.unpaid||0}\n`;
    msg += `  💰 $${parseFloat(r.revenue||0).toFixed(4)}\n\n`;
  }

  msg += `${'─'.repeat(28)}\n📈 <b>TOTAL</b>\n`;
  msg += `• SMS: ${totalSMS} | ✅ ${totalPaid} | ❌ ${totalUnpaid}\n`;
  msg += `• 💰 $${totalRevenue.toFixed(4)}`;

  await sendMsg(chatId, msg);
}

// ─── KEYBOARDS (FULL MENU) ────────────────────────────────────────────────────
const mainKeyboard = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '🚀 Jalankan Flow Utama', callback_data: 'run_flow' }],
      [{ text: '📊 Statistik', callback_data: 'check_stats' }, { text: '📱 Cek SID WA', callback_data: 'check_sid' }],
      [{ text: '📡 Status Monitor', callback_data: 'check_monitor' }, { text: '⏹ Stop Monitor', callback_data: 'stop_monitor' }],
      [{ text: '♻️ Return Semua', callback_data: 'return_nums' }, { text: '📋 My Numbers', callback_data: 'my_numbers' }],
      [{ text: '🍪 Update Cookie (Login)', callback_data: 'update_cookie' }]
    ]
  }
};

const cancelKeyboard = {
  reply_markup: {
    inline_keyboard: [[{ text: '❌ Batal / Cancel', callback_data: 'cancel_input' }]]
  }
};

// ─── FLOW UTAMA ───────────────────────────────────────────────────────────────
async function runFullFlow(chatId) {
  if (isRunning) return sendMsg(chatId, '⚠️ Flow sedang berjalan, tunggu selesai dulu.');
  isRunning = true;
  const today = new Date().toISOString().split('T')[0];

  try {
    await sendMsg(chatId, '🚀 <b>Memulai flow iVAS...</b>');

    const cookie = loadCookie();
    if (!cookie) {
      isRunning = false;
      return sendMsg(chatId, '❌ Cookie tidak ditemukan. Silakan klik tombol <b>Update Cookie</b> di menu.');
    }

    if (getMonitorStatus().isRunning) {
      stopMonitoring();
      await sendMsg(chatId, '⏹ Monitor lama dihentikan.');
    }
    clearNumbers();

    await sendMsg(chatId, '♻️ <b>[1/5]</b> Return semua number...');
    const ret = await returnAllNumbers(cookie);
    if (ret.expired) { isRunning = false; return sendMsg(chatId, '🔴 Cookie expired! Silakan Update Cookie.'); }
    await sendMsg(chatId, `✅ ${esc(ret.message || 'Berhasil')}`);
    await sleep(3000);

    await sendMsg(chatId, '🔍 <b>[2/5]</b> Mencari SID WhatsApp terbaru...');
    const sids = await getLatestWhatsappSID(cookie);
    if (sids.expired) { isRunning = false; return sendMsg(chatId, '🔴 Cookie expired!'); }
    if (!sids.data?.length) { isRunning = false; return sendMsg(chatId, '⚠️ Tidak ada SID WhatsApp.'); }

    const sid = sids.data[0];
    await sendMsg(chatId, `✅ <b>SID Terbaru:</b>\n• Range: <code>${esc(sid.range)}</code>\n• SID: <code>${esc(sid.originator)}</code>\n• No: <code>${esc(sid.test_number||'-')}</code>\n• Waktu: <code>${esc(sid.senttime)}</code>`);

    await sendMsg(chatId, `🔍 <b>[3/5]</b> Mencari range di Test Numbers...`);
    const testNums = await getTestNumbers(cookie, sid.range);
    if (testNums.expired) { isRunning = false; return sendMsg(chatId, '🔴 Cookie expired!'); }
    if (!testNums.data?.length) { isRunning = false; return sendMsg(chatId, `⚠️ Range "${esc(sid.range)}" tidak ditemukan.`); }

    const target = testNums.data[0];
    const rangeId = extractIdFromAction(target.action);
    if (!rangeId) { isRunning = false; return sendMsg(chatId, '⚠️ Gagal ekstrak ID.'); }

    await sendMsg(chatId, `✅ <b>Range Ditemukan:</b>\n• No: <code>${esc(target.test_number)}</code>\n• ID: <code>${rangeId}</code>`);

    await sendMsg(chatId, `➕ <b>[4/5]</b> Add number ID ${rangeId}...`);
    await sleep(2000);
    const addRes = await addNumber(cookie, rangeId);
    if (addRes.expired) { isRunning = false; return sendMsg(chatId, '🔴 Cookie expired!'); }
    await sendMsg(chatId, `✅ ${esc(addRes.message || 'Berhasil add number')}`);
    await sleep(5000);

    await sendMsg(chatId, `📋 <b>[5/5]</b> Mengambil nomor yang di-assign...`);
    const assigned = await getAssignedNumbers(cookie, target.range);
    if (assigned.expired) { isRunning = false; return sendMsg(chatId, '🔴 Cookie expired!'); }

    let numbersToSave = [];
    if (assigned.data?.length > 0) {
      numbersToSave = assigned.data.map(n => ({ number: n.Number || n.number || '', range: n.range || target.range })).filter(n => n.number);
    }
    if (numbersToSave.length === 0) numbersToSave = [{ number: target.test_number, range: target.range }];

    saveNumbers(numbersToSave);

    let numMsg = `✅ <b>${numbersToSave.length} Nomor Tersimpan:</b>\n\n`;
    for (const n of numbersToSave.slice(0, 10)) numMsg += `• <code>${esc(n.number)}</code> — ${esc(n.range)}\n`;
    await sendMsg(chatId, numMsg);

    await sendMsg(chatId, `📊 Mengambil SMS Statistics (${today})...`);
    const stats = await getSMSStats(cookie, today, today);
    if (!stats.expired && stats.data) await formatAndSendStats(chatId, stats.data, today);

    startMonitoring(bot, chatId, loadCookie);
    await sendMsg(chatId, `🟢 <b>Monitoring Realtime Dimulai!</b>\n• Interval: 30 detik\n• Nomor dipantau: ${numbersToSave.length}\n\n<i>Bot akan mengirim notif bila ada SMS baru.</i>`);

  } catch (err) {
    log('Flow error: ' + err.message);
    await sendMsg(chatId, `❌ <b>Error:</b> <code>${esc(err.message)}</code>`);
  } finally {
    isRunning = false;
  }
}

// ─── COMMANDS PINTASAN ────────────────────────────────────────────────────────
bot.onText(/\/(start|menu)/, async (msg) => {
  delete userStates[msg.chat.id]; // Reset state jika user panggil menu
  await sendMsg(msg.chat.id, 
    `🤖 <b>iVAS Automation Bot</b>\n\nSelamat datang! Silakan klik tombol di bawah ini untuk mengontrol bot.\nID Anda: <code>${msg.chat.id}</code>`, 
    mainKeyboard
  );
});

// ─── TEXT HANDLER (UNTUK INPUT WIZARD) ────────────────────────────────────────
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || '';
  
  if (text.startsWith('/')) return; // Abaikan jika ini command

  if (userStates[chatId]) {
    if (userStates[chatId].step === 'AWAITING_XSRF') {
      const xsrf = cleanToken(text);
      userStates[chatId].xsrf = xsrf;
      userStates[chatId].step = 'AWAITING_SESSION';
      await sendMsg(chatId, "✅ <b>XSRF-TOKEN diterima!</b>\n\nLangkah 2:\nSilakan kirimkan nilai untuk <b>ivas_sms_session</b>:", cancelKeyboard);
      
    } else if (userStates[chatId].step === 'AWAITING_SESSION') {
      const session = cleanToken(text);
      try {
        saveCookie({ 'XSRF-TOKEN': userStates[chatId].xsrf, 'ivas_sms_session': session }, "Manual via Bot");
        delete userStates[chatId]; // Bersihkan state
        await sendMsg(chatId, "🎉 <b>Sempurna! Cookie berhasil disimpan.</b>\nSistem siap digunakan.", mainKeyboard);
      } catch (e) {
        await sendMsg(chatId, `❌ Gagal menyimpan: ${e.message}`, mainKeyboard);
      }
    }
  }
});

// ─── CALLBACK QUERIES (TOMBOL) ────────────────────────────────────────────────
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  bot.answerCallbackQuery(query.id); // Hapus efek loading

  switch (data) {
    case 'run_flow':
      await runFullFlow(chatId);
      break;
    
    case 'update_cookie':
      userStates[chatId] = { step: 'AWAITING_XSRF', xsrf: '' };
      await sendMsg(chatId, "🛠 <b>Update Cookie Mode</b>\n\nLangkah 1:\nSilakan kirimkan nilai untuk <b>XSRF-TOKEN</b> Anda:", cancelKeyboard);
      break;
    
    case 'cancel_input':
      delete userStates[chatId];
      await sendMsg(chatId, "❌ <i>Input dibatalkan.</i>", mainKeyboard);
      break;

    case 'check_stats':
      const cookieStats = loadCookie();
      if (!cookieStats) return sendMsg(chatId, '❌ Cookie belum diset.');
      const today = new Date().toISOString().split('T')[0];
      await sendMsg(chatId, `📊 Mengambil Statistics (${today})...`);
      const stats = await getSMSStats(cookieStats, today, today);
      if (stats.expired) return sendMsg(chatId, '🔴 Cookie expired! Silakan Update Cookie.');
      await formatAndSendStats(chatId, stats.data || [], today);
      break;

    case 'check_sid':
      const cookieSid = loadCookie();
      if (!cookieSid) return sendMsg(chatId, '❌ Cookie belum diset.');
      await sendMsg(chatId, '🔍 Mencari SID WhatsApp...');
      const sids = await getLatestWhatsappSID(cookieSid);
      if (sids.expired) return sendMsg(chatId, '🔴 Cookie expired!');
      if (!sids.data?.length) return sendMsg(chatId, '⚠️ Tidak ada data.');
      let sidText = `📱 <b>SID WhatsApp Terbaru:</b>\n\n`;
      for (const [i, s] of sids.data.slice(0, 5).entries()) {
        sidText += `<b>${i+1}.</b> <code>${esc(s.range)}</code>\n   SID: <code>${esc(s.originator)}</code> | ⏰ ${esc(s.senttime)}\n\n`;
      }
      await sendMsg(chatId, sidText);
      break;

    case 'check_monitor':
      const s = getMonitorStatus();
      let monText = `📡 <b>Status Monitoring:</b>\n\n• Status: ${s.isRunning ? '🟢 Aktif' : '🔴 Nonaktif'}\n• Nomor dipantau: ${s.numberCount}\n\n`;
      if (s.numbers.length) {
        for (const n of s.numbers) monText += `• <code>${esc(n.number)}</code> — ${esc(n.range)}\n`;
      }
      await sendMsg(chatId, monText);
      break;

    case 'stop_monitor':
      if (!getMonitorStatus().isRunning) return sendMsg(chatId, '⚠️ Monitor tidak sedang berjalan.');
      stopMonitoring();
      await sendMsg(chatId, '⏹ <b>Monitor dihentikan.</b>');
      break;

    case 'return_nums':
      const cookieRet = loadCookie();
      if (!cookieRet) return sendMsg(chatId, '❌ Cookie belum diset.');
      await sendMsg(chatId, '♻️ Returning semua numbers...');
      const res = await returnAllNumbers(cookieRet);
      if (res.expired) return sendMsg(chatId, '🔴 Cookie expired!');
      await sendMsg(chatId, `✅ ${esc(res.message || 'Berhasil')}`);
      break;

    case 'my_numbers':
      const numbers = loadNumbers();
      if (!numbers.length) return sendMsg(chatId, '📋 numbers.txt kosong. Jalankan Flow dulu.');
      let numTxt = `📋 <b>My Numbers (${numbers.length}):</b>\n\n`;
      for (const [i, n] of numbers.entries()) numTxt += `${i+1}. <code>${esc(n.number)}</code> — ${esc(n.range)}\n`;
      await sendMsg(chatId, numTxt);
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

process.on('uncaughtException', (err) => log(`⚠️ Uncaught Exception: ${err.message}`));
process.on('unhandledRejection', (reason, promise) => log(`⚠️ Unhandled Rejection: ${reason}`));

log('✅ iVAS Bot started (Full HTML & Buttons Mode)');
