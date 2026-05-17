require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const cheerio = require('cheerio');
const sqlite3 = require('sqlite3').verbose();
const initCycleTLS = require('cycletls');

// ─── KONFIGURASI ───────────────────────────────────────────────────────────
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
    polling: { interval: 300, autoStart: true, params: { timeout: 10 } },
    request: { family: 4 }
});

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID?.trim();

// ─── DATABASE ──────────────────────────────────────────────────────────────
const db = new sqlite3.Database('./otp_bot.db', () => {
    db.run('PRAGMA journal_mode = WAL;');
    db.run('PRAGMA synchronous = NORMAL;');
});

const dbRun = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function(e) { e ? rej(e) : res(this); }));
const dbGet = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
const dbAll = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));

db.serialize(() => {
    // Tabel akun IVAS (cookies/headers)
    dbRun(`CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        headers TEXT NOT NULL,
        label TEXT DEFAULT '',
        active INTEGER DEFAULT 1,
        added_at TEXT
    )`);
    // Tabel nomor WA yang dimiliki (hasil sync dari IVAS)
    dbRun(`CREATE TABLE IF NOT EXISTS wa_numbers (
        number TEXT PRIMARY KEY,
        account_id INTEGER,
        range_name TEXT
    )`);
});

// ─── HELPERS ───────────────────────────────────────────────────────────────
const delay = ms => new Promise(r => setTimeout(r, ms));
const isAdmin = id => ADMIN_CHAT_ID && id.toString() === ADMIN_CHAT_ID;
const today = () => new Date().toISOString().split('T')[0];
const esc = t => String(t).replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');

let cycleTls = null;

// ─── IVAS CLIENT ───────────────────────────────────────────────────────────
class IVASClient {
    constructor(id, headers) {
        this.id = id;
        this.headers = headers;
        this.csrf = null;
        this.ok = false;
        this.ja3 = '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0';
    }

    async req(path, opts = {}) {
        if (!cycleTls) cycleTls = await initCycleTLS();
        const url = path.startsWith('http') ? path : `https://www.ivasms.com${path}`;
        const ua = this.headers['User-Agent'] || this.headers['user-agent'] || 'Mozilla/5.0';
        const res = await cycleTls(url, {
            headers: { ...this.headers, ...opts.headers },
            ja3: this.ja3,
            userAgent: ua,
            method: opts.method || 'GET',
            body: opts.body,
            disableRedirect: false
        });
        try { res.data = JSON.parse(res.body); } catch { res.data = res.body; }
        return res;
    }

    async init() {
        try {
            const res = await this.req('/portal/sms/received', { headers: { Accept: 'text/html' } });
            if (res.status === 200) {
                const $ = cheerio.load(res.data);
                const tok = $('input[name="_token"]').val();
                if (tok) { this.csrf = tok; this.ok = true; return true; }
            }
        } catch {}
        return false;
    }

    // Ambil semua nomor yang dimiliki akun ini
    async getMyNumbers() {
        try {
            const params = new URLSearchParams({ draw: 1, start: 0, length: 2000, 'search[value]': '' });
            const res = await this.req(`/portal/numbers?${params}`);
            if (res.status === 200 && res.data?.data) {
                return res.data.data.map(i => ({ number: i.Number.toString(), range: i.range }));
            }
        } catch {}
        return [];
    }

    // Ambil pesan SMS untuk nomor tertentu pada tanggal hari ini
    async getMessages(number, range, date) {
        try {
            const body = new URLSearchParams({
                '_token': this.csrf,
                'start': date, 'end': date,
                'Number': number, 'Range': range
            });
            const res = await this.req('/portal/sms/received/getsms/number/sms', {
                method: 'POST',
                body: body.toString(),
                headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }
            });
            if (res.status === 200) {
                const msgs = [];
                const $ = cheerio.load(res.data);
                $('tbody tr').each((_, el) => {
                    const text = $(el).find('.msg-text').text().trim();
                    if (text) msgs.push({
                        sender: $(el).find('.cli-tag').text().trim(),
                        text,
                        time: $(el).find('.time-cell').text().trim(),
                        number, range
                    });
                });
                return msgs;
            }
        } catch {}
        return [];
    }
}

// ─── SESSION MANAGER ───────────────────────────────────────────────────────
const sessions = new Map(); // accountId -> IVASClient

