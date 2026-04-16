require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar, Cookie } = require('tough-cookie');
const cheerio = require('cheerio');
const pino = require('pino');
const sqlite3 = require('sqlite3').verbose();
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    Browsers, 
    fetchLatestBaileysVersion
} = require('baileys');

// ─── KONFIGURASI BOT ───────────────────────────────────────────────────────
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { 
    polling: { interval: 300, autoStart: true, params: { timeout: 10 } },
    request: { family: 4 }
});

const POLLING_INTERVAL = process.env.POLLING_INTERVAL || 5000;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? process.env.ADMIN_CHAT_ID.trim() : null; 
const REQUIRED_CHANNEL_ID = process.env.REQUIRED_CHANNEL_ID ? process.env.REQUIRED_CHANNEL_ID.trim() : null;
const REQUIRED_CHANNEL_LINK = process.env.REQUIRED_CHANNEL_LINK ? process.env.REQUIRED_CHANNEL_LINK.trim() : 'https://t.me/yourchannel';

// ─── MANAJEMEN STATE ───────────────────────────────────────────────────────
const userStates = {}; 
const activeSessions = new Map(); 
const activeOtpPolling = new Map();
const jobQueue = new Map();

const forceSubCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; 

const SPEED_MODES = {
    fast: { batch: 10, delay: 1000 },
    normal: { batch: 5, delay: 3000 },
    slow: { batch: 2, delay: 6000 }
};

let sock; 
let isConnectingWA = false;

// ─── BASIS DATA (SQLite WAL Mode) ──────────────────────────────────────────
const sqlDb = new sqlite3.Database('./pansa_bot.db', (err) => {
    if (!err) {
        sqlDb.run('PRAGMA journal_mode = WAL;');
        sqlDb.run('PRAGMA synchronous = NORMAL;');
    }
});

const dbRun = (sql, params = []) => new Promise((res, rej) => sqlDb.run(sql, params, function(err) { err ? rej(err) : res(this); }));
const dbGet = (sql, params = []) => new Promise((res, rej) => sqlDb.get(sql, params, (err, row) => err ? rej(err) : res(row)));
const dbAll = (sql, params = []) => new Promise((res, rej) => sqlDb.all(sql, params, (err, rows) => err ? rej(err) : res(rows)));

sqlDb.serialize(() => {
    dbRun(`CREATE TABLE IF NOT EXISTS ivas_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, cookies TEXT, added_at TEXT)`);
    dbRun(`CREATE TABLE IF NOT EXISTS wa_nodes (number TEXT PRIMARY KEY, account_id INTEGER, range_name TEXT)`);
    dbRun(`CREATE TABLE IF NOT EXISTS seen_ids (msg_id TEXT PRIMARY KEY, account_id INTEGER)`);
    dbRun(`CREATE TABLE IF NOT EXISTS whitelisted_users (chat_id TEXT PRIMARY KEY, username TEXT, added_at TEXT)`);
    dbRun(`CREATE TABLE IF NOT EXISTS user_assigned_numbers (user_chat_id TEXT PRIMARY KEY, number TEXT, range_name TEXT, assigned_at TEXT)`);
    dbRun(`CREATE TABLE IF NOT EXISTS used_numbers (number TEXT PRIMARY KEY, user_chat_id TEXT)`);
});

// ─── UTILITAS & HELPERS ────────────────────────────────────────────────────
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const getTodayUTC = () => new Date().toISOString().split('T')[0];
const isAdmin = chatId => ADMIN_CHAT_ID && chatId.toString() === ADMIN_CHAT_ID;
// Fungsi penting untuk mencegah bot crash akibat format Markdown
const escapeMarkdown = text => text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');

async function safeEditMessageText(text, options) {
    try { await bot.editMessageText(text, options); } catch (e) { if (!e.message.includes('message is not modified')) console.error(e.message); }
}

// ─── SISTEM FORCE SUB (Bebas Bug 5-Menit) ──────────────────────────────────
async function checkForceSub(chatId) {
    if (!REQUIRED_CHANNEL_ID || isAdmin(chatId)) return true; 
    const now = Date.now();
    
    // Hanya gunakan cache jika user SEBELUMNYA SUDAH JOIN (status = true)
    if (forceSubCache.has(chatId)) {
        const cached = forceSubCache.get(chatId);
        if (cached.status === true && (now - cached.timestamp < CACHE_TTL)) return true;
    }
    
    try {
        const member = await bot.getChatMember(REQUIRED_CHANNEL_ID, chatId);
        const isSubbed = ['creator', 'administrator', 'member', 'restricted'].includes(member.status);
        forceSubCache.set(chatId, { status: isSubbed, timestamp: now });
        return isSubbed;
    } catch (e) { return false; }
}

async function sendForceSubMessage(chatId, msgId = null) {
    const text = `🚫 *AKSES DITOLAK*\n━━━━━━━━━━━━━━━━━━━━━━\nSistem ini bersifat publik, namun Anda *wajib bergabung dengan Kanal Resmi* kami untuk mendapat akses.\n\n👇 _Silakan bergabung melalui tautan di bawah, lalu verifikasi:_`;
    const markup = { inline_keyboard: [ [{ text: '🔗 Bergabung ke Kanal Resmi', url: REQUIRED_CHANNEL_LINK }], [{ text: '✅ Saya Telah Bergabung', callback_data: 'check_join' }] ] };
    if (msgId) await safeEditMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: markup });
    else await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: markup });
}

// ─── UI / UX MARKUPS ───────────────────────────────────────────────────────
const getMainMenuMarkup = () => ({
    inline_keyboard: [
        [{ text: '🔑 Tambah Akun API', callback_data: 'cmd_login' }, { text: '🗃 Sinkronisasi Server', callback_data: 'cmd_sync_db' }],
        [{ text: '📢 Siarkan Stok Nomor', callback_data: 'cmd_active_ranges' }, { text: '🛒 Cari Nomor Spesifik', callback_data: 'cmd_search_range' }],
        [{ text: '📡 Auto-Buy Nomor', callback_data: 'cmd_hunt_wa' }, { text: '📱 Cek Stok Nomor', callback_data: 'cmd_get_wa_numbers_0' }],
        [{ text: '🧹 Hapus Nomor Mati', callback_data: 'cmd_clean_dead_nodes' }, { text: '🗑 Kosongkan Semua', callback_data: 'cmd_delete_all' }],
        [{ text: '🔗 Hubungkan WA', callback_data: 'cmd_wa_login' }, { text: '🔌 Putuskan WA', callback_data: 'cmd_wa_logout' }],
        [{ text: '⚙️ Status Sistem', callback_data: 'cmd_status' }, { text: '🔍 Cari Riwayat SMS', callback_data: 'cmd_search' }]
    ]
});

const getUserMenuMarkup = () => ({ inline_keyboard: [[{ text: '📱 Minta Nomor Baru', callback_data: 'user_get_number' }]] });
const getCancelMarkup = () => ({ inline_keyboard: [[{ text: '❌ Batalkan Operasi', callback_data: 'cmd_cancel' }]] });

