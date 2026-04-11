const fs = require('fs');
const path = require('path');
const { getSMSDetail } = require('./ivas');

const NUMBERS_FILE = path.join(__dirname, 'numbers.txt');
const POLL_INTERVAL = 30000; // 30 detik

// ─── STATE ────────────────────────────────────────────────────────────────────
// Map<"Number|Range", Set<string>> — menyimpan SMS ID/key yang sudah dinotif
const seenSMS = new Map();
let monitorInterval = null;
let isMonitoring = false;
let botInstance = null;
let chatIdInstance = null;
let cookieGetter = null; // fungsi untuk ambil cookie terbaru

// ─── HELPERS LOKAL ────────────────────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  console.log(`[Monitor][${ts}] ${msg}`);
}

// Escape karakter khusus untuk Telegram MarkdownV2
function escMd(text) {
  if (!text) return '-';
  return String(text).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── NUMBERS FILE ─────────────────────────────────────────────────────────────
/**
 * Simpan daftar nomor ke numbers.txt
 * Format per baris: Number|Range
 */
function saveNumbers(numbers) {
  const lines = numbers.map(n => `${n.number}|${n.range}`);
  fs.writeFileSync(NUMBERS_FILE, lines.join('\n'), 'utf-8');
  log(`Saved ${numbers.length} numbers to numbers.txt`);
}

/**
 * Load daftar nomor dari numbers.txt
 * Return: Array of { number, range }
 */
function loadNumbers() {
  if (!fs.existsSync(NUMBERS_FILE)) return [];
  const content = fs.readFileSync(NUMBERS_FILE, 'utf-8').trim();
  if (!content) return [];

  return content.split('\n')
    .map(line => line.trim())
    .filter(line => line && line.includes('|'))
    .map(line => {
      const [number, ...rangeParts] = line.split('|');
      return { number: number.trim(), range: rangeParts.join('|').trim() };
    });
}

/**
 * Tambah nomor baru ke numbers.txt (hindari duplikat)
 */
function addNumberToFile(number, range) {
  const existing = loadNumbers();
  const key = `${number}|${range}`;
  const alreadyExists = existing.some(n => `${n.number}|${n.range}` === key);
  
  if (!alreadyExists) {
    existing.push({ number, range });
    saveNumbers(existing);
    return true;
  }
  return false;
}

/**
 * Hapus semua isi numbers.txt
 */
function clearNumbers() {
  fs.writeFileSync(NUMBERS_FILE, '', 'utf-8');
}

// ─── SMS KEY (untuk deteksi SMS baru) ────────────────────────────────────────
function makeSMSKey(sender, message, time) {
  return `${sender}__${message}__${time}`;
}

// ─── PARSE HTML RESPONSE (MODERN JS) ──────────────────────────────────────────
function parseSMSTable(html) {
  if (!html || typeof html !== 'string') return [];

  const results = [];
  const tbodyMatch = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  const tbody = tbodyMatch ? tbodyMatch[1] : html;

  // Menggunakan matchAll untuk parsing yang lebih bersih
  const trMatches = [...tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];

  for (const tr of trMatches) {
    const rowHtml = tr[1];
    const tds = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(td => {
      return td[1]
        .replace(/<[^>]+>/g, '') // Hapus tag HTML
        .replace(/&[a-z]+;/gi, ' ') // Bersihkan entitas HTML (&amp;, dll)
        .trim();
    });

    // Kolom: Sender, Message, Time, Revenue
    if (tds.length >= 3) {
      results.push({
        sender:  tds[0] || '-',
        message: tds[1] || '-',
        time:    tds[2] || '-',
        revenue: tds[3] || '0'
      });
    }
  }

  return results;
}

// ─── POLLING SATU NOMOR ───────────────────────────────────────────────────────
async function pollNumber(cookie, numObj, today) {
  const key = `${numObj.number}|${numObj.range}`;

  if (!seenSMS.has(key)) {
    seenSMS.set(key, new Set());
  }
  const seen = seenSMS.get(key);

  const result = await getSMSDetail(cookie, today, today, numObj.number, numObj.range);

  if (result.expired) return { expired: true };
  if (result.error) return { error: true, message: result.message };

  const rawHtml = result.rawHtml || '';
  const smsList = rawHtml ? parseSMSTable(rawHtml) : (result.data || []);

  const newSMS = [];

  for (const sms of smsList) {
    const smsKey = makeSMSKey(sms.sender, sms.message, sms.time);
    if (!seen.has(smsKey)) {
      seen.add(smsKey);
      newSMS.push(sms);
    }
  }

  return { expired: false, newSMS, total: smsList.length };
}

// ─── FORMAT NOTIF SMS BARU ────────────────────────────────────────────────────
function formatNewSMSNotif(numObj, smsList) {
  let msg = `📨 *SMS Baru Diterima\\!*\n`;
  msg += `📞 Number: \`${escMd(numObj.number)}\`\n`;
  msg += `📁 Range: \`${escMd(numObj.range)}\`\n`;
  msg += `${'─'.repeat(28)}\n\n`;

  for (const [i, sms] of smsList.entries()) {
    msg += `*${i + 1}\\. ${escMd(sms.sender)}*\n`;
    msg += `💬 ${escMd(sms.message)}\n`;
    msg += `🕐 ${escMd(sms.time)}\n`;
    msg += `💰 ${escMd(sms.revenue)}\n`;
    if (i < smsList.length - 1) msg += '\n';
  }

  return msg;
}

// ─── START MONITORING ─────────────────────────────────────────────────────────
function startMonitoring(bot, chatId, getCookie) {
  if (isMonitoring) {
    log('Already running');
    return false;
  }

  botInstance = bot;
  chatIdInstance = chatId;
  cookieGetter = getCookie;
  isMonitoring = true;

  log('Starting realtime SMS monitor (30s interval)');

  monitorInterval = setInterval(async () => {
    await runPollCycle();
  }, POLL_INTERVAL);

  // Langsung poll sekali di awal
  setTimeout(() => runPollCycle(), 2000);

  return true;
}

async function runPollCycle() {
  const numbers = loadNumbers();
  if (numbers.length === 0) return;

  const cookie = cookieGetter();
  if (!cookie) return;

  const today = new Date().toISOString().split('T')[0];

  for (const numObj of numbers) {
    try {
      const result = await pollNumber(cookie, numObj, today);

      if (result.expired) {
        stopMonitoring();
        await safeSend(
          '🔴 *Cookie expired saat monitoring\\!*\n' +
          'Monitor dihentikan\\. Update cookie dengan /setcookie lalu jalankan /run lagi\\.'
        );
        return;
      }

      if (result.newSMS && result.newSMS.length > 0) {
        const msg = formatNewSMSNotif(numObj, result.newSMS);
        await safeSend(msg);
      }

      // Jeda kecil antar request agar tidak rate limited
      await sleep(1500);

    } catch (err) {
      log(`Error polling ${numObj.number}: ${err.message}`);
    }
  }
}

// ─── STOP MONITORING ──────────────────────────────────────────────────────────
function stopMonitoring() {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
  isMonitoring = false;
  seenSMS.clear();
  log('Stopped');
}

function getMonitorStatus() {
  const numbers = loadNumbers();
  return {
    isRunning: isMonitoring,
    numberCount: numbers.length,
    numbers
  };
}

// ─── BOT SAFE SENDER ──────────────────────────────────────────────────────────
async function safeSend(text) {
  if (!botInstance || !chatIdInstance) return;
  try {
    await botInstance.sendMessage(chatIdInstance, text, { parse_mode: 'MarkdownV2' });
  } catch (e) {
    try {
      // Fallback jika formatting Markdown gagal
      await botInstance.sendMessage(chatIdInstance, text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, ''));
    } catch (e2) {
      log(`Send error: ${e2.message}`);
    }
  }
}

module.exports = {
  startMonitoring,
  stopMonitoring,
  getMonitorStatus,
  saveNumbers,
  loadNumbers,
  addNumberToFile,
  clearNumbers,
  parseSMSTable
};