async function loadSessions() {
    const rows = await dbAll('SELECT * FROM accounts WHERE active = 1');
    let loaded = 0;
    for (const row of rows) {
        try {
            const headers = JSON.parse(row.headers);
            const client = new IVASClient(row.id, headers);
            if (await client.init()) {
                sessions.set(row.id, client);
                loaded++;
            }
        } catch {}
    }
    return loaded;
}

function getClients() {
    return [...sessions.values()].filter(c => c.ok);
}

// ─── CORE: CARI OTP BERDASARKAN 4 DIGIT TERAKHIR ──────────────────────────
async function findOtpByLastDigits(digits4) {
    // Cari nomor yang endsWith 4 digit di database
    const rows = await dbAll('SELECT number, range_name, account_id FROM wa_numbers');
    const matched = rows.filter(r => r.number.endsWith(digits4));

    if (matched.length === 0) return { found: false, reason: 'Nomor tidak ditemukan di database. Pastikan sudah sinkronisasi.' };

    const todayStr = today();
    const results = [];

    for (const row of matched) {
        const client = sessions.get(row.account_id) || getClients()[0];
        if (!client) continue;

        const msgs = await client.getMessages(row.number, row.range_name, todayStr);
        if (msgs.length > 0) {
            // Ambil pesan terbaru
            const latest = msgs[0];
            const otpMatch = latest.text.match(/\b\d{3}[-\s]?\d{3}\b/) || latest.text.match(/\b\d{4,8}\b/);
            const otp = otpMatch ? otpMatch[0].replace(/\D/g, '') : null;
            results.push({ ...latest, number: row.number, range: row.range_name, otp });
        }
    }

    if (results.length === 0) return { found: false, reason: 'Belum ada SMS masuk hari ini untuk nomor tersebut.' };
    return { found: true, results };
}

// ─── SYNC NOMOR KE DATABASE ────────────────────────────────────────────────
async function syncNumbers() {
    await dbRun('DELETE FROM wa_numbers');
    let total = 0;
    for (const client of getClients()) {
        const nums = await client.getMyNumbers();
        if (nums.length > 0) {
            const placeholders = nums.map(() => '(?,?,?)').join(',');
            const vals = nums.flatMap(n => [n.number, client.id, n.range]);
            await dbRun(`INSERT OR IGNORE INTO wa_numbers (number, account_id, range_name) VALUES ${placeholders}`, vals);
            total += nums.length;
        }
    }
    return total;
}

// ─── FORMAT REPLY OTP ──────────────────────────────────────────────────────
function formatOtpReply(result) {
    let text = `✅ *SMS OTP DITEMUKAN*\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `📱 Nomor  : \`+${result.number}\`\n`;
    text += `🌍 Negara : ${result.range}\n`;
    text += `✉️ Dari   : ${esc(result.sender)}\n`;
    text += `⏱ Waktu  : ${result.time} (UTC)\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `📝 *Pesan:*\n_${esc(result.text)}_\n`;
    if (result.otp) {
        text += `━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        text += `🔑 *OTP: \`${result.otp}\`*\n`;
        text += `_💡 Tap angka di atas untuk menyalin_`;
    }
    return {
        text,
        markup: result.otp ? {
            inline_keyboard: [[{ text: `🔑 ${result.otp}`, callback_data: 'copy_otp' }]]
        } : undefined
    };
}