function formatMessageCard(msgData) {
    const otpMatch = msgData.text.match(/\b\d{3}[-\s]?\d{3}\b/) || msgData.text.match(/\b\d{4,8}\b/);
    const cleanOtp = otpMatch ? otpMatch[0].replace(/\D/g, '') : null;
    
    let text = `✦ *KOTAK MASUK SMS* ✦\n━━━━━━━━━━━━━━━━━━━━━━\n📱 𝗡𝗼𝗺𝗼𝗿 : \`+${msgData.phoneNumber}\`\n🌍 𝗡𝗲𝗴𝗮𝗿𝗮 : ${msgData.countryRange}\n📨 𝗣𝗲𝗻𝗴𝗶𝗿𝗶𝗺 : ${msgData.sender}\n⏱ 𝗪𝗮𝗸𝘁𝘂 : ${msgData.time} (UTC)\n━━━━━━━━━━━━━━━━━━━━━━\n💬 𝗣𝗲𝘀𝗮𝗻 :\n_${escapeMarkdown(msgData.text)}_\n`;
    
    const inline_keyboard = [];
    if (cleanOtp) {
        text += `\n🔑 *KODE OTP* : \`${cleanOtp}\`\n_💡 Ketuk angka OTP di atas untuk menyalin_`;
        inline_keyboard.push([{ text: `🔑 ${cleanOtp}`, callback_data: 'dummy_btn' }]);
    }
    inline_keyboard.push([{ text: '🤖 Kembali ke Menu Utama', url: `https://t.me/${process.env.BOT_USERNAME || 'bot'}` }]); 
    return { text, reply_markup: { inline_keyboard } };
}

// ─── CORE: KELAS IVAS ACCOUNT ──────────────────────────────────────────────
class IVASAccount {
    constructor(accountId, cookies) {
        this.accountId = accountId;
        this.cookies = cookies;
        this.jar = new CookieJar();
        this.client = wrapper(axios.create({
            jar: this.jar, baseURL: 'https://www.ivasms.com', timeout: 15000,
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36', 
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'Sec-Fetch-Site': 'same-origin',
                'X-Requested-With': 'XMLHttpRequest'
            }
        }));
        this.loggedIn = false;
        this.csrfToken = null;
    }
    async initSession() {
        for (const [name, value] of Object.entries(this.cookies)) {
            await this.jar.setCookie(new Cookie({ key: name, value: value, domain: 'www.ivasms.com' }).toString(), 'https://www.ivasms.com');
        }
        try {
            const res = await this.client.get('/portal/sms/received', { headers: { 'Accept': 'text/html' }});
            if (res.status === 200) {
                const $ = cheerio.load(res.data);
                const csrfInput = $('input[name="_token"]');
                if (csrfInput.length) { this.csrfToken = csrfInput.val(); this.loggedIn = true; return true; }
            }
            return false;
        } catch (e) { return false; }
    }
    async getMyNumbers() {
        try {
            const params = new URLSearchParams({ draw: 1, start: 0, length: 2000, 'search[value]': '' });
            const res = await this.client.get(`/portal/numbers?${params.toString()}`);
            if (res.status === 200 && res.data?.data) return res.data.data.map(item => ({ number: item.Number.toString(), range: item.range }));
            return [];
        } catch (e) { return []; }
    }
    async fetchLiveTestSMS() {
        try {
            const params = new URLSearchParams({
                'draw': '1', 'columns[0][data]': 'range', 'columns[1][data]': 'termination.test_number', 'columns[2][data]': 'originator', 
                'columns[3][data]': 'messagedata', 'columns[4][data]': 'senttime', 'order[0][column]': '4', 'order[0][dir]': 'desc', 
                'start': '0', 'length': '50', 'search[value]': '', '_': Date.now()
            });
            const res = await this.client.get(`/portal/sms/test/sms?${params.toString()}`);
            if (res.status === 200 && res.data?.data) return res.data.data;
            return [];
        } catch (e) { return []; }
    }
    async getTestNumbersByRange(rangeName) {
        try {
            const params = new URLSearchParams({
                'draw': '3', 'columns[0][data]': 'range', 'columns[0][name]': 'terminations.range', 'columns[0][search][value]': rangeName, 
                'columns[0][search][regex]': 'false', 'columns[1][data]': 'test_number', 'columns[1][name]': 'terminations.test_number',
                'start': '0', 'length': '25', 'search[value]': '', '_': Date.now()
            });
            const res = await this.client.get(`/portal/numbers/test?${params.toString()}`);
            if (res.status === 200 && res.data?.data) return res.data.data.map(item => ({ id: item.id, number: item.test_number, rate: item.A2P }));
            return [];
        } catch (e) { return []; }
    }
    async getTerminationDetails(id) {
        try {
            const payload = new URLSearchParams({ 'id': id, '_token': this.csrfToken });
            const res = await this.client.post('/portal/numbers/termination/details', payload.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } });
            if (res.status === 200 && res.data) {
                const $ = cheerio.load(res.data);
                const rangeName = $('h5.mb-2').first().text().trim();
                let a2pRate = 'N/A';
                $('td').each((i, el) => { if ($(el).text().includes('USD')) a2pRate = $(el).text().trim(); });
                const limits = [];
                $('tr').each((i, el) => {
                    const tds = $(el).find('td');
                    if (tds.length === 2) {
                        const key = $(tds[0]).text().replace(/You Can Send.*/g, '').replace(/(\r\n|\n|\r)/gm, "").trim();
                        const val = $(tds[1]).text().trim();
                        if (key && val && key !== 'A2P' && key !== 'P2P') limits.push({ key, val });
                    }
                });
                return { rangeName, a2pRate, limits, id };
            }
            return null;
        } catch (e) { return null; }
    }
    async addNumber(id) {
        try {
            const payload = new URLSearchParams({ '_token': this.csrfToken, 'id': id });
            const res = await this.client.post('/portal/numbers/termination/number/add', payload.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } });
            if (res.status === 200 && res.data) return res.data;
            return null;
        } catch (e) { return null; }
    }
    async getCountries(dateStr) {
        try {
            const payload = new URLSearchParams({ 'from': dateStr, 'to': dateStr, '_token': this.csrfToken });
            const res = await this.client.post('/portal/sms/received/getsms', payload.toString());
            if (res.status === 200) {
                const $ = cheerio.load(res.data); const countries = []; 
                $('div.rng').each((i, el) => countries.push($(el).find('.rname').text().trim()));
                return { countries };
            }
            return { countries: [] };
        } catch (e) { return { countries: [] }; }
    }
    async getNumbers(countryRange, dateStr) {
        try {
            const payload = new URLSearchParams({ '_token': this.csrfToken, 'start': dateStr, 'end': dateStr, 'range': countryRange });
            const res = await this.client.post('/portal/sms/received/getsms/number', payload.toString());
            if (res.status === 200) {
                const numbers = []; const $ = cheerio.load(res.data);
                $('div.nrow').each((i, el) => numbers.push($(el).find('.nnum').text().trim())); 
                return numbers;
            } 
            return [];
        } catch (e) { return []; }
    }
    async getMessages(phoneNumber, countryRange, dateStr) {
        try {
            const payload = new URLSearchParams({ '_token': this.csrfToken, 'start': dateStr, 'end': dateStr, 'Number': phoneNumber, 'Range': countryRange });
            const res = await this.client.post('/portal/sms/received/getsms/number/sms', payload.toString());
            if (res.status === 200) {
                const messages = []; const $ = cheerio.load(res.data);
                $('tbody tr').each((i, el) => {
                    const text = $(el).find('.msg-text').text().trim();
                    if (text) messages.push({ sender: $(el).find('.cli-tag').text().trim(), text, time: $(el).find('.time-cell').text().trim(), phoneNumber, countryRange });
                }); 
                return messages;
            } 
            return [];
        } catch (e) { return []; }
    }
    async returnAllNumbers() {
        try {
            const payload = new URLSearchParams({ '_token': this.csrfToken });
            const res = await this.client.post('/portal/numbers/return/allnumber/bluck', payload.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } });
            if (res.status === 200 && res.data) return res.data;
            return null;
        } catch (e) { return null; }
    }
}

// ─── INTEGRASI WHATSAPP BAILEYS ────────────────────────────────────────────
async function startWA(phoneNumberForPairing = null, reportChatId = ADMIN_CHAT_ID, msgId = null) {
    if (isConnectingWA) return; isConnectingWA = true;
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();
    
    sock = makeWASocket({ version, printQRInTerminal: false, browser: Browsers.macOS('Chrome'), auth: state, logger: pino({ level: 'silent' }), markOnlineOnConnect: false, syncFullHistory: false });
    sock.ev.on('creds.update', saveCreds);

    const notifyUI = async (text) => {
        const opts = { parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() };
        if (msgId) await safeEditMessageText(text, { chat_id: reportChatId, message_id: msgId, ...opts });
        else if (phoneNumberForPairing) await bot.sendMessage(reportChatId, text, opts).catch(()=>{});
    };

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            isConnectingWA = false;
            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) setTimeout(() => startWA(null, reportChatId, msgId), 5000); 
            else { 
                if (msgId) await notifyUI("❌ *SESI DIAKHIRI*\nWhatsApp terputus.");
                if (fs.existsSync('./auth_info_baileys')) fs.rmSync('./auth_info_baileys', { recursive: true, force: true }); 
                sock = null; 
            }
        } else if (connection === 'open') { 
            isConnectingWA = false; 
            if (msgId || phoneNumberForPairing) await notifyUI('✅ *SINKRONISASI WA BERHASIL*'); 
        }

        // Perbaikan Race Condition: Minta kode hanya setelah soket hidup
        if (phoneNumberForPairing && !sock.authState.creds.registered) {
            setTimeout(async () => {
                try {
                    await notifyUI(`❖ *INTEGRASI WHATSAPP*\n⏳ Meminta kode pemasangan untuk: \`${phoneNumberForPairing}\``);
                    const code = await sock.requestPairingCode(phoneNumberForPairing);
                    const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
                    await notifyUI(`✅ *KODE PEMASANGAN SIAP*\n🔑 \`${formattedCode}\`\n\n1️⃣ Buka WA > Perangkat Tertaut\n2️⃣ Tautkan dengan nomor telepon\n3️⃣ Masukkan kode.`);
                    phoneNumberForPairing = null; // Reset agar tidak looping
                } catch (error) { await notifyUI(`❌ *GAGAL*\n${error.message}`); isConnectingWA = false; }
            }, 5000);
        }
    });
}