// ─── COMMAND: /otp ─────────────────────────────────────────────────────────
// Usage: /otp 1234  (4 digit terakhir nomor)
bot.onText(/\/otp(?:\s+(\d{4}))?/, async (msg) => {
    const chatId = msg.chat.id.toString();
    bot.deleteMessage(chatId, msg.message_id).catch(() => {});

    const digits = msg.text.match(/\/otp\s+(\d{4})/)?.[1];

    if (!digits) {
        return bot.sendMessage(chatId,
            `❌ *Format Salah*\nGunakan: \`/otp 1234\`\n_Isi 4 digit terakhir nomor WhatsApp._`,
            { parse_mode: 'Markdown' }
        );
    }

    if (getClients().length === 0) {
        return bot.sendMessage(chatId,
            `⚠️ *Sistem Offline*\nTidak ada akun API aktif.`,
            { parse_mode: 'Markdown' }
        );
    }

    const statusMsg = await bot.sendMessage(chatId,
        `🔍 *Mencari OTP...*\nNomor dengan akhiran \`****${digits}\``,
        { parse_mode: 'Markdown' }
    );

    const result = await findOtpByLastDigits(digits);

    if (!result.found) {
        return bot.editMessageText(
            `❌ *OTP Tidak Ditemukan*\n${esc(result.reason)}`,
            { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
        );
    }

    // Jika ada lebih dari 1 nomor yang cocok, kirim semua
    if (result.results.length === 1) {
        const reply = formatOtpReply(result.results[0]);
        return bot.editMessageText(reply.text, {
            chat_id: chatId, message_id: statusMsg.message_id,
            parse_mode: 'Markdown',
            reply_markup: reply.markup
        });
    }

    // Multiple match
    await bot.editMessageText(
        `✅ *${result.results.length} Nomor Ditemukan*\nAkhiran \`****${digits}\``,
        { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
    );
    for (const r of result.results) {
        const reply = formatOtpReply(r);
        await bot.sendMessage(chatId, reply.text, { parse_mode: 'Markdown', reply_markup: reply.markup });
        await delay(300);
    }
});

// ─── COMMAND: /sync (admin) ────────────────────────────────────────────────
bot.onText(/\/sync/, async (msg) => {
    const chatId = msg.chat.id.toString();
    bot.deleteMessage(chatId, msg.message_id).catch(() => {});
    if (!isAdmin(chatId)) return bot.sendMessage(chatId, '⛔ Akses ditolak.');

    const m = await bot.sendMessage(chatId, '⏳ *Sinkronisasi nomor dari semua akun...*', { parse_mode: 'Markdown' });
    const total = await syncNumbers();
    bot.editMessageText(
        `✅ *Sinkronisasi Selesai*\nTotal: *${total}* nomor tersimpan.`,
        { chat_id: chatId, message_id: m.message_id, parse_mode: 'Markdown' }
    );
});

// ─── COMMAND: /addaccount (admin) ─────────────────────────────────────────
// Kirim JSON headers sebagai teks setelah command ini
bot.onText(/\/addaccount/, async (msg) => {
    const chatId = msg.chat.id.toString();
    bot.deleteMessage(chatId, msg.message_id).catch(() => {});
    if (!isAdmin(chatId)) return bot.sendMessage(chatId, '⛔ Akses ditolak.');

    pendingAdd[chatId] = true;
    bot.sendMessage(chatId,
        `📋 *Tambah Akun API*\nKirimkan JSON headers dari browser Anda:\n\n\`\`\`\n{\n  "Cookie": "...",\n  "User-Agent": "..."\n}\`\`\``,
        { parse_mode: 'Markdown' }
    );
});

// ─── COMMAND: /listaccounts (admin) ───────────────────────────────────────
bot.onText(/\/listaccounts/, async (msg) => {
    const chatId = msg.chat.id.toString();
    bot.deleteMessage(chatId, msg.message_id).catch(() => {});
    if (!isAdmin(chatId)) return bot.sendMessage(chatId, '⛔ Akses ditolak.');

    const rows = await dbAll('SELECT id, label, active, added_at FROM accounts ORDER BY id ASC');
    if (rows.length === 0) return bot.sendMessage(chatId, '❌ Belum ada akun API.');

    let text = `🏦 *Daftar Akun API*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    for (const r of rows) {
        const isLive = sessions.has(r.id) && sessions.get(r.id).ok;
        text += `${isLive ? '🟢' : '🔴'} ID \`${r.id}\` | ${r.label || 'No Label'}\n   └ Active: ${r.active ? 'Ya' : 'Tidak'} | ${r.added_at}\n\n`;
    }
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
});

// ─── COMMAND: /delaccount {id} (admin) ────────────────────────────────────
bot.onText(/\/delaccount\s+(\d+)/, async (msg, match) => {
    const chatId = msg.chat.id.toString();
    bot.deleteMessage(chatId, msg.message_id).catch(() => {});
    if (!isAdmin(chatId)) return bot.sendMessage(chatId, '⛔ Akses ditolak.');

    const id = parseInt(match[1]);
    sessions.delete(id);
    await dbRun('DELETE FROM accounts WHERE id = ?', [id]);
    await dbRun('DELETE FROM wa_numbers WHERE account_id = ?', [id]);
    bot.sendMessage(chatId, `✅ Akun ID \`${id}\` dihapus.`, { parse_mode: 'Markdown' });
});

// ─── COMMAND: /status (admin) ─────────────────────────────────────────────
bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id.toString();
    bot.deleteMessage(chatId, msg.message_id).catch(() => {});
    if (!isAdmin(chatId)) return bot.sendMessage(chatId, '⛔ Akses ditolak.');

    const totalAcc = await dbGet('SELECT COUNT(*) as c FROM accounts');
    const totalNum = await dbGet('SELECT COUNT(*) as c FROM wa_numbers');
    const activeClients = getClients().length;

    let text = `⚙️ *Status Bot OTP*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `🟢 Akun Aktif : ${activeClients} / ${totalAcc.c}\n`;
    text += `📱 Stok Nomor : ${totalNum.c} Nomor\n`;
    text += `🗓 Tanggal     : ${today()} (UTC)\n`;
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
});

// ─── COMMAND: /help ────────────────────────────────────────────────────────
bot.onText(/\/(start|help)/, async (msg) => {
    const chatId = msg.chat.id.toString();
    bot.deleteMessage(chatId, msg.message_id).catch(() => {});

    const adminCmds = isAdmin(chatId) ? `\n\n👑 *Admin Commands:*\n/addaccount - Tambah akun API\n/listaccounts - Lihat semua akun\n/delaccount {id} - Hapus akun\n/sync - Sinkronisasi nomor\n/status - Status sistem` : '';

    bot.sendMessage(chatId,
        `🤖 *Bot OTP IVAS*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n📌 *Cara Pakai:*\n\`/otp 1234\`\n_Ganti 1234 dengan 4 digit terakhir nomor WA Anda._${adminCmds}`,
        { parse_mode: 'Markdown' }
    );
});