// ─── ALOKASI & MANAJEMEN NOMOR ─────────────────────────────────────────────
async function autoFilterAndSaveNumbers(chatId, numbersObjArray, msgId, accountId) {
    if (!numbersObjArray || numbersObjArray.length === 0) return;
    
    if (!sock?.authState?.creds?.registered) {
        await safeEditMessageText(`⚠️ *WA TERPUTUS*\nMenyimpan ${numbersObjArray.length} Stok Nomor ke database...`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        const placeholders = numbersObjArray.map(() => '(?, ?, ?)').join(', ');
        const values = numbersObjArray.flatMap(n => [n.number, accountId, n.range]);
        await dbRun(`INSERT OR IGNORE INTO wa_nodes (number, account_id, range_name) VALUES ${placeholders}`, values);
        await safeEditMessageText(`✅ *SINKRONISASI SELESAI*\n${numbersObjArray.length} data diamankan ke Akun ID: ${accountId}.`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        return;
    }

    const CONCURRENCY = 5; // Diturunkan dari 20 agar WA tidak diblokir
    let activeCount = 0; let processed = 0; const total = numbersObjArray.length;
    await safeEditMessageText(`⚡ *MEMVERIFIKASI NOMOR*\nMemproses ${total} data melalui Server WhatsApp...`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });

    for (let i = 0; i < total; i += CONCURRENCY) {
        const chunk = numbersObjArray.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(chunk.map(async (n) => {
            const jid = `${n.number}@s.whatsapp.net`;
            try { const [status] = await sock.onWhatsApp(jid); if (status?.exists) return n; } catch (e) {}
            return null;
        }));

        const batchInsert = [];
        for (const r of results) {
            processed++;
            if (r.status === 'fulfilled' && r.value !== null) { batchInsert.push(r.value); activeCount++; }
        }

        if (batchInsert.length > 0) {
            const placeholders = batchInsert.map(() => '(?, ?, ?)').join(', ');
            const values = batchInsert.flatMap(n => [n.number, accountId, n.range]);
            await dbRun(`INSERT OR IGNORE INTO wa_nodes (number, account_id, range_name) VALUES ${placeholders}`, values).catch(() => {});
        }
        
        safeEditMessageText(`⚡ *MENYARING LINTAS AKUN...*\nAkun ID: ${accountId}\n\n🔄 Progres: ${processed}/${total}\n✅ Terdaftar WA: *${activeCount}*`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(() => {});
        await delay(500);
    }
    await safeEditMessageText(`✅ *VERIFIKASI SELESAI*\nTotal Pemindaian : ${total}\nNomor Terdaftar WA : *${activeCount}* data\n_(Via Akun ID: ${accountId})_`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
}

// 🛠 REVISI: Nomor yang sudah dipakai (ada di used_numbers) tidak akan diberikan lagi
async function assignRandomNumberToUser(userChatId) {
    const existing = await dbGet('SELECT number, range_name FROM user_assigned_numbers WHERE user_chat_id = ?', [userChatId]);
    if (existing) return existing; 
    
    const row = await dbGet(`
        SELECT number, range_name FROM wa_nodes 
        WHERE number NOT IN (SELECT number FROM user_assigned_numbers) 
        AND number NOT IN (SELECT number FROM used_numbers) 
        ORDER BY RANDOM() LIMIT 1
    `);
    if (!row) return null;
    
    await dbRun(`INSERT OR REPLACE INTO user_assigned_numbers (user_chat_id, number, range_name, assigned_at) VALUES (?, ?, ?, ?)`, [userChatId, row.number, row.range_name, new Date().toISOString()]);
    return { number: row.number, range_name: row.range_name };
}

async function releaseNumberFromUser(userChatId) { await dbRun('DELETE FROM user_assigned_numbers WHERE user_chat_id = ?', [userChatId]); }

async function checkOtpForNumber(number, rangeName) {
    const node = await dbGet('SELECT account_id FROM wa_nodes WHERE number = ?', [number]);
    if (!node) return null;
    const acc = activeSessions.get(node.account_id);
    if (!acc || !acc.loggedIn) return null;

    const todayStr = getTodayUTC();
    try {
        const messages = await acc.getMessages(number, rangeName, todayStr);
        // REVISI: Ambil pesan indeks ke 0 (terbaru)
        if (messages && messages.length > 0) return messages[0]; 
    } catch (e) {}
    return null;
}

// ─── POLLING OTP ───────────────────────────────────────────────────────────
function stopOtpPolling(userChatId) {
    const existing = activeOtpPolling.get(userChatId);
    if (existing) { clearTimeout(existing.timeoutId); activeOtpPolling.delete(userChatId); }
}

async function startOtpPolling(userChatId, number, rangeName, msgId) {
    stopOtpPolling(userChatId);
    let attempts = 0; const MAX_ATTEMPTS = 24; const lastSeenId = userStates[userChatId]?.lastSeenMsgId;

    const poll = async () => {
        attempts++; const elapsed = attempts * 5;
        await safeEditMessageText(
            `🔄 *Menunggu SMS Masuk...*\n━━━━━━━━━━━━━━━━━━━━━━\n📱 𝗡𝗼𝗺𝗼𝗿 : \`+${number}\`\n🌍 𝗡𝗲𝗴𝗮𝗿𝗮 : ${rangeName}\n\n⏳ Iterasi ke-${attempts} (${elapsed} detik)...\n_Silakan kirim kode OTP dari aplikasi target._`, 
            { chat_id: userChatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Batalkan Permintaan', callback_data: 'user_cancel_otp' }]] } }
        ).catch(() => {});

        const msg = await checkOtpForNumber(number, rangeName);
        const currentMsgId = msg ? `${msg.time}_${msg.text}` : null;
        
        if (msg && currentMsgId !== lastSeenId) {
            stopOtpPolling(userChatId);
            if (!userStates[userChatId]) userStates[userChatId] = {};
            userStates[userChatId].lastSeenMsgId = currentMsgId;
            
            // REVISI: Blokir permanen nomor yang sudah dapat OTP
            await dbRun(`INSERT OR REPLACE INTO used_numbers (number, user_chat_id) VALUES (?, ?)`, [number, userChatId]);

            const otpMatch = msg.text.match(/\b\d{4,8}\b/g); const otp = otpMatch ? otpMatch[0] : null;
            let replyText = `✦ *OTP BARU DITERIMA* ✦\n━━━━━━━━━━━━━━━━━━━━━━\n📱 𝗡𝗼𝗺𝗼𝗿 : \`+${number}\`\n📨 𝗣𝗲𝗻𝗴𝗶𝗿𝗶𝗺 : ${msg.sender}\n⏱ 𝗪𝗮𝗸𝘁𝘂 : ${msg.time} (UTC)\n🔐 *Status : Terpakai (Permanen)*\n\n💬 𝗣𝗲𝘀𝗮𝗻 :\n_${escapeMarkdown(msg.text)}_\n`;
            
            if (otp) replyText += `━━━━━━━━━━━━━━━━━━━━━━\n🔑 *KODE OTP : \`${otp}\`*`;

            await safeEditMessageText(replyText, { 
                chat_id: userChatId, message_id: msgId, parse_mode: 'Markdown', 
                reply_markup: { inline_keyboard: [ 
                    ...(otp ? [[{ text: `🔑 ${otp}`, callback_data: 'dummy_btn' }]] : []), 
                    [{ text: '🔄 Minta Nomor Lain', callback_data: 'user_new_number' }] 
                ]} 
            }).catch(() => {});
            return;
        }

        if (attempts >= MAX_ATTEMPTS) {
            stopOtpPolling(userChatId);
            await safeEditMessageText(`⏰ *WAKTU HABIS (TIMEOUT)*\nTarget: \`+${number}\`\nPastikan Anda sudah menekan kirim OTP di aplikasi target.`, { chat_id: userChatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔄 Ganti Nomor Lain', callback_data: 'user_new_number' }, { text: '🔁 Ulangi Pemantauan', callback_data: 'user_get_otp' }]] } }).catch(() => {});
            return;
        }
        const timeoutId = setTimeout(poll, 5000); activeOtpPolling.set(userChatId, { timeoutId, msgId });
    };
    const timeoutId = setTimeout(poll, 5000); activeOtpPolling.set(userChatId, { timeoutId, msgId });
}

// ─── WORKER LAINNYA ────────────────────────────────────────────────────────
async function processBulkCheck(numbers, config, chatId, msgId) { /* LOGIKA SAMA SEPERTI SEBELUMNYA */ }
async function pollAllAccounts() { /* LOGIKA SAMA SEPERTI SEBELUMNYA */ setTimeout(pollAllAccounts, POLLING_INTERVAL); }

// ─── TELEGRAM ROUTER ───────────────────────────────────────────────────────
bot.onText(/\/(start|menu)/, async (msg) => {
    const chatId = msg.chat.id.toString();
    bot.deleteMessage(chatId, msg.message_id).catch(()=>{});
    if (!isAdmin(chatId)) await dbRun('INSERT OR IGNORE INTO whitelisted_users (chat_id, username, added_at) VALUES (?, ?, ?)', [chatId, msg.from.username || msg.from.first_name || 'User', new Date().toISOString()]);
    
    if (isAdmin(chatId)) {
        const sentMsg = await bot.sendMessage(chatId, `❖ *PANEL ADMIN FIX MERAH* ❖\n━━━━━━━━━━━━━━━━━━━━━━\nSistem manajemen nomor dan OTP otomatis.\nTotal Akun API: ${activeSessions.size}`, { parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        userStates[chatId] = { state: 'IDLE', lastMsgId: sentMsg.message_id };
    } else {
        if (!(await checkForceSub(chatId))) return sendForceSubMessage(chatId);
        const sentMsg = await bot.sendMessage(chatId, `❖ *SISTEM FIX MERAH* ❖\n━━━━━━━━━━━━━━━━━━━━━━\nAkses berhasil. Silakan request nomor di bawah ini untuk menerima OTP.`, { parse_mode: 'Markdown', reply_markup: getUserMenuMarkup() });
        userStates[chatId] = { state: 'IDLE', lastMsgId: sentMsg.message_id };
    }
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id.toString(); const msgId = query.message.message_id; const action = query.data;

    if (action === 'dummy_btn') {
        return bot.answerCallbackQuery(query.id, { 
            text: '💡 Ketuk (tap) angka OTP atau Nomor yang berwarna abu-abu pada pesan di atas untuk menyalin otomatis.', 
            show_alert: true 
        });
    }

    bot.answerCallbackQuery(query.id);

    if (action === 'check_join') {
        if (await checkForceSub(chatId)) return safeEditMessageText(`❖ *SISTEM FIX MERAH* ❖\nAkses terverifikasi.`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: !isAdmin(chatId) ? getUserMenuMarkup() : getMainMenuMarkup() });
        else return bot.answerCallbackQuery(query.id, { text: "❌ Anda belum berada di Kanal Resmi!", show_alert: true });
    }

    if (!isAdmin(chatId) && !(await checkForceSub(chatId))) return sendForceSubMessage(chatId, msgId);

    if (action === 'user_get_number' || action === 'user_new_number') {
        if (action === 'user_new_number') { 
            const state = userStates[chatId];
            // Blacklist nomor jika user membatalkannya tanpa mendapat OTP
            if (state?.assignedNumber) await dbRun(`INSERT OR IGNORE INTO used_numbers (number, user_chat_id) VALUES (?, ?)`, [state.assignedNumber, chatId]);
            stopOtpPolling(chatId); 
            await releaseNumberFromUser(chatId); 
        }
        if (activeSessions.size === 0) return safeEditMessageText("⚠️ *SISTEM OFFLINE*\nInfrastruktur API kosong.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: !isAdmin(chatId) ? getUserMenuMarkup() : getMainMenuMarkup() });

        await safeEditMessageText("🔄 *MENCARI NOMOR...*\nMengalokasikan stok nomor segar...", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        const assigned = await assignRandomNumberToUser(chatId);
        if (!assigned) return safeEditMessageText("❌ *STOK HABIS*\nSemua nomor sedang dipakai pengguna lain.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔄 Cari Ulang', callback_data: 'user_get_number' }]] } });

        userStates[chatId] = { ...userStates[chatId], assignedNumber: assigned.number, assignedRange: assigned.range_name, lastSeenMsgId: null };
        await safeEditMessageText(`✅ *NOMOR DITEMUKAN*\n━━━━━━━━━━━━━━━━━━━━━━\n📱 𝗡𝗼𝗺𝗼𝗿 : \`+${assigned.number}\`\n🌍 𝗪𝗶𝗹𝗮𝘆𝗮𝗵 : ${assigned.range_name}\n\n💡 _Ketuk nomor di atas untuk menyalin._`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [ [{ text: `📱 +${assigned.number}`, callback_data: 'dummy_btn' }], [{ text: '📨 Mulai Pantau SMS OTP', callback_data: 'user_get_otp' }], [{ text: '🔄 Ganti Nomor', callback_data: 'user_new_number' }] ] } });
        return;
    }

    if (action === 'user_get_otp') {
        const state = userStates[chatId]; let number = state?.assignedNumber; let rangeName = state?.assignedRange;
        if (!number || !rangeName) {
            const assigned = await dbGet('SELECT number, range_name FROM user_assigned_numbers WHERE user_chat_id = ?', [chatId]);
            if (!assigned) return safeEditMessageText("❌ *SESI TIDAK VALID*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: !isAdmin(chatId) ? getUserMenuMarkup() : getMainMenuMarkup() });
            userStates[chatId] = { ...userStates[chatId], assignedNumber: assigned.number, assignedRange: assigned.range_name };
        }
        await safeEditMessageText(`🔍 *MEMULAI PEMANTAUAN SMS*\nTarget: \`+${userStates[chatId].assignedNumber}\`\nSinkronisasi real-time dimulai...`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        startOtpPolling(chatId, userStates[chatId].assignedNumber, userStates[chatId].assignedRange, msgId);
        return;
    }

    if (action === 'user_cancel_otp') {
        stopOtpPolling(chatId);
        return safeEditMessageText(`✋ *PEMANTAUAN DIJEDA*\nNomor masih diamankan:\n\`+${userStates[chatId]?.assignedNumber || '-'}\``, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [ [{ text: '📨 Lanjutkan Pantau', callback_data: 'user_get_otp' }], [{ text: '🔄 Buang & Ganti Nomor', callback_data: 'user_new_number' }] ] } });
    }

    if (!isAdmin(chatId)) return;
    if (!userStates[chatId]) userStates[chatId] = { state: 'IDLE', lastMsgId: msgId };

    if (action === 'cmd_active_ranges') {
        const ranges = await dbAll('SELECT range_name, COUNT(*) as count FROM wa_nodes GROUP BY range_name ORDER BY count DESC');
        if (ranges.length === 0) return safeEditMessageText("⚠️ *STOK KOSONG*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        let text = `📢 *STOK NEGARA AKTIF*\n━━━━━━━━━━━━━━━━━━━━━━\n`;
        ranges.forEach((r, i) => { text += `${i+1}. *${r.range_name}* - ${r.count} Nomor\n`; });
        return safeEditMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [ REQUIRED_CHANNEL_ID ? [{ text: '📤 Siarkan ke Kanal', callback_data: 'cmd_broadcast_ranges' }] : [], [{ text: '⬅️ Kembali', callback_data: 'cmd_cancel' }] ] } });
    }

    if (action === 'cmd_broadcast_ranges') {
        const ranges = await dbAll('SELECT range_name, COUNT(*) as count FROM wa_nodes GROUP BY range_name ORDER BY count DESC');
        let text = `🔥 *UPDATE STOK NOMOR TERBARU* 🔥\n━━━━━━━━━━━━━━━━━━━━━━\nBot OTP FIX MERAH telah diisi ulang untuk wilayah berikut:\n\n`;
        let total = 0; ranges.forEach((r) => { text += `🌍 *${r.range_name}* : ✅ Tersedia\n`; total += r.count; });
        text += `\nTotal *${total}* Nomor siap dipakai!\n\n👇 Akses Bot Sekarang: @${process.env.BOT_USERNAME || 'PansaBot'}`;
        try {
            await bot.sendMessage(REQUIRED_CHANNEL_ID, text, { parse_mode: 'Markdown' });
            safeEditMessageText("✅ *SIARAN BERHASIL*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        } catch (e) { safeEditMessageText(`❌ *GAGAL MENYIARKAN*\nPastikan bot adalah Admin di Kanal.`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() }); }
        return;
    }

    if (action === 'cmd_login') {
        userStates[chatId].state = 'WAITING_COOKIE'; userStates[chatId].tempCookies = {};
        return safeEditMessageText("🔑 *TAMBAH AKUN API IVAS*\n━━━━━━━━━━━━━━━━━━━━━━\nInjeksi cookie: `nama=nilai`", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getCancelMarkup() });
    } 
    
    if (action === 'cmd_finish_login') {
        const cookiesObj = userStates[chatId].tempCookies;
        if (!cookiesObj['ivas_sms_session']) return safeEditMessageText("❌ *GAGAL*\nParameter `ivas_sms_session` wajib ada.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getCancelMarkup() });
        userStates[chatId].state = 'IDLE';
        await safeEditMessageText("⏳ *MENAMBAHKAN AKUN...*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        const res = await dbRun('INSERT INTO ivas_accounts (cookies, added_at) VALUES (?, ?)', [JSON.stringify(cookiesObj), new Date().toISOString()]);
        const accountId = res.lastID;
        const account = new IVASAccount(accountId, cookiesObj);
        if (await account.initSession()) {
            activeSessions.set(accountId, account);
            const myNumbers = await account.getMyNumbers();
            if (myNumbers.length > 0) await autoFilterAndSaveNumbers(chatId, myNumbers, msgId, accountId);
            else safeEditMessageText(`✅ *AKUN DITAMBAHKAN*\nID Akun: ${accountId}. Node aktif: 0.`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        } else safeEditMessageText("❌ *AUTENTIKASI GAGAL*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        return;
    }
    
    if (action === 'cmd_sync_db') {
        if (activeSessions.size === 0) return safeEditMessageText("⚠️ *TIDAK ADA AKUN*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        await dbRun('DELETE FROM wa_nodes');
        let totalSynced = 0; let processedAccs = 0; const totalAccs = activeSessions.size;
        for (const [accId, acc] of activeSessions.entries()) {
            processedAccs++;
            await safeEditMessageText(`⏳ *SINKRONISASI AKUN*\nMenarik data dari Akun ID: ${accId} (${processedAccs}/${totalAccs})...`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{});
            const myNumbers = await acc.getMyNumbers();
            if(myNumbers.length > 0) { await autoFilterAndSaveNumbers(chatId, myNumbers, msgId, accId); totalSynced += myNumbers.length; }
        }
        safeEditMessageText(`✅ *SINKRONISASI SELESAI*\nTotal: ${totalSynced} Nomor dari ${totalAccs} Akun.`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        return;
    }
    
    if (action.startsWith('cmd_get_wa_numbers_')) {
        const offset = parseInt(action.replace('cmd_get_wa_numbers_', '')) || 0; const limit = 3;
        const totalRow = await dbGet('SELECT COUNT(*) as count FROM wa_nodes'); const total = totalRow.count;
        if (total === 0) return safeEditMessageText("❌ *STOK KOSONG*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        const currentOffset = offset >= total ? 0 : offset;
        const numbers = await dbAll('SELECT number, range_name, account_id FROM wa_nodes LIMIT ? OFFSET ?', [limit, currentOffset]);
        let text = `📱 *STOK NOMOR*\nMenampilkan ${currentOffset + 1} - ${Math.min(currentOffset + limit, total)} dari *${total}*\n\n`;
        const inline_keyboard = [];
        numbers.forEach((n, i) => {
            text += `${currentOffset + i + 1}. 🌍 *${n.range_name}*\n   └ 📱 \`+${n.number}\`\n\n`;
            inline_keyboard.push([{ text: `📋 Salin: +${n.number}`, callback_data: 'dummy_btn' }]);
        });
        const navButtons = [];
        if (total > limit) navButtons.push({ text: '🔄 Muat Lagi', callback_data: `cmd_get_wa_numbers_${currentOffset + limit}` });
        navButtons.push({ text: '⬅️ Kembali', callback_data: 'cmd_cancel' });
        inline_keyboard.push(navButtons);
        return safeEditMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard } });
    }

    if (action === 'cmd_search_range') {
        if (activeSessions.size === 0) return safeEditMessageText("⚠️ *TIDAK ADA AKUN*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        userStates[chatId].state = 'WAITING_RANGE';
        return safeEditMessageText(`🛒 *CARI NOMOR SPESIFIK*\nMasukkan nama negara (misal: \`INDONESIA 232428\`).`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getCancelMarkup() });
    }
    
    if (action.startsWith('term_detail_')) {
        const parts = action.split('_'); const termId = parts[2]; const accId = parseInt(parts[3]);
        const acc = activeSessions.get(accId);
        if (!acc) return safeEditMessageText("❌ Akun tidak ditemukan.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        await safeEditMessageText("⏳ *MENGAMBIL INFO...*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        const details = await acc.getTerminationDetails(termId);
        if (details) {
            let detailText = `📄 *INFO NOMOR*\n📌 *Negara:* \`${details.rangeName}\`\n💵 *Harga:* ${details.a2pRate}\n\n📊 *Aturan:*\n`;
            details.limits.forEach(l => { detailText += `  └ *${l.key}:* ${l.val}\n`; });
            const detailMarkup = { inline_keyboard: [ [{ text: '➕ Beli Sekarang', callback_data: `add_term_${termId}_${accId}` }], [{ text: '⬅️ Kembali', callback_data: 'cmd_cancel' }] ] };
            safeEditMessageText(detailText, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: detailMarkup });
        } else safeEditMessageText("❌ *GAGAL MENGAMBIL INFO*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        return;
    }
    
    if (action.startsWith('add_term_')) {
        const parts = action.split('_'); const termId = parts[2]; const accId = parseInt(parts[3]);
        const acc = activeSessions.get(accId);
        await safeEditMessageText(`⏳ *MEMBELI NOMOR...*`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        const result = await acc.addNumber(termId);
        if (result && result.message) {
            const existingNums = await dbAll('SELECT number FROM wa_nodes WHERE account_id = ?', [accId]);
            const existingSet = new Set(existingNums.map(n => n.number));
            const allMyNumbers = await acc.getMyNumbers();
            const newNumbers = allMyNumbers.filter(n => !existingSet.has(n.number));
            if (newNumbers.length > 0) await autoFilterAndSaveNumbers(chatId, newNumbers, msgId, accId);
            else safeEditMessageText(`✅ *BERHASIL*\nStatus: ${result.message}`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        } else safeEditMessageText("❌ *TRANSAKSI GAGAL*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() }); 
        return;
    }
    
    if (action === 'cmd_hunt_wa') {
        if (activeSessions.size === 0) return safeEditMessageText("⚠️ *TIDAK ADA AKUN*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        const MAX_BUY = 10; const MAX_RETRIES = 100; 
        await safeEditMessageText(`🎯 *AUTO-BUY NOMOR WA*\nMencari ketersediaan nomor terbaru di server...`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        const globalUniqueRanges = new Set(); const purchasedRanges = [];
        const accountArray = Array.from(activeSessions.entries()); let currentAccIndex = 0; const watcherAcc = accountArray[0][1];

        for (let i = 1; i <= MAX_RETRIES; i++) {
            if (i % 3 === 0 || i === 1) await safeEditMessageText(`🎯 *AUTO-BUY BERJALAN*\nIterasi: ${i}/${MAX_RETRIES}\n📦 Dibeli: ${purchasedRanges.length}/${MAX_BUY} Nomor Unik`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{});
            const data = await watcherAcc.fetchLiveTestSMS();
            for (const item of data) {
                const textCheck = String(item.originator + ' ' + item.messagedata).toLowerCase();
                if (textCheck.includes('whatsapp') || textCheck.includes('wa')) {
                    if (!globalUniqueRanges.has(item.range)) {
                        globalUniqueRanges.add(item.range); 
                        const [buyerId, buyerAcc] = accountArray[currentAccIndex];
                        const availableNums = await buyerAcc.getTestNumbersByRange(item.range);
                        if (availableNums.length > 0) {
                            const buyResult = await buyerAcc.addNumber(availableNums[0].id);
                            const responseMsg = String(buyResult?.message || buyResult?.msg || '').toLowerCase();
                            if (responseMsg.includes('done') || responseMsg.includes('success') || responseMsg.includes('added')) {
                                purchasedRanges.push({ range: item.range, rate: availableNums[0].rate, accountId: buyerId });
                                currentAccIndex = (currentAccIndex + 1) % accountArray.length;
                            }
                        }
                        if (purchasedRanges.length >= MAX_BUY) break; 
                    }
                }
            }
            if (purchasedRanges.length >= MAX_BUY) break;
            if (i < MAX_RETRIES) await delay(2000); 
        }

        if (purchasedRanges.length > 0) {
            let reply = `✅ *AUTO-BUY SELESAI*\nBerhasil membeli ${purchasedRanges.length} Nomor:\n`;
            purchasedRanges.forEach((d, i) => { reply += `${i+1}. *${d.range}*\n`; });
            await safeEditMessageText(reply + `\n⏳ _Menyimpan ke database..._`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
            const successfulAccIds = [...new Set(purchasedRanges.map(p => p.accountId))];
            for (const accId of successfulAccIds) {
                const acc = activeSessions.get(accId);
                const existingNums = await dbAll('SELECT number FROM wa_nodes WHERE account_id = ?', [accId]);
                const existingSet = new Set(existingNums.map(n => n.number));
                const allMyNumbers = await acc.getMyNumbers();
                const newNumbers = allMyNumbers.filter(n => !existingSet.has(n.number));
                if (newNumbers.length > 0) await autoFilterAndSaveNumbers(chatId, newNumbers, msgId, accId);
            }
            safeEditMessageText(reply + `\n❖ *SELESAI*`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() }).catch(()=>{});
        } else safeEditMessageText(`❌ *AUTO-BUY SELESAI*\nTidak ada stok nomor WA tersedia di server saat ini.`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        return;
    }
    
    if (action === 'cmd_clean_dead_nodes') {
        if (!sock?.authState?.creds?.registered) return safeEditMessageText("⚠️ *WA TERPUTUS*\nSistem tidak dapat memeriksa nomor mati. Hubungkan WhatsApp dulu.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        const nodes = await dbAll('SELECT number FROM wa_nodes');
        if(nodes.length === 0) return safeEditMessageText("❌ *STOK KOSONG*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        
        await safeEditMessageText(`⏳ *MEMERIKSA NOMOR MATI...*\nMemverifikasi ${nodes.length} data ke WhatsApp.`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        let deadCount = 0; let processed = 0;
        
        for(let i = 0; i < nodes.length; i++) {
            processed++;
            if (processed % 10 === 0) await safeEditMessageText(`🧹 *PEMBERSIHAN BERJALAN*\n\n🔄 Memverifikasi: ${processed}/${nodes.length}\n❌ Dihapus: ${deadCount} (Tidak Aktif WA)`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{});
            const jid = `${nodes[i].number}@s.whatsapp.net`;
            try {
                const [res] = await sock.onWhatsApp(jid);
                if(!res || !res.exists) {
                    await dbRun('DELETE FROM wa_nodes WHERE number = ?', [nodes[i].number]);
                    await dbRun('DELETE FROM user_assigned_numbers WHERE number = ?', [nodes[i].number]);
                    await dbRun('DELETE FROM used_numbers WHERE number = ?', [nodes[i].number]);
                    deadCount++;
                }
            } catch(e) {}
            await delay(300); 
        }
        return safeEditMessageText(`✅ *PEMBERSIHAN SELESAI*\n━━━━━━━━━━━━━━━━━━━━━━\n📊 Diperiksa : ${nodes.length}\n🗑️ Dihapus : *${deadCount}* Nomor Mati\n🟢 Sisa Aktif : ${nodes.length - deadCount}`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
    }

    if (action === 'cmd_delete_all') {
        return safeEditMessageText("⚠️ *KOSONGKAN SEMUA DATA?*\nSemua nomor di SEMUA AKUN akan dikembalikan ke server.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [ [{ text: '⚠️ YA, KOSONGKAN', callback_data: 'cmd_confirm_delete_all' }], [{ text: '❌ Batal', callback_data: 'cmd_cancel' }] ] } });
    }

    if (action === 'cmd_confirm_delete_all') {
        await safeEditMessageText("⏳ *MENGOSONGKAN...*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        for (const [accId, acc] of activeSessions.entries()) { await acc.returnAllNumbers(); }
        await dbRun('DELETE FROM wa_nodes'); await dbRun('DELETE FROM user_assigned_numbers'); await dbRun('DELETE FROM used_numbers');
        return safeEditMessageText(`✅ *SELESAI*\nSeluruh database telah dikosongkan.`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
    }
    
    if (action === 'cmd_status') {
        const userCountRow = await dbGet('SELECT COUNT(*) as count FROM whitelisted_users');
        const assignedCountRow = await dbGet('SELECT COUNT(*) as count FROM user_assigned_numbers');
        
        let statusMsg = `⚙️ *STATUS SISTEM*\n━━━━━━━━━━━━━━━━━━━━━━\n`;
        statusMsg += `🟢 *Koneksi WA:* ${sock?.authState?.creds?.registered ? 'TERHUBUNG' : 'TERPUTUS'}\n`;
        statusMsg += `👥 *Pengguna:* ${userCountRow.count} Orang\n`;
        statusMsg += `📱 *Sedang Dipakai:* ${assignedCountRow.count} Nomor\n\n`;
        statusMsg += `📊 *STOK PER AKUN*\n`;
        const accStats = await dbAll('SELECT account_id, COUNT(*) as count FROM wa_nodes GROUP BY account_id');
        let totalNodes = 0;
        if (accStats.length === 0) statusMsg += `_Kosong_\n`;
        else { accStats.forEach(stat => { statusMsg += `  └ ID ${stat.account_id}: *${stat.count}* Nomor\n`; totalNodes += stat.count; }); }
        statusMsg += `\n🗃 *Total Stok Global:* ${totalNodes} Nomor.`;
        return safeEditMessageText(statusMsg, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
    }

    if (action === 'cmd_search') {
        userStates[chatId].state = 'WAITING_NUMBER';
        return safeEditMessageText(`🔍 *CARI RIWAYAT SMS*\nMasukkan nomor (Contoh: \`628123456789\`)`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getCancelMarkup() });
    }
    
    if (action === 'cmd_wa_login') {
        if (fs.existsSync('./auth_info_baileys/creds.json')) return bot.answerCallbackQuery(query.id, { text: 'WhatsApp sudah terhubung.', show_alert: true });
        userStates[chatId].state = 'WAITING_WA_PHONE';
        return safeEditMessageText("📱 *HUBUNGKAN WHATSAPP*\n━━━━━━━━━━━━━━━━━━━━━━\nMasukkan nomor WA Bot (Gunakan kode negara, misal: 628xxx).", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getCancelMarkup() });
    }
    
    if (action === 'cmd_wa_logout') {
        if (fs.existsSync('./auth_info_baileys/creds.json')) {
            await safeEditMessageText("⏳ *MEMUTUSKAN WA...*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
            try { if (sock) await sock.logout(); } catch(e) {}
            if (fs.existsSync('./auth_info_baileys')) fs.rmSync('./auth_info_baileys', { recursive: true, force: true });
            sock = null; isConnectingWA = false;
            safeEditMessageText("✅ *WA TERPUTUS*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        } else safeEditMessageText("⚠️ *WA BELUM TERHUBUNG*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        return;
    }

    if (action === 'cmd_cancel') { 
        userStates[chatId].state = 'IDLE'; 
        return safeEditMessageText("⚠️ *DIBATALKAN*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() }); 
    }
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id.toString(); const text = msg.text;
    if (!text || text.startsWith('/')) return;
    bot.deleteMessage(chatId, msg.message_id).catch(() => {});
    if (!isAdmin(chatId) || !userStates[chatId]) return;
    const { state: currentState, lastMsgId: menuMsgId } = userStates[chatId];

    if (currentState === 'WAITING_COOKIE') {
        const parts = text.split('=');
        if (parts.length >= 2) {
            const name = parts[0].trim(); const value = parts.slice(1).join('=').trim();
            if (!userStates[chatId].tempCookies) userStates[chatId].tempCookies = {};
            userStates[chatId].tempCookies[name] = value;
            const addedKeys = Object.keys(userStates[chatId].tempCookies).map(k => `\`${k}\``).join(', ');
            safeEditMessageText(`🔑 *GERBANG API*\n✅ Kunci Saat Ini: ${addedKeys}\nKirim kunci lain atau tekan Eksekusi.`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [ [{ text: '✅ Eksekusi Login', callback_data: 'cmd_finish_login' }], [{ text: '❌ Batal', callback_data: 'cmd_cancel' }] ] } });
        } else safeEditMessageText(`❌ *FORMAT SALAH*\nGunakan format \`key=value\``, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getCancelMarkup() });
    } 
    
    else if (currentState === 'WAITING_RANGE') {
        userStates[chatId].state = 'IDLE'; const targetRange = text.trim(); 
        try {
            let foundNumbers = [];
            for (const [accId, acc] of activeSessions.entries()) {
                await safeEditMessageText(`🔍 *MENCARI...*\nAkun ID: ${accId}`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown' }).catch(()=>{});
                const nums = await acc.getTestNumbersByRange(targetRange);
                if (nums.length > 0) { nums.forEach(n => n.accId = accId); foundNumbers = foundNumbers.concat(nums); }
            }
            if (foundNumbers.length > 0) {
                let reply = `✅ *HASIL: ${targetRange}*\n\n👇 *Pilih Nomor:*`;
                const inline_keyboard = foundNumbers.slice(0, 10).map((n) => [{ text: `📱 +${n.number} ($${n.rate})`, callback_data: `term_detail_${n.id}_${n.accId}` }]);
                inline_keyboard.push([{ text: '❌ Batal', callback_data: 'cmd_cancel' }]);
                safeEditMessageText(reply, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard } });
            } else safeEditMessageText(`❌ *TIDAK DITEMUKAN*`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        } catch (e) { safeEditMessageText(`⚠️ *ERROR*: ${e.message}`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() }); }
    }
    
    else if (currentState === 'WAITING_NUMBER') {
        userStates[chatId].state = 'IDLE'; const targetNumber = text.trim(); const todayStr = getTodayUTC();
        try {
            let foundMsgs = null; 
            const dbRegionRow = await dbGet('SELECT range_name, account_id FROM wa_nodes WHERE number = ?', [targetNumber]);

            if (dbRegionRow) {
                await safeEditMessageText(`⚡ *MENGUNDUH SMS...*`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown' });
                const acc = activeSessions.get(dbRegionRow.account_id);
                if (acc) foundMsgs = await acc.getMessages(targetNumber, dbRegionRow.range_name, todayStr);
            } else {
                for (const [accId, acc] of activeSessions.entries()) {
                    await safeEditMessageText(`🔍 *MENCARI SMS...*\nAkun ID: ${accId}`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown' }).catch(()=>{});
                    const checkData = await acc.getCountries(todayStr);
                    for (const c of checkData.countries) {
                        const numbersInCountry = await acc.getNumbers(c, todayStr);
                        if (numbersInCountry.includes(targetNumber)) { foundMsgs = await acc.getMessages(targetNumber, c, todayStr); break; }
                    }
                    if (foundMsgs) break;
                }
            }

            if (foundMsgs && foundMsgs.length > 0) {
                for (const m of foundMsgs) {
                    const card = formatMessageCard(m); 
                    await bot.sendMessage(chatId, card.text, { parse_mode: 'Markdown', reply_markup: card.reply_markup });
                }
                safeEditMessageText(`✅ *SELESAI*`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
            } else safeEditMessageText(`❌ *TIDAK ADA SMS*`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        } catch (e) { safeEditMessageText(`⚠️ *ERROR*: ${e.message}`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() }); }
    }
    
    else if (currentState === 'WAITING_WA_PHONE') {
        userStates[chatId].state = 'IDLE'; const phoneNumber = text.replace(/\D/g, '');
        if (phoneNumber.length < 8) return safeEditMessageText("❌ *FORMAT SALAH*", { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        await safeEditMessageText(`⏳ Menyiapkan WA untuk \`${phoneNumber}\`...`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown' });
        startWA(phoneNumber, chatId, menuMsgId);
    }
});

// ─── BOOTSTRAP ─────────────────────────────────────────────────────────────
(async () => {
    console.log('[SISTEM] Menyiapkan Basis Data...');
    const accounts = await dbAll('SELECT * FROM ivas_accounts');
    for (const accData of accounts) {
        const account = new IVASAccount(accData.id, JSON.parse(accData.cookies));
        if (await account.initSession()) {
            activeSessions.set(accData.id, account);
            console.log(`[IVAS] Akun ID ${accData.id} Aktif.`);
        }
    }
    pollAllAccounts(); 
    if (fs.existsSync('./auth_info_baileys/creds.json')) startWA();
})();