// ─── HANDLER: Terima JSON headers setelah /addaccount ─────────────────────
const pendingAdd = {};

bot.on('message', async (msg) => {
    const chatId = msg.chat.id.toString();
    const text = msg.text;
    if (!text || text.startsWith('/')) return;
    if (!isAdmin(chatId) || !pendingAdd[chatId]) return;

    bot.deleteMessage(chatId, msg.message_id).catch(() => {});
    delete pendingAdd[chatId];

    try {
        const headers = JSON.parse(text);
        const label = `Akun ${Date.now()}`;
        const res = await dbRun(
            'INSERT INTO accounts (headers, label, added_at) VALUES (?,?,?)',
            [JSON.stringify(headers), label, new Date().toISOString()]
        );
        const id = res.lastID;
        const client = new IVASClient(id, headers);
        const m = await bot.sendMessage(chatId, '⏳ *Memverifikasi sesi...*', { parse_mode: 'Markdown' });

        if (await client.init()) {
            sessions.set(id, client);
            const nums = await client.getMyNumbers();
            if (nums.length > 0) {
                const placeholders = nums.map(() => '(?,?,?)').join(',');
                await dbRun(`INSERT OR IGNORE INTO wa_numbers (number, account_id, range_name) VALUES ${placeholders}`, nums.flatMap(n => [n.number, id, n.range]));
            }
            bot.editMessageText(
                `✅ *Akun Berhasil Ditambahkan*\nID: \`${id}\` | Label: ${label}\nNomor tersimpan: ${nums.length}`,
                { chat_id: chatId, message_id: m.message_id, parse_mode: 'Markdown' }
            );
        } else {
            await dbRun('DELETE FROM accounts WHERE id = ?', [id]);
            bot.editMessageText(
                `❌ *Autentikasi Gagal*\nHeaders tidak valid atau sesi expired.`,
                { chat_id: chatId, message_id: m.message_id, parse_mode: 'Markdown' }
            );
        }
    } catch (e) {
        bot.sendMessage(chatId, `❌ *Format JSON Salah*\n_${e.message}_`, { parse_mode: 'Markdown' });
    }
});

// ─── CALLBACK QUERY ────────────────────────────────────────────────────────
bot.on('callback_query', (query) => {
    if (query.data === 'copy_otp') {
        bot.answerCallbackQuery(query.id, {
            text: '💡 Tap teks OTP (abu-abu) di dalam pesan untuk menyalin.',
            show_alert: true
        });
    }
});

// ─── INIT ──────────────────────────────────────────────────────────────────
(async () => {
    console.log('[BOT] Memuat sesi akun API...');
    const loaded = await loadSessions();
    console.log(`[BOT] ${loaded} akun aktif.`);
    console.log('[BOT] Bot OTP siap. Gunakan /otp 1234 untuk cek OTP.');
})();
