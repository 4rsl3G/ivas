require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const axios = require('axios');
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

const POLLING_INTERVAL = 20000;
const BROADCAST_CHANNEL = process.env.BROADCAST_CHANNEL_ID ? process.env.BROADCAST_CHANNEL_ID.trim() : null;
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
    fast:   { batch: 10, delay: 1000 },
    normal: { batch: 5,  delay: 3000 },
    slow:   { batch: 2,  delay: 6000 }
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

const dbRun = (sql, params = []) => new Promise((res, rej) => sqlDb.run(sql, params, function(err) { if(err) rej(err); else res(this); }));
const dbGet = (sql, params = []) => new Promise((res, rej) => sqlDb.get(sql, params, (err, row) => err ? rej(err) : res(row)));
const dbAll = (sql, params = []) => new Promise((res, rej) => sqlDb.all(sql, params, (err, rows) => err ? rej(err) : res(rows)));

sqlDb.serialize(() => {
    dbRun(`CREATE TABLE IF NOT EXISTS ivas_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, cookies TEXT, label TEXT DEFAULT '', added_at TEXT)`);
    dbRun(`CREATE TABLE IF NOT EXISTS wa_nodes (number TEXT PRIMARY KEY, account_id INTEGER, range_name TEXT)`);
    dbRun(`CREATE TABLE IF NOT EXISTS seen_ids (msg_id TEXT PRIMARY KEY, account_id INTEGER)`);
    dbRun(`CREATE TABLE IF NOT EXISTS whitelisted_users (chat_id TEXT PRIMARY KEY, username TEXT, added_at TEXT)`);
    dbRun(`CREATE TABLE IF NOT EXISTS user_assigned_numbers (user_chat_id TEXT PRIMARY KEY, number TEXT, range_name TEXT, assigned_at TEXT)`);
    dbRun(`CREATE TABLE IF NOT EXISTS used_numbers (number TEXT PRIMARY KEY, user_chat_id TEXT)`);
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function getTodayUTC() { return new Date().toISOString().split('T')[0]; }
function isAdmin(chatId) { return ADMIN_CHAT_ID && chatId.toString() === ADMIN_CHAT_ID; }
const escapeMarkdown = text => String(text).replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');

// ─── SISTEM FORCE SUB ──────────────────────────────────────────────────────
async function checkForceSub(chatId) {
    if (!REQUIRED_CHANNEL_ID || isAdmin(chatId)) return true;
    const now = Date.now();
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
    const text = `🚫 *AKSES DITOLAK*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\nLayanan *Bot OTP* mewajibkan Anda untuk bergabung dengan Kanal Resmi kami terlebih dahulu.\n\n👇 _Silakan bergabung melalui tautan di bawah, lalu klik tombol Verifikasi:_`;
    const markup = {
        inline_keyboard: [
            [{ text: '🔗 Bergabung ke Kanal Resmi', url: REQUIRED_CHANNEL_LINK }],
            [{ text: '✅ Verifikasi Akses Saya', callback_data: 'check_join' }]
        ]
    };
    if (msgId) await safeEditMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: markup });
    else await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: markup });
}

// ─── UI / UX MARKUPS ──────────────────────────────────────────────────────
const getMainMenuMarkup = () => ({
    inline_keyboard: [
        [{ text: '🔑 Kelola Akun API', callback_data: 'cmd_login' }, { text: '🔄 Sinkronisasi API', callback_data: 'cmd_sync_db' }],
        [{ text: '📡 Auto-Sniper Nomor WA', callback_data: 'cmd_hunt_wa' }, { text: '📱 Cek Stok Nomor WA Aktif', callback_data: 'cmd_get_wa_numbers_0' }],
        [{ text: '🛒 Cari Stok Negara', callback_data: 'cmd_search_range' }, { text: '📢 Siarkan Stok Nomor', callback_data: 'cmd_active_ranges' }],
        [{ text: '🔗 Hubungkan WA Bot (Filter)', callback_data: 'cmd_wa_login' }, { text: '🔌 Putuskan WA Bot', callback_data: 'cmd_wa_logout' }],
        [{ text: '🧹 Hapus Nomor Mati', callback_data: 'cmd_clean_dead_nodes' }, { text: '🗑 Reset Database', callback_data: 'cmd_delete_all' }],
        [{ text: '🔍 Cari Riwayat OTP', callback_data: 'cmd_search' }, { text: '⚙️ Status Server OTP', callback_data: 'cmd_status' }],
        [{ text: '👥 Daftar Pengguna', callback_data: 'cmd_manage_users' }, { text: '🏦 Kelola Akun API List', callback_data: 'cmd_list_accounts' }],
        [{ text: '📄 Panduan Bulk Check (TXT)', callback_data: 'cmd_help_bulk' }]
    ]
});

const getUserMenuMarkup = () => ({
    inline_keyboard: [
        [{ text: '📱 Ambil Nomor WhatsApp', callback_data: 'user_get_number' }],
        [{ text: '🔍 Cek / Pantau OTP Nomor Saya', callback_data: 'user_get_otp' }]
    ]
});

const getCancelMarkup = () => ({
    inline_keyboard: [[{ text: '❌ Batalkan Operasi', callback_data: 'cmd_cancel' }]]
});

function formatMessageCard(msgData, isManual = false) {
    const otpMatch = msgData.text.match(/\b\d{3}[-\s]?\d{3}\b/) || msgData.text.match(/\b\d{4,8}\b/);
    const cleanOtp = otpMatch ? otpMatch[0].replace(/\D/g, '') : null;

    let text = `💬 *PESAN MASUK (INBOX)*\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `📱 Nomor Tujuan : \`+${msgData.phoneNumber}\`\n`;
    text += `🌍 Negara Asal : ${msgData.countryRange}\n`;
    text += `✉️ Pengirim : ${msgData.sender}\n`;
    text += `⏱ Waktu Terima : ${msgData.time} (UTC)\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `📝 *Isi Pesan:*\n_${escapeMarkdown(msgData.text)}_\n`;

    const inline_keyboard = [];
    if (cleanOtp) {
        text += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n🔑 *KODE OTP WA :* \`${cleanOtp}\`\n_💡 Ketuk angka OTP di atas untuk menyalin_`;
        inline_keyboard.push([{ text: `🔑 ${cleanOtp}`, callback_data: 'dummy_btn' }]);
    }
    if (!isManual) inline_keyboard.push([{ text: '🤖 Kembali ke Menu Utama', url: `https://t.me/${process.env.BOT_USERNAME || 'bot'}` }]); 

    return { text, reply_markup: { inline_keyboard } };
}

async function safeEditMessageText(text, options) {
    try { await bot.editMessageText(text, options); }
    catch (e) { if (!e.message.includes('message is not modified')) console.error('[safeEdit Error]', e.message); }
}

// ─── CORE: KELAS IVAS ACCOUNT DENGAN GLOBAL HEADERS ────────────────────────
class IVASAccount {
    constructor(accountId, cookieString) {
        this.accountId = accountId;
        this.cookieString = cookieString;
        
        const xsrfMatch = cookieString.match(/XSRF-TOKEN=([^;]+)/);
        const rawXsrf = xsrfMatch ? xsrfMatch[1] : '';
        this.headerCsrf = decodeURIComponent(rawXsrf);

        this.client = axios.create({
            baseURL: 'https://www.ivasms.com', 
            timeout: 15000 
        });
        this.loggedIn = false;
        this.csrfToken = null; 
    }

    getBaseHeaders() {
        return {
            "accept": "application/json, text/javascript, */*; q=0.01",
            "accept-language": "en-US,en;q=0.9",
            "cookie": this.cookieString,
            "sec-ch-ua": '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
            "sec-ch-ua-mobile": "?1",
            "sec-ch-ua-platform": '"Android"',
            "user-agent": "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36",
            "x-csrf-token": this.headerCsrf,
            "x-requested-with": "XMLHttpRequest"
        };
    }

    async initSession() {
        try {
            const res = await this.client.get('/portal/sms/received', { 
                headers: { ...this.getBaseHeaders(), 'Accept': 'text/html' }
            });
            if (res.status === 200) {
                const $ = cheerio.load(res.data);
                const csrfInput = $('input[name="_token"]');
                if (csrfInput.length) { 
                    this.csrfToken = csrfInput.val(); 
                    this.loggedIn = true; 
                    return true; 
                }
            }
            return false;
        } catch (e) { return false; }
    }

    // ==========================================
    // TAHAP 1: RADAR (Kumpulkan Range Aktif)
    // ==========================================
    async scanActiveRanges(targetCount = 10) {
        let uniqueRanges = new Set(); 
        let start = 0; 
        let page = 1;
        const MAX_PAGES = 50; 
        const TARGET_SID = 'WhatsApp';
        const EXCLUDE_RANGES = ['INDONESIA', 'MALAYSIA'];

        while (uniqueRanges.size < targetCount && page <= MAX_PAGES) {
            const params = new URLSearchParams({
                'draw': page.toString(),
                'columns[0][data]': 'range',
                'columns[2][data]': 'originator',
                'columns[2][searchable]': 'true', 
                'order[0][column]': '0',
                'order[0][dir]': 'asc',
                'start': start.toString(),
                'length': '50', 
                'search[value]': TARGET_SID, 
                '_': Date.now().toString()
            });

            try {
                const res = await this.client.get(`/portal/sms/test/sms?${params.toString()}`, { 
                    headers: { ...this.getBaseHeaders(), "referer": "https://www.ivasms.com/portal/sms/test/sms" }
                });
                
                if (res.status === 200 && res.data?.data) {
                    if (res.data.data.length === 0) break; 
                    
                    for (const row of res.data.data) {
                        const $ = cheerio.load(row.originator || '');
                        const sender = $.text().trim().toLowerCase() || (row.originator || '').toLowerCase();
                        const range = (row.range || '').toUpperCase();
                        const isExcluded = EXCLUDE_RANGES.some(ex => range.includes(ex));
                        
                        if (sender.includes(TARGET_SID.toLowerCase()) && !isExcluded && range !== '') {
                            uniqueRanges.add(range);
                        }
                    }
                } else {
                    break;
                }
                
                if (uniqueRanges.size >= targetCount) break;
                start += 50; 
                page++;
                await delay(1000); 
            } catch (error) {
                break; 
            }
        }
        return Array.from(uniqueRanges).slice(0, targetCount);
    }

    async getMyNumbers() {
        try {
            const params = new URLSearchParams({ draw: 1, start: 0, length: 2000, 'search[value]': '' });
            const res = await this.client.get(`/portal/numbers?${params.toString()}`, { headers: this.getBaseHeaders() });
            if (res.status === 200 && res.data?.data) return res.data.data.map(item => ({ number: item.Number.toString(), range: item.range }));
            return [];
        } catch (e) { return []; }
    }

    async fetchLiveTestSMS() {
        try {
            const params = new URLSearchParams({
                'draw': '1', 'columns[0][data]': 'range', 'columns[1][data]': 'termination.test_number', 
                'columns[2][data]': 'originator', 'columns[3][data]': 'messagedata', 'columns[4][data]': 'senttime', 
                'order[0][column]': '4', 'order[0][dir]': 'desc', 'start': '0', 'length': '50', 
                'search[value]': '', '_': Date.now()
            });
            const res = await this.client.get(`/portal/sms/test/sms?${params.toString()}`, { headers: this.getBaseHeaders() });
            if (res.status === 200 && res.data?.data) return res.data.data;
            return [];
        } catch (e) { return []; }
    }

    async getTestNumbersByRange(rangeName) {
        try {
            const params = new URLSearchParams({
                'draw': '3', 'columns[0][data]': 'range', 'columns[0][name]': 'terminations.range', 
                'columns[0][search][value]': rangeName, 'columns[0][search][regex]': 'false', 
                'columns[1][data]': 'test_number', 'columns[1][name]': 'terminations.test_number',
                'start': '0', 'length': '25', 'search[value]': '', '_': Date.now()
            });
            const res = await this.client.get(`/portal/numbers/test?${params.toString()}`, { headers: this.getBaseHeaders() });
            if (res.status === 200 && res.data?.data) {
                return res.data.data.map(item => {
                    // Bersihkan tag HTML dari kolom test_number
                    const $ = cheerio.load(item.test_number || '');
                    const cleanNumber = $.text().trim() || item.test_number;
                    return { 
                        id: item.id || item.DT_RowId?.replace('row_', ''), 
                        number: cleanNumber, 
                        rate: item.A2P 
                    };
                });
            }
            return [];
        } catch (e) { return []; }
    }

    async getTerminationDetails(id) {
        try {
            const payload = new URLSearchParams({ 'id': id, '_token': this.csrfToken });
            const res = await this.client.post('/portal/numbers/termination/details', payload.toString(), { 
                headers: { ...this.getBaseHeaders(), 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } 
            });
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
            const res = await this.client.post('/portal/numbers/termination/number/add', payload.toString(), { 
                headers: { ...this.getBaseHeaders(), 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } 
            });
            if (res.status === 200 && res.data) return res.data;
            return null;
        } catch (e) { return null; }
    }

    async getCountries(dateStr) {
        try {
            const payload = new URLSearchParams({ 'from': dateStr, 'to': dateStr, '_token': this.csrfToken });
            const res = await this.client.post('/portal/sms/received/getsms', payload.toString(), { 
                headers: { ...this.getBaseHeaders(), 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } 
            });
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
            const res = await this.client.post('/portal/sms/received/getsms/number', payload.toString(), { 
                headers: { ...this.getBaseHeaders(), 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } 
            });
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
            const res = await this.client.post('/portal/sms/received/getsms/number/sms', payload.toString(), { 
                headers: { ...this.getBaseHeaders(), 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } 
            });
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
            const res = await this.client.post('/portal/numbers/return/allnumber/bluck', payload.toString(), { 
                headers: { ...this.getBaseHeaders(), 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } 
            });
            if (res.status === 200 && res.data) return res.data;
            return null;
        } catch (e) { return null; }
    }
}

// ─── HELPER: AMBIL AKUN AKTIF YANG LOGGEDIN ────────────────────────────────
function getActiveAccounts() {
    return Array.from(activeSessions.entries()).filter(([id, acc]) => acc.loggedIn);
}

function getFirstActiveAccount() {
    const accounts = getActiveAccounts();
    return accounts.length > 0 ? accounts[0][1] : null;
}

// ─── INTEGRASI WHATSAPP BAILEYS ────────────────────────────────────────────
async function startWA(phoneNumberForPairing = null, reportChatId = ADMIN_CHAT_ID, msgId = null) {
    if (isConnectingWA) return; isConnectingWA = true;
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({ 
        version, printQRInTerminal: false, browser: Browsers.macOS('Chrome'), 
        auth: state, logger: pino({ level: 'silent' }), 
        markOnlineOnConnect: false, syncFullHistory: false 
    });
    sock.ev.on('creds.update', saveCreds);

    const notifyUI = async (text) => {
        const opts = { parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() };
        if (msgId) await safeEditMessageText(text, { chat_id: reportChatId, message_id: msgId, ...opts });
        else if (phoneNumberForPairing) await bot.sendMessage(reportChatId, text, opts).catch(()=>{});
    };

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (connection === 'close') {
            isConnectingWA = false;
            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                setTimeout(() => startWA(null, reportChatId, msgId), 5000); 
            } else { 
                if (msgId) await notifyUI("❌ *SESI META DIAKHIRI*\nWhatsApp telah diputuskan dari server.");
                if (fs.existsSync('./auth_info_baileys')) fs.rmSync('./auth_info_baileys', { recursive: true, force: true }); 
                sock = null; 
            }
        } else if (connection === 'open') { 
            isConnectingWA = false; 
            if (msgId || phoneNumberForPairing) await notifyUI('✅ *SINKRONISASI WA BERHASIL*\nMesin penyaring nomor siap digunakan.'); 
        }

        if (phoneNumberForPairing && !sock.authState.creds.registered && qr) {
            try {
                await notifyUI(`⏳ *Menghubungkan ke Server Meta...*\nMeminta kode pemasangan untuk: \`${phoneNumberForPairing}\``);
                const code = await sock.requestPairingCode(phoneNumberForPairing);
                const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
                await notifyUI(`✅ *KODE PAIRING WA ANDA*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n🔑 \`${formattedCode}\`\n\n1️⃣ Buka WhatsApp di HP\n2️⃣ Pilih Perangkat Tertaut\n3️⃣ Tautkan dengan Nomor Telepon\n4️⃣ Masukkan kode di atas.`);
                phoneNumberForPairing = null; 
            } catch (error) { await notifyUI(`❌ *GAGAL*\n${error.message}`); isConnectingWA = false; }
        }
    });
}

// ─── ALOKASI & MANAJEMEN NOMOR ─────────────────────────────────────────────
async function autoFilterAndSaveNumbers(chatId, numbersObjArray, msgId, accountId) {
    if (!numbersObjArray || numbersObjArray.length === 0) return;

    if (!sock?.authState?.creds?.registered) {
        await safeEditMessageText(`⚠️ *BOT WA TERPUTUS*\nMenyimpan *${numbersObjArray.length}* nomor mentah ke database tanpa filter...`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        const placeholders = numbersObjArray.map(() => '(?, ?, ?)').join(', ');
        const values = numbersObjArray.flatMap(n => [n.number, accountId, n.range]);
        await dbRun(`INSERT OR IGNORE INTO wa_nodes (number, account_id, range_name) VALUES ${placeholders}`, values);
        await safeEditMessageText(`✅ *SINKRONISASI SELESAI*\n${numbersObjArray.length} nomor berhasil diamankan _(tanpa filter WA)_.`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        return;
    }

    const CONCURRENCY = 5;
    let activeCount = 0; let processed = 0; const total = numbersObjArray.length;
    await safeEditMessageText(`⚡ *PENYARINGAN WA AKTIF*\nMemeriksa status *${total}* nomor ke server Meta...`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });

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
        
        safeEditMessageText(`⚡ *MEMERIKSA NOMOR...*\nProgres: ${processed} / ${total}\n✅ Aktif di WA: *${activeCount}* Nomor`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(() => {});
        await delay(500);
    }
    await safeEditMessageText(`✅ *PENYARINGAN SELESAI*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\nTotal Dicek : ${total}\nBerhasil Disimpan : *${activeCount}* Nomor WA Aktif\n_(ID Akun API: ${accountId})_`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
}

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

async function releaseNumberFromUser(userChatId) {
    await dbRun('DELETE FROM user_assigned_numbers WHERE user_chat_id = ?', [userChatId]);
}

async function checkOtpForNumber(number, rangeName) {
    const node = await dbGet('SELECT account_id FROM wa_nodes WHERE number = ?', [number]);
    if (!node) {
        for (const [, acc] of getActiveAccounts()) {
            const todayStr = getTodayUTC();
            const messages = await acc.getMessages(number, rangeName, todayStr).catch(() => []);
            if (messages && messages.length > 0) return messages[0];
        }
        return null;
    }
    const acc = activeSessions.get(node.account_id);
    if (!acc || !acc.loggedIn) {
        const fallback = getFirstActiveAccount();
        if (!fallback) return null;
        const messages = await fallback.getMessages(number, rangeName, getTodayUTC()).catch(() => []);
        return messages && messages.length > 0 ? messages[0] : null;
    }
    const messages = await acc.getMessages(number, rangeName, getTodayUTC()).catch(() => []);
    return messages && messages.length > 0 ? messages[0] : null;
}

// ─── POLLING OTP PENGGUNA ──────────────────────────────────────────────────
function stopOtpPolling(userChatId) {
    const existing = activeOtpPolling.get(userChatId);
    if (existing) { clearTimeout(existing.timeoutId); activeOtpPolling.delete(userChatId); }
}

async function startOtpPolling(userChatId, number, rangeName, msgId) {
    stopOtpPolling(userChatId);
    let attempts = 0; const MAX_ATTEMPTS = 24;
    const lastSeenId = userStates[userChatId]?.lastSeenMsgId;

    const poll = async () => {
        attempts++; const elapsed = attempts * 5;
        await safeEditMessageText(
            `⏳ *MENUNGGU KODE OTP WA...*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n📱 Nomor WA : \`+${number}\`\n🌍 Negara : ${rangeName}\n\n⏱ Memantau SMS: Ke-${attempts} (${elapsed} detik)...\n_Silakan klik 'Kirim Ulang SMS' pada aplikasi WhatsApp Anda._`, 
            { chat_id: userChatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Batalkan Pencarian OTP', callback_data: 'user_cancel_otp' }]] } }
        ).catch(() => {});

        const msg = await checkOtpForNumber(number, rangeName);
        const currentMsgId = msg ? `${msg.time}_${msg.text}` : null;
        
        if (msg && currentMsgId !== lastSeenId) {
            stopOtpPolling(userChatId);
            if (!userStates[userChatId]) userStates[userChatId] = {};
            userStates[userChatId].lastSeenMsgId = currentMsgId;
            
            await dbRun(`INSERT OR REPLACE INTO used_numbers (number, user_chat_id) VALUES (?, ?)`, [number, userChatId]);

            const otpMatch = msg.text.match(/\b\d{3}[-\s]?\d{3}\b/) || msg.text.match(/\b\d{4,8}\b/);
            const otp = otpMatch ? otpMatch[0].replace(/\D/g, '') : null;
            
            let replyText = `🎉 *KODE OTP BERHASIL DIDAPATKAN!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
            replyText += `📱 Nomor : \`+${number}\`\n✉️ Pengirim : ${msg.sender}\n⏱ Waktu : ${msg.time} (UTC)\n`;
            replyText += `🔐 *Status : Nomor Telah Dihanguskan*\n\n📝 *Isi Pesan:*\n_${escapeMarkdown(msg.text)}_\n`;
            if (otp) replyText += `━━━━━━━━━━━━━━━━━━━━━━━━━━\n🔑 *KODE OTP WA : \`${otp}\`*\n_💡 Ketuk angka OTP di atas untuk menyalin_`;

            await safeEditMessageText(replyText, { 
                chat_id: userChatId, message_id: msgId, parse_mode: 'Markdown', 
                reply_markup: { inline_keyboard: [ 
                    ...(otp ? [[{ text: `🔑 ${otp}`, callback_data: 'dummy_btn' }]] : []), 
                    [{ text: '🔄 Ambil Nomor WhatsApp Lain', callback_data: 'user_new_number' }] 
                ]} 
            }).catch(() => {});
            return;
        }

        if (attempts >= MAX_ATTEMPTS) {
            stopOtpPolling(userChatId);
            await safeEditMessageText(`⏰ *PENCARIAN OTP HABIS WAKTU*\nTarget: \`+${number}\`\nTidak ada SMS OTP WhatsApp yang masuk selama 2 menit.`, { 
                chat_id: userChatId, message_id: msgId, parse_mode: 'Markdown', 
                reply_markup: { inline_keyboard: [[{ text: '🔄 Ganti Nomor Lain', callback_data: 'user_new_number' }, { text: '🔁 Ulangi Pencarian OTP', callback_data: 'user_get_otp' }]] } 
            }).catch(() => {});
            return;
        }
        const timeoutId = setTimeout(poll, 5000); 
        activeOtpPolling.set(userChatId, { timeoutId, msgId });
    };
    const timeoutId = setTimeout(poll, 5000); 
    activeOtpPolling.set(userChatId, { timeoutId, msgId });
}

// ─── WORKER BULK CHECK WA ──────────────────────────────────────────────────
async function processBulkCheck(numbers, config, chatId, msgId) {
    let resPersonal = "=== WA PERSONAL ===\n\n";
    let resBisnis = "=== WA BISNIS ===\n\n";
    let resUnreg = "=== TIDAK TERDAFTAR ===\n\n";
    let countP = 0, countB = 0, countU = 0; let processed = 0; const total = numbers.length;

    for (let i = 0; i < total; i += config.batch) {
        const batch = numbers.slice(i, i + config.batch);
        const promises = batch.map(async (num, idx) => {
            await delay(idx * 200); 
            const jid = `${num}@s.whatsapp.net`; 
            let result = { num, isReg: false, isBiz: false, bio: '-', desc: '-', cat: '-', dp: '-' };
            try { 
                const [status] = await sock.onWhatsApp(jid); 
                if (status?.exists) { 
                    result.isReg = true; 
                    try { result.bio = (await sock.fetchStatus(jid))?.status || '-'; } catch(e){} 
                    try { result.dp = await sock.profilePictureUrl(jid, 'image') || '-'; } catch(e){} 
                    try { 
                        const biz = await sock.getBusinessProfile(jid); 
                        if (biz) { result.isBiz = true; result.desc = biz.description || '-'; result.cat = biz.category || '-'; } 
                    } catch(e){} 
                } 
            } catch(e) {} 
            return result;
        });
        
        const batchRes = await Promise.allSettled(promises);
        batchRes.forEach(r => { 
            if (r.status === 'fulfilled') { 
                const v = r.value; 
                if (v.isReg) { 
                    if (v.isBiz) { resBisnis += `${v.num}\nBio: ${v.bio}\nKategori: ${v.cat}\nDeskripsi: ${v.desc}\nDP: ${v.dp}\n---\n`; countB++; } 
                    else { resPersonal += `${v.num}\nBio: ${v.bio}\nDP: ${v.dp}\n---\n`; countP++; } 
                } else { resUnreg += `${v.num}\n`; countU++; } 
            } 
        });
        
        processed += batch.length; 
        safeEditMessageText(`⏳ *EKSTRAKSI MASSAL BERJALAN*\nProgres: ${processed} / ${total}\n_Jeda server ${config.delay/1000} detik..._`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }); 
        if (processed < total) await delay(config.delay);
    }

    safeEditMessageText(`✅ *EKSTRAKSI SELESAI*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n📊 Total Diperiksa : ${total}\n👤 WA Personal : *${countP}*\n🏢 WA Bisnis : *${countB}*\n❌ Tidak Terdaftar : *${countU}*`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
    if (countP > 0) bot.sendDocument(chatId, Buffer.from(resPersonal, 'utf-8'), {}, { filename: `Personal_Lead_${Date.now()}.txt`, contentType: 'text/plain' });
    if (countB > 0) bot.sendDocument(chatId, Buffer.from(resBisnis, 'utf-8'), {}, { filename: `Business_Lead_${Date.now()}.txt`, contentType: 'text/plain' });
    if (countU > 0) bot.sendDocument(chatId, Buffer.from(resUnreg, 'utf-8'), {}, { filename: `Unregistered_${Date.now()}.txt`, contentType: 'text/plain' });
}

// ─── BACKGROUND POLLING SEMUA AKUN ────────────────────────────────────────
async function pollAllAccounts() {
    const today = getTodayUTC();
    try {
        for (const [accountId, account] of activeSessions.entries()) {
            if (!account.loggedIn) continue;
            try {
                const checkData = await account.getCountries(today);
                let hasNew = false;
                for (const country of checkData.countries) {
                    const numbersInCountry = await account.getNumbers(country, today);
                    for (const number of numbersInCountry) {
                        const messages = await account.getMessages(number, country, today);
                        for (const msg of messages) {
                            const msgId = `${msg.phoneNumber}_${msg.time}_${msg.sender}`;
                            const isSeen = await dbGet('SELECT msg_id FROM seen_ids WHERE msg_id = ? AND account_id = ?', [msgId, accountId]);
                            if (!isSeen) {
                                await dbRun('INSERT INTO seen_ids (msg_id, account_id) VALUES (?, ?)', [msgId, accountId]);
                                hasNew = true;
                            }
                        }
                    }
                }
                if (hasNew) await dbRun(`DELETE FROM seen_ids WHERE rowid NOT IN (SELECT rowid FROM seen_ids WHERE account_id = ? ORDER BY rowid DESC LIMIT 1000)`, [accountId]);
            } catch (e) {
                if (e.response && (e.response.status === 401 || e.response.status === 403)) {
                    account.loggedIn = false;
                    activeSessions.delete(accountId);
                    console.log(`[POLL] Akun ID ${accountId} expired, dihapus dari sesi aktif.`);
                }
            }
        }
    } finally {
        setTimeout(pollAllAccounts, POLLING_INTERVAL);
    }
}

// ─── TELEGRAM: COMMAND HANDLER ─────────────────────────────────────────────
bot.onText(/\/(start|menu)/, async (msg) => {
    const chatId = msg.chat.id.toString();
    bot.deleteMessage(chatId, msg.message_id).catch(()=>{});

    if (!isAdmin(chatId)) await dbRun('INSERT OR IGNORE INTO whitelisted_users (chat_id, username, added_at) VALUES (?, ?, ?)', [chatId, msg.from.username || msg.from.first_name || 'User', new Date().toISOString()]);

    if (isAdmin(chatId)) {
        const activeAccCount = getActiveAccounts().length;
        const totalAccCount = activeSessions.size;
        const sentMsg = await bot.sendMessage(chatId, `🔥 *PANEL ADMIN BOT OTP* 🔥\n━━━━━━━━━━━━━━━━━━━━━━━━━━\nSistem Manajemen Provider OTP WhatsApp.\nAkun API: ${activeAccCount}/${totalAccCount} Aktif`, { parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        userStates[chatId] = { state: 'IDLE', lastMsgId: sentMsg.message_id };
    } else {
        if (!(await checkForceSub(chatId))) return sendForceSubMessage(chatId);
        const sentMsg = await bot.sendMessage(chatId, `🔥 *LAYANAN BOT OTP* 🔥\n━━━━━━━━━━━━━━━━━━━━━━━━━━\nSelamat datang! Layanan Provider OTP WhatsApp.\nSilakan tekan tombol di bawah untuk mengambil nomor WA.`, { parse_mode: 'Markdown', reply_markup: getUserMenuMarkup() });
        userStates[chatId] = { state: 'IDLE', lastMsgId: sentMsg.message_id };
    }
});

// ─── TELEGRAM: CALLBACK QUERY HANDLER ─────────────────────────────────────
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id.toString();
    const msgId = query.message.message_id;
    const action = query.data;

    if (action === 'dummy_btn') {
        return bot.answerCallbackQuery(query.id, { 
            text: '💡 Ketuk teks angka OTP (abu-abu) di dalam pesan untuk menyalin otomatis.', 
            show_alert: true 
        });
    }

    bot.answerCallbackQuery(query.id);

    if (action === 'check_join') {
        if (await checkForceSub(chatId)) {
            return safeEditMessageText(`🔥 *LAYANAN BOT OTP* 🔥\n━━━━━━━━━━━━━━━━━━━━━━━━━━\nVerifikasi berhasil. Silakan ambil nomor WhatsApp Anda.`, { 
                chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', 
                reply_markup: isAdmin(chatId) ? getMainMenuMarkup() : getUserMenuMarkup() 
            });
        }
        return bot.answerCallbackQuery(query.id, { text: "❌ Sistem mendeteksi Anda belum berada di Kanal Resmi!", show_alert: true });
    }

    if (!isAdmin(chatId) && !(await checkForceSub(chatId))) return sendForceSubMessage(chatId, msgId);

    if (action === 'cmd_help_bulk') {
        const text = `📁 *PANDUAN EKSTRAKSI MASSAL (BULK CHECK TXT)*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\nSistem Bot OTP dapat memfilter WA Personal, Bisnis, dan Nomor Tidak Terdaftar secara massal.\n\n*Langkah-langkah:*\n1. Siapkan file \`.txt\` berisi daftar nomor (1 nomor per baris).\n2. *Kirim / Upload file tersebut langsung ke dalam chat bot ini.*\n3. Pilih kecepatan ekstraksi (Turbo/Normal/Siluman) yang muncul di layar.\n4. Tunggu hingga bot membalas dengan hasil pemisahan dokumen TXT.`;
        return safeEditMessageText(text, { 
            chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', 
            reply_markup: { inline_keyboard: [[{ text: '⬅️ Kembali ke Menu Utama', callback_data: 'cmd_cancel' }]] } 
        });
    }

    if (action === 'user_get_number' || action === 'user_new_number') {
        if (action === 'user_new_number') { 
            const state = userStates[chatId];
            if (state?.assignedNumber) await dbRun(`INSERT OR IGNORE INTO used_numbers (number, user_chat_id) VALUES (?, ?)`, [state.assignedNumber, chatId]);
            stopOtpPolling(chatId); 
            await releaseNumberFromUser(chatId); 
        }
        if (getActiveAccounts().length === 0) {
            return safeEditMessageText("⚠️ *SISTEM OFFLINE*\nInfrastruktur API sedang tidak terhubung.", { 
                chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', 
                reply_markup: isAdmin(chatId) ? getMainMenuMarkup() : getUserMenuMarkup()
            });
        }
        await safeEditMessageText("🔄 *MENCARI NOMOR WHATSAPP...*\nMengalokasikan stok nomor segar dari server...", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        const assigned = await assignRandomNumberToUser(chatId);
        if (!assigned) {
            return safeEditMessageText("❌ *STOK HABIS*\nSeluruh nomor WhatsApp sedang digunakan oleh pengguna lain.", { 
                chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', 
                reply_markup: { inline_keyboard: [[{ text: '🔄 Coba Cari Lagi', callback_data: 'user_get_number' }]] } 
            });
        }
        userStates[chatId] = { ...userStates[chatId], assignedNumber: assigned.number, assignedRange: assigned.range_name, lastSeenMsgId: null };
        await safeEditMessageText(
            `✅ *NOMOR WA DITEMUKAN*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n📱 Nomor WA : \`+${assigned.number}\`\n🌍 Negara : ${assigned.range_name}\n\n💡 _Langkah selanjutnya:_\n_1. Ketuk nomor di atas untuk menyalin._\n_2. Masukkan nomor tersebut ke aplikasi WhatsApp._\n_3. Tekan tombol Cek SMS OTP di bawah._`, 
            { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', 
              reply_markup: { inline_keyboard: [ 
                [{ text: `📱 +${assigned.number}`, callback_data: 'dummy_btn' }], 
                [{ text: '📨 Cek SMS OTP (Mulai Pantau)', callback_data: 'user_get_otp' }], 
                [{ text: '🔄 Ganti Nomor Lain', callback_data: 'user_new_number' }] 
              ]} 
            }
        );
        return;
    }

    if (action === 'user_get_otp') {
        const state = userStates[chatId]; 
        let number = state?.assignedNumber; 
        let rangeName = state?.assignedRange;
        if (!number || !rangeName) {
            const assigned = await dbGet('SELECT number, range_name FROM user_assigned_numbers WHERE user_chat_id = ?', [chatId]);
            if (!assigned) return safeEditMessageText("❌ *SESI TIDAK VALID*\nSesi nomor Anda telah berakhir atau belum mengambil nomor.", { 
                chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', 
                reply_markup: isAdmin(chatId) ? getMainMenuMarkup() : getUserMenuMarkup()
            });
            userStates[chatId] = { ...userStates[chatId], assignedNumber: assigned.number, assignedRange: assigned.range_name };
        }
        await safeEditMessageText(`🔍 *MEMULAI PENCARIAN OTP...*\nNomor: \`+${userStates[chatId].assignedNumber}\`\nMenghubungkan ke server SMS penerima...`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        startOtpPolling(chatId, userStates[chatId].assignedNumber, userStates[chatId].assignedRange, msgId);
        return;
    }

    if (action === 'user_cancel_otp') {
        stopOtpPolling(chatId);
        return safeEditMessageText(`✋ *PENCARIAN OTP DIJEDA*\nNomor Anda masih diamankan:\n\`+${userStates[chatId]?.assignedNumber || '-'}\``, { 
            chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', 
            reply_markup: { inline_keyboard: [ 
                [{ text: '📨 Lanjutkan Cari OTP', callback_data: 'user_get_otp' }], 
                [{ text: '🔄 Buang & Ganti Nomor Baru', callback_data: 'user_new_number' }] 
            ]} 
        });
    }

    if (!isAdmin(chatId)) return;
    if (!userStates[chatId]) userStates[chatId] = { state: 'IDLE', lastMsgId: msgId };

    if (action === 'cmd_manage_users') {
        const users = await dbAll('SELECT chat_id, username, added_at FROM whitelisted_users ORDER BY added_at DESC LIMIT 50');
        const countRow = await dbGet('SELECT COUNT(*) as count FROM whitelisted_users');
        let text = `👥 *DAFTAR PENGGUNA PUBLIK*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\nTotal: ${countRow.count} Pengguna\n\n_50 Terakhir:_\n`;
        users.forEach((u, i) => { text += `${i+1}. ${u.username || 'Unknown'} (\`${u.chat_id}\`)\n`; });
        if (users.length === 0) text += '_Belum ada pengguna._';
        return safeEditMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '⬅️ Kembali', callback_data: 'cmd_cancel' }]] } });
    }

    if (action === 'cmd_list_accounts') {
        const accounts = await dbAll('SELECT id, label, added_at FROM ivas_accounts ORDER BY id ASC');
        if (accounts.length === 0) return safeEditMessageText("❌ *BELUM ADA AKUN API*\nSilakan tambah akun API terlebih dahulu.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        let text = `🏦 *DAFTAR AKUN API IVAS*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        for (const acc of accounts) {
            const isActive = activeSessions.has(acc.id) && activeSessions.get(acc.id).loggedIn;
            text += `${isActive ? '🟢' : '🔴'} ID: \`${acc.id}\` | ${acc.label || 'Tanpa Label'}\n   └ Ditambah: ${acc.added_at}\n\n`;
        }
        const inline_keyboard = accounts.map(acc => [
            { text: `🗑 Hapus Akun ID ${acc.id} (${acc.label || 'No Label'})`, callback_data: `cmd_del_account_${acc.id}` }
        ]);
        inline_keyboard.push([{ text: '➕ Tambah Akun API Baru', callback_data: 'cmd_login' }]);
        inline_keyboard.push([{ text: '⬅️ Kembali', callback_data: 'cmd_cancel' }]);
        return safeEditMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard } });
    }

    if (action.startsWith('cmd_del_account_')) {
        const accId = parseInt(action.replace('cmd_del_account_', ''));
        await safeEditMessageText(`⚠️ *KONFIRMASI HAPUS AKUN*\nAkun API ID: \`${accId}\` akan dihapus permanen beserta seluruh nomornya.`, {
            chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [
                [{ text: '⚠️ YA, HAPUS AKUN INI', callback_data: `cmd_confirm_del_account_${accId}` }],
                [{ text: '❌ Batal', callback_data: 'cmd_list_accounts' }]
            ]}
        });
        return;
    }

    if (action.startsWith('cmd_confirm_del_account_')) {
        const accId = parseInt(action.replace('cmd_confirm_del_account_', ''));
        activeSessions.delete(accId);
        await dbRun('DELETE FROM ivas_accounts WHERE id = ?', [accId]);
        await dbRun('DELETE FROM wa_nodes WHERE account_id = ?', [accId]);
        await dbRun('DELETE FROM seen_ids WHERE account_id = ?', [accId]);
        return safeEditMessageText(`✅ *AKUN API ID ${accId} DIHAPUS*\nSeluruh data nomor terkait juga telah dibersihkan.`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
    }

    if (action === 'cmd_active_ranges') {
        const ranges = await dbAll('SELECT range_name, COUNT(*) as count FROM wa_nodes GROUP BY range_name ORDER BY count DESC');
        if (ranges.length === 0) return safeEditMessageText("⚠️ *STOK KOSONG*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        let text = `📢 *STOK NEGARA AKTIF*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        ranges.forEach((r, i) => { text += `${i+1}. *${r.range_name}* - ${r.count} Nomor\n`; });
        return safeEditMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [ 
            REQUIRED_CHANNEL_ID ? [{ text: '📤 Siarkan ke Kanal', callback_data: 'cmd_broadcast_ranges' }] : [],
            [{ text: '⬅️ Kembali', callback_data: 'cmd_cancel' }] 
        ]} });
    }

    if (action === 'cmd_broadcast_ranges') {
        const ranges = await dbAll('SELECT range_name, COUNT(*) as count FROM wa_nodes GROUP BY range_name ORDER BY count DESC');
        let text = `🔥 *RESTOCK NOMOR WHATSAPP* 🔥\n━━━━━━━━━━━━━━━━━━━━━━\n`;
        let total = 0; 
        ranges.forEach((r) => { text += `🌍 *${r.range_name}* : ✅ Tersedia\n`; total += r.count; });
        text += `\nTotal *${total}* Nomor WA siap dipakai!\n\n👇 Ambil Nomor Sekarang: @${process.env.BOT_USERNAME || 'PansaBot'}`;
        try {
            await bot.sendMessage(REQUIRED_CHANNEL_ID, text, { parse_mode: 'Markdown' });
            return safeEditMessageText("✅ *SIARAN BERHASIL DIKIRIM*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        } catch (e) { 
            return safeEditMessageText(`❌ *GAGAL MENYIARKAN*\nPastikan bot adalah Admin di Kanal.`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() }); 
        }
    }

    if (action === 'cmd_login') {
        userStates[chatId].state = 'WAITING_RAW_COOKIE'; 
        return safeEditMessageText("🔑 *TAMBAH AKUN API IVAS*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\nKirimkan teks *RAW COOKIES* dari request browser Anda.\n\nContoh:\n`cf_clearance=ivdHY...; XSRF-TOKEN=eyJp...; ivas_sms_session=eyJp...`", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getCancelMarkup() });
    } 

    if (action === 'cmd_sync_db') {
        const activeAccs = getActiveAccounts();
        if (activeAccs.length === 0) return safeEditMessageText("⚠️ *TIDAK ADA AKUN API AKTIF*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        await dbRun('DELETE FROM wa_nodes');
        let totalSynced = 0; let processedAccs = 0;
        for (const [accId, acc] of activeAccs) {
            processedAccs++;
            await safeEditMessageText(`⏳ *SINKRONISASI SEMUA AKUN API*\nMenarik data dari Akun ID: \`${accId}\` (${processedAccs}/${activeAccs.length})...`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{});
            const myNumbers = await acc.getMyNumbers();
            if (myNumbers.length > 0) { 
                await autoFilterAndSaveNumbers(chatId, myNumbers, msgId, accId); 
                totalSynced += myNumbers.length; 
            }
        }
        safeEditMessageText(`✅ *SINKRONISASI SELESAI*\nTotal: ${totalSynced} Nomor WA dari ${activeAccs.length} Akun API.`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        return;
    }

    if (action.startsWith('cmd_get_wa_numbers_')) {
        const offset = parseInt(action.replace('cmd_get_wa_numbers_', '')) || 0; 
        const limit = 3;
        const totalRow = await dbGet('SELECT COUNT(*) as count FROM wa_nodes'); 
        const total = totalRow.count;
        if (total === 0) return safeEditMessageText("❌ *STOK NOMOR WA KOSONG*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        const currentOffset = offset >= total ? 0 : offset;
        const numbers = await dbAll('SELECT number, range_name, account_id FROM wa_nodes LIMIT ? OFFSET ?', [limit, currentOffset]);
        let text = `📱 *STOK NOMOR WA AKTIF*\nMenampilkan ${currentOffset + 1} - ${Math.min(currentOffset + limit, total)} dari *${total}* Nomor\n\n`;
        const inline_keyboard = [];
        numbers.forEach((n, i) => {
            text += `${currentOffset + i + 1}. 🌍 *${n.range_name}* _(Akun: ${n.account_id})_\n   └ 📱 \`+${n.number}\`\n\n`;
            inline_keyboard.push([{ text: `📋 Salin: +${n.number}`, callback_data: 'dummy_btn' }]);
        });
        const navButtons = [];
        if (total > limit) navButtons.push({ text: '🔄 Muat Halaman Lanjut', callback_data: `cmd_get_wa_numbers_${currentOffset + limit}` });
        navButtons.push({ text: '⬅️ Kembali ke Menu', callback_data: 'cmd_cancel' });
        inline_keyboard.push(navButtons);
        return safeEditMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard } });
    }

    if (action === 'cmd_search_range') {
        const activeAccs = getActiveAccounts();
        if (activeAccs.length === 0) return safeEditMessageText("⚠️ *TIDAK ADA AKUN API AKTIF*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        userStates[chatId].state = 'WAITING_RANGE';
        return safeEditMessageText(`🛒 *CARI STOK BERDASARKAN NEGARA*\nKetikkan nama negara (misal: \`INDONESIA 232428\`).`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getCancelMarkup() });
    }

    if (action.startsWith('term_detail_')) {
        const parts = action.split('_'); 
        const termId = parts[2]; 
        const accId = parseInt(parts[3]);
        const acc = activeSessions.get(accId);
        if (!acc) return safeEditMessageText("❌ Sesi Akun API tidak ditemukan.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        await safeEditMessageText("⏳ *MENGAMBIL INFO HARGA...*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        const details = await acc.getTerminationDetails(termId);
        if (details) {
            let detailText = `📄 *INFO PEMBELIAN NOMOR WA*\n📌 *Negara:* \`${details.rangeName}\`\n💵 *Harga A2P:* ${details.a2pRate}\n\n📊 *Aturan IVAS:*\n`;
            details.limits.forEach(l => { detailText += `  └ *${l.key}:* ${l.val}\n`; });
            const detailMarkup = { inline_keyboard: [ [{ text: '➕ Beli Nomor Ini', callback_data: `add_term_${termId}_${accId}` }], [{ text: '⬅️ Kembali', callback_data: 'cmd_cancel' }] ] };
            safeEditMessageText(detailText, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: detailMarkup });
        } else {
            safeEditMessageText("❌ *GAGAL MENGAMBIL INFO HARGA*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        }
        return;
    }

    if (action.startsWith('add_term_')) {
        const parts = action.split('_'); 
        const termId = parts[2]; 
        const accId = parseInt(parts[3]);
        const acc = activeSessions.get(accId);
        if (!acc) return safeEditMessageText("❌ Sesi Akun API tidak ditemukan.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        await safeEditMessageText(`⏳ *MEMPROSES PEMBELIAN...*`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        const result = await acc.addNumber(termId);
        if (result && result.message) {
            const resStr = result.message.toLowerCase();
            if (resStr.includes('done') || resStr.includes('success') || resStr.includes('berhasil')) {
                const existingNums = await dbAll('SELECT number FROM wa_nodes WHERE account_id = ?', [accId]);
                const existingSet = new Set(existingNums.map(n => n.number));
                const allMyNumbers = await acc.getMyNumbers();
                const newNumbers = allMyNumbers.filter(n => !existingSet.has(n.number));
                if (newNumbers.length > 0) await autoFilterAndSaveNumbers(chatId, newNumbers, msgId, accId);
                else safeEditMessageText(`✅ *PEMBELIAN BERHASIL*\nStatus: ${result.message}\n_Nomor WA sedang disiapkan oleh server._`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
            } else {
                safeEditMessageText(`❌ *PEMBELIAN GAGAL*\nSaldo tidak cukup atau limit tercapai.\nStatus API: ${result.message}`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
            }
        } else {
            safeEditMessageText("❌ *TRANSAKSI GAGAL (API ERROR)*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        }
        return;
    }

    // ── Hentikan Sniper ──
    if (action === 'cmd_stop_sniper') {
        if (userStates[chatId]) userStates[chatId].isSniperRunning = false;
        return bot.answerCallbackQuery(query.id, { 
            text: '🛑 Meminta sistem untuk menghentikan radar...', 
            show_alert: true 
        });
    }

    // ── AUTO-SNIPER ──
    if (action === 'cmd_hunt_wa') {
        const activeAccs = getActiveAccounts();
        if (activeAccs.length === 0) return safeEditMessageText("⚠️ *TIDAK ADA AKUN API AKTIF*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });

        userStates[chatId].isSniperRunning = true; 
        const sniperMarkup = { inline_keyboard: [[{ text: '🛑 Batalkan Radar', callback_data: 'cmd_stop_sniper' }]] };

        const MAX_BUY = 10; 

        await safeEditMessageText(`🎯 *MESIN RADAR AUTO-BUYER AKTIF*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\nMemindai server untuk mencari Range WhatsApp terbaik...`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: sniperMarkup });

        const watcherAcc = activeAccs[0][1]; 
        const accId = activeAccs[0][0];

        // -- TAHAP 1: Kumpulkan Range Aktif --
        const targetRanges = await watcherAcc.scanActiveRanges(10);
        
        if (targetRanges.length === 0) {
            userStates[chatId].isSniperRunning = false;
            return safeEditMessageText(`❌ *RADAR GAGAL*\nTidak ditemukan traffic WhatsApp di luar ID/MY saat ini.`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        }

        let purchasedCount = 0;
        let logText = `🎯 *RADAR SELESAI* (${targetRanges.length} Range)\nMemulai eksekusi borong nomor...\n\n`;
        await safeEditMessageText(logText, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: sniperMarkup });

        // -- TAHAP 2: Eksekusi Add Number --
        const newNumbers = [];
        
        for (const range of targetRanges) {
            if (!userStates[chatId].isSniperRunning || purchasedCount >= MAX_BUY) break;
            
            logText += `\n🛒 *Range:* \`${range}\`\n`;
            await safeEditMessageText(logText + `_Mengambil stok nomor..._`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: sniperMarkup }).catch(()=>{});

            // Ambil semua stok nomor di range ini (fungsi ini sudah bersih dari HTML)
            const availableNums = await watcherAcc.getTestNumbersByRange(range);
            
            if (availableNums.length === 0) {
                logText += `   └ ❌ Stok Kosong\n`;
                continue;
            }

            for (const num of availableNums) {
                if (!userStates[chatId].isSniperRunning || purchasedCount >= MAX_BUY) break;

                const buyResult = await watcherAcc.addNumber(num.id);
                const resMsg = buyResult?.message?.toLowerCase() || '';

                if (resMsg.includes('done') || resMsg.includes('success') || resMsg.includes('berhasil')) {
                    logText += `   └ ✅ +${num.number} (Sukses)\n`;
                    purchasedCount++;
                    newNumbers.push({ number: num.number, range: range });
                } else {
                    logText += `   └ ❌ +${num.number} (Gagal)\n`;
                }
                
                await safeEditMessageText(logText, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: sniperMarkup }).catch(()=>{});
                await delay(2000); 
            }
        }

        userStates[chatId].isSniperRunning = false;

        // -- TAHAP 3: Validasi & Simpan DB --
        if (newNumbers.length > 0) {
            logText += `\n✅ *BERHASIL MEMBELI ${purchasedCount} NOMOR*\n⏳ _Menyimpan ke Database & Filter WA..._`;
            await safeEditMessageText(logText, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
            
            await autoFilterAndSaveNumbers(chatId, newNumbers, msgId, accId);
        } else {
            safeEditMessageText(logText + `\n❌ *TIDAK ADA NOMOR YANG TERBELI*`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        }
        return;
    }

    if (action === 'cmd_clean_dead_nodes') {
        if (!sock?.authState?.creds?.registered) return safeEditMessageText("⚠️ *BOT WA TERPUTUS*\nDiperlukan koneksi WA untuk memverifikasi nomor.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        const nodes = await dbAll('SELECT number FROM wa_nodes');
        if (nodes.length === 0) return safeEditMessageText("❌ *STOK NOMOR KOSONG*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        
        await safeEditMessageText(`⏳ *MEMERIKSA NOMOR MATI/BANNED...*\nMenghubungi server Meta untuk ${nodes.length} nomor.`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        let deadCount = 0; let processed = 0;
        
        for (let i = 0; i < nodes.length; i++) {
            processed++;
            if (processed % 10 === 0) {
                await safeEditMessageText(`🧹 *PEMBERSIHAN BERJALAN*\n\n🔄 Memeriksa: ${processed}/${nodes.length}\n❌ Dihapus: ${deadCount} Nomor Mati`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{});
            }
            const jid = `${nodes[i].number}@s.whatsapp.net`;
            try {
                const [res] = await sock.onWhatsApp(jid);
                if (!res || !res.exists) {
                    await dbRun('DELETE FROM wa_nodes WHERE number = ?', [nodes[i].number]);
                    await dbRun('DELETE FROM user_assigned_numbers WHERE number = ?', [nodes[i].number]);
                    await dbRun('DELETE FROM used_numbers WHERE number = ?', [nodes[i].number]);
                    deadCount++;
                }
            } catch(e) {}
            await delay(300); 
        }
        return safeEditMessageText(`✅ *PEMBERSIHAN SELESAI*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n📊 Total Diperiksa : ${nodes.length}\n🗑️ Dihapus : *${deadCount}* Nomor Mati\n🟢 Sisa Stok : ${nodes.length - deadCount}`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
    }

    if (action === 'cmd_delete_all') {
        return safeEditMessageText("⚠️ *KONFIRMASI RESET DATABASE*\nSeluruh nomor WA dari semua akun akan dikembalikan ke server (Purge).", { 
            chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', 
            reply_markup: { inline_keyboard: [ 
                [{ text: '⚠️ YA, KOSONGKAN SEMUA', callback_data: 'cmd_confirm_delete_all' }], 
                [{ text: '❌ Batal', callback_data: 'cmd_cancel' }] 
            ]} 
        });
    }

    if (action === 'cmd_confirm_delete_all') {
        await safeEditMessageText("⏳ *MENGEMBALIKAN NOMOR KE SERVER...*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        for (const [, acc] of activeSessions.entries()) { await acc.returnAllNumbers(); }
        await dbRun('DELETE FROM wa_nodes'); 
        await dbRun('DELETE FROM user_assigned_numbers'); 
        await dbRun('DELETE FROM used_numbers');
        return safeEditMessageText(`✅ *RESET SELESAI*\nDatabase lokal dikosongkan total.`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
    }

    if (action === 'cmd_status') {
        const countRow = await dbGet('SELECT COUNT(*) as count FROM wa_nodes');
        const userCountRow = await dbGet('SELECT COUNT(*) as count FROM whitelisted_users');
        const assignedCountRow = await dbGet('SELECT COUNT(*) as count FROM user_assigned_numbers');
        const lockedCountRow = await dbGet('SELECT COUNT(*) as count FROM used_numbers');
        const totalAccs = await dbGet('SELECT COUNT(*) as count FROM ivas_accounts');
        const activeAccs = getActiveAccounts();
        
        let statusMsg = `⚙️ *STATUS SERVER BOT OTP*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        statusMsg += `🟢 *Akun API Aktif    :* ${activeAccs.length} / ${totalAccs.count}\n`;
        statusMsg += `🤖 *Filter WhatsApp  :* ${sock?.authState?.creds?.registered ? 'AKTIF ✅' : 'NONAKTIF ❌'}\n\n`;
        statusMsg += `🗃 *Total Stok WA    :* ${countRow.count} Nomor\n`;
        statusMsg += `👥 *Total Klien OTP  :* ${userCountRow.count} Orang\n`;
        statusMsg += `📱 *Nomor Disewa     :* ${assignedCountRow.count} Nomor\n`;
        statusMsg += `🔐 *Nomor Dihanguskan:* ${lockedCountRow.count} Nomor\n\n`;
        
        if (activeAccs.length > 0) {
            statusMsg += `📋 *Detail Akun Aktif:*\n`;
            for (const [id, acc] of activeAccs) {
                const label = (await dbGet('SELECT label FROM ivas_accounts WHERE id = ?', [id]))?.label || 'No Label';
                statusMsg += `  └ ID \`${id}\` | ${label}\n`;
            }
        }
        return safeEditMessageText(statusMsg, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
    }

    if (action === 'cmd_search') {
        userStates[chatId].state = 'WAITING_NUMBER';
        return safeEditMessageText(`🔍 *CARI RIWAYAT OTP*\nMasukkan nomor WhatsApp target\n(Contoh: \`628123456789\`)`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getCancelMarkup() });
    }

    if (action === 'cmd_wa_login') {
        if (fs.existsSync('./auth_info_baileys/creds.json')) return bot.answerCallbackQuery(query.id, { text: 'Bot Filter WhatsApp sudah terhubung.', show_alert: true });
        userStates[chatId].state = 'WAITING_WA_PHONE';
        return safeEditMessageText("📱 *HUBUNGKAN BOT FILTER WHATSAPP*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\nMasukkan nomor akun WA Bot.\n_(Sertakan kode negara tanpa +, misal: 628xxx)_", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getCancelMarkup() });
    }

    if (action === 'cmd_wa_logout') {
        if (fs.existsSync('./auth_info_baileys/creds.json')) {
            await safeEditMessageText("⏳ *MEMUTUSKAN WA BOT...*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
            try { if (sock) await sock.logout(); } catch(e) {}
            if (fs.existsSync('./auth_info_baileys')) fs.rmSync('./auth_info_baileys', { recursive: true, force: true });
            sock = null; isConnectingWA = false;
            safeEditMessageText("✅ *BOT FILTER WA TERPUTUS*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        } else {
            safeEditMessageText("⚠️ *BOT WA BELUM TERHUBUNG*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        }
        return;
    }

    if (action === 'cmd_cancel') { 
        userStates[chatId].state = 'IDLE'; 
        return safeEditMessageText("🔥 *PANEL ADMIN BOT OTP* 🔥\n━━━━━━━━━━━━━━━━━━━━━━━━━━\nOperasi dibatalkan.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() }); 
    }

    if (action.startsWith('start_')) {
        if (!sock?.authState?.creds?.registered) return bot.answerCallbackQuery(query.id, { text: '⚠️ Bot WhatsApp Filter belum terhubung!', show_alert: true });
        const parts = action.split('_'); 
        const mode = parts[parts.length - 1]; 
        const jobId = parts.slice(1, parts.length - 1).join('_');
        const numbersList = jobQueue.get(jobId);
        if (!numbersList) return bot.answerCallbackQuery(query.id, { text: 'Data file kadaluarsa, silakan upload ulang TXT.', show_alert: true });
        safeEditMessageText(`⏳ *MEMULAI FILTER MASSAL WA*\n⚙️ Mode: *${mode.toUpperCase()}*\n📊 Total: *${numbersList.length}* Nomor`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        processBulkCheck(numbersList, SPEED_MODES[mode], chatId, msgId);
        jobQueue.delete(jobId);
        return;
    }
});

// ─── TELEGRAM: MESSAGE HANDLER ─────────────────────────────────────────────
bot.on('message', async (msg) => {
    const chatId = msg.chat.id.toString();
    const text = msg.text;
    if (!text || text.startsWith('/')) return;
    bot.deleteMessage(chatId, msg.message_id).catch(() => {});
    if (!isAdmin(chatId) || !userStates[chatId]) return;
    const { state: currentState, lastMsgId: menuMsgId } = userStates[chatId];

    if (currentState === 'WAITING_RAW_COOKIE') {
        if (!text.includes('ivas_sms_session=')) {
            return safeEditMessageText("❌ *FORMAT SALAH*\nCookie tidak valid. Pastikan teks mengandung `ivas_sms_session=`.", { 
                chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getCancelMarkup() 
            });
        }
        
        userStates[chatId].tempCookies = text.trim();
        userStates[chatId].state = 'WAITING_LABEL';
        
        return safeEditMessageText("✅ *COOKIE DITERIMA*\nSilakan kirimkan *Label / Nama* untuk akun ini (contoh: `Akun Utama`).", { 
            chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getCancelMarkup() 
        });
    } 

    else if (currentState === 'WAITING_LABEL') {
        const label = text.trim();
        const cookiesStr = userStates[chatId].tempCookies;
        userStates[chatId].state = 'IDLE'; 
        
        await safeEditMessageText("⏳ *MENYIMPAN AKUN API...*", { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown' });
        
        const res = await dbRun('INSERT INTO ivas_accounts (cookies, label, added_at) VALUES (?, ?, ?)', [cookiesStr, label, new Date().toISOString()]);
        const accountId = res.lastID;
        
        const account = new IVASAccount(accountId, cookiesStr);
        if (await account.initSession()) {
            activeSessions.set(accountId, account);
            const myNumbers = await account.getMyNumbers();
            
            if (myNumbers.length > 0) {
                await autoFilterAndSaveNumbers(chatId, myNumbers, menuMsgId, accountId);
            } else {
                safeEditMessageText(`✅ *AKUN API BERHASIL DITAMBAHKAN*\nID Akun: \`${accountId}\` | Label: ${label}\nStok nomor bawaan: 0.`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
            }
        } else {
            await dbRun('DELETE FROM ivas_accounts WHERE id = ?', [accountId]);
            safeEditMessageText("❌ *GAGAL AUTENTIKASI*\nCookie salah, diblokir Cloudflare, atau telah expired. Akun tidak disimpan.", { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        }
        return;
    }

    else if (currentState === 'WAITING_RANGE') {
        userStates[chatId].state = 'IDLE'; 
        const targetRange = text.trim(); 
        try {
            let foundNumbers = [];
            const activeAccs = getActiveAccounts();
            for (const [accId, acc] of activeAccs) {
                await safeEditMessageText(`🔍 *MENCARI STOK...*\nMemeriksa Akun ID: \`${accId}\``, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown' }).catch(()=>{});
                const nums = await acc.getTestNumbersByRange(targetRange);
                if (nums.length > 0) { nums.forEach(n => n.accId = accId); foundNumbers = foundNumbers.concat(nums); }
            }
            if (foundNumbers.length > 0) {
                let reply = `✅ *STOK DITEMUKAN: ${targetRange}*\n\n👇 *Pilih Nomor WA yang ingin dibeli:*`;
                const inline_keyboard = foundNumbers.slice(0, 10).map((n) => [{ 
                    text: `📱 +${n.number} ($${n.rate}) - Akun ${n.accId}`, 
                    callback_data: `term_detail_${n.id}_${n.accId}` 
                }]);
                inline_keyboard.push([{ text: '❌ Batal', callback_data: 'cmd_cancel' }]);
                safeEditMessageText(reply, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard } });
            } else {
                safeEditMessageText(`❌ *STOK KOSONG*\nTidak ada stok untuk rentang \`${targetRange}\`.`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
            }
        } catch (e) { 
            safeEditMessageText(`⚠️ *ERROR*: ${e.message}`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() }); 
        }
    }

    else if (currentState === 'WAITING_NUMBER') {
        userStates[chatId].state = 'IDLE'; 
        const targetNumber = text.trim(); 
        const todayStr = getTodayUTC();
        try {
            let foundMsgs = null; 
            const dbRegionRow = await dbGet('SELECT range_name, account_id FROM wa_nodes WHERE number = ?', [targetNumber]);

            if (dbRegionRow) {
                await safeEditMessageText(`⚡ *MENGUNDUH LOG SMS...*`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown' });
                const acc = activeSessions.get(dbRegionRow.account_id) || getFirstActiveAccount();
                if (acc) foundMsgs = await acc.getMessages(targetNumber, dbRegionRow.range_name, todayStr);
            } else {
                const activeAccs = getActiveAccounts();
                for (const [accId, acc] of activeAccs) {
                    await safeEditMessageText(`🔍 *MENCARI...*\nMemeriksa Akun ID: \`${accId}\``, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown' }).catch(()=>{});
                    const checkData = await acc.getCountries(todayStr);
                    for (const c of checkData.countries) {
                        const numbersInCountry = await acc.getNumbers(c, todayStr);
                        if (numbersInCountry.includes(targetNumber)) { 
                            foundMsgs = await acc.getMessages(targetNumber, c, todayStr); 
                            break; 
                        }
                    }
                    if (foundMsgs) break;
                }
            }

            if (foundMsgs && foundMsgs.length > 0) {
                for (const m of foundMsgs) {
                    const card = formatMessageCard(m, true); 
                    await bot.sendMessage(chatId, card.text, { parse_mode: 'Markdown', reply_markup: card.reply_markup });
                }
                safeEditMessageText(`✅ *PENCARIAN RIWAYAT SELESAI*`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
            } else {
                safeEditMessageText(`❌ *TIDAK ADA RIWAYAT OTP*\nNomor \`+${targetNumber}\` belum pernah menerima SMS hari ini.`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
            }
        } catch (e) { 
            safeEditMessageText(`⚠️ *ERROR*: ${e.message}`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() }); 
        }
    }

    else if (currentState === 'WAITING_WA_PHONE') {
        userStates[chatId].state = 'IDLE'; 
        const phoneNumber = text.replace(/\D/g, '');
        if (phoneNumber.length < 8) return safeEditMessageText("❌ *FORMAT SALAH*\nNomor terlalu pendek.", { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        await safeEditMessageText(`⏳ Menyiapkan Bot WA untuk \`${phoneNumber}\`...`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown' });
        startWA(phoneNumber, chatId, menuMsgId);
    }
});

// ─── TELEGRAM: DOCUMENT HANDLER (Bulk TXT) ────────────────────────────────
bot.on('document', async (msg) => {
    const chatId = msg.chat.id.toString();
    if (!isAdmin(chatId)) return;
    bot.deleteMessage(chatId, msg.message_id).catch(()=>{});

    if (!sock?.authState?.creds?.registered) {
        const sm = await bot.sendMessage(chatId, '⚠️ *Bot Filter WhatsApp belum aktif!*\nHubungkan WhatsApp Meta di menu utama terlebih dahulu.', { parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        if (userStates[chatId]) userStates[chatId].lastMsgId = sm.message_id;
        return;
    }
    if (!msg.document.file_name.endsWith('.txt')) {
        const sm = await bot.sendMessage(chatId, '❌ *FORMAT FILE DITOLAK*\nSistem hanya menerima file berekstensi .txt', { parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        if (userStates[chatId]) userStates[chatId].lastMsgId = sm.message_id;
        return;
    }

    try {
        const fileLink = await bot.getFileLink(msg.document.file_id);
        const res = await axios.get(fileLink);
        let rawNumbers = res.data.split('\n').map(n => n.replace(/\D/g, '')).filter(n => n.length > 8);
        const uniqueNumbers = [...new Set(rawNumbers.map(n => n.startsWith('0') ? '62' + n.slice(1) : n))];
        
        if (uniqueNumbers.length === 0) {
            const sm = await bot.sendMessage(chatId, '❌ *FILE KOSONG*\nTidak ada nomor telepon valid ditemukan.', { parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
            if (userStates[chatId]) userStates[chatId].lastMsgId = sm.message_id;
            return;
        }
        
        const jobId = Date.now().toString(); 
        jobQueue.set(jobId, uniqueNumbers);
        const sm = await bot.sendMessage(chatId, `📁 *FILE TXT DITERIMA*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\nTotal: *${uniqueNumbers.length}* Nomor Telepon.\n\nPilih kecepatan ekstraksi:`, { 
            parse_mode: 'Markdown', 
            reply_markup: { inline_keyboard: [[ 
                { text: '🚀 Turbo', callback_data: `start_${jobId}_fast` }, 
                { text: '🚗 Normal', callback_data: `start_${jobId}_normal` }, 
                { text: '🚲 Siluman', callback_data: `start_${jobId}_slow` }
            ]]} 
        });
        if (userStates[chatId]) userStates[chatId].lastMsgId = sm.message_id;
    } catch (e) { 
        const sm = await bot.sendMessage(chatId, `❌ *GAGAL MEMBACA FILE*: ${e.message}`, { reply_markup: getMainMenuMarkup() }); 
        if (userStates[chatId]) userStates[chatId].lastMsgId = sm.message_id;
    }
});

// ─── INIT ──────────────────────────────────────────────────────────────────
(async () => {
    console.log('[SISTEM] Menyiapkan Basis Data Provider OTP...');
    const accounts = await dbAll('SELECT * FROM ivas_accounts');
    let loadedCount = 0;
    
    for (const accData of accounts) {
        let cookieStr = accData.cookies;
        
        try {
            const parsed = JSON.parse(cookieStr);
            if (typeof parsed === 'object' && parsed !== null) {
                cookieStr = parsed['Cookie'] || parsed['cookie'] || cookieStr;
            }
        } catch(e) {
        }

        const account = new IVASAccount(accData.id, cookieStr);
        if (await account.initSession()) {
            activeSessions.set(accData.id, account);
            loadedCount++;
            console.log(`[API] Akun ID ${accData.id} (${accData.label || 'No Label'}) Terhubung.`);
        } else {
            console.log(`[API] Akun ID ${accData.id} GAGAL (expired/invalid).`);
        }
    }
    
    console.log(`[SISTEM] ${loadedCount}/${accounts.length} Akun API aktif.`);
    pollAllAccounts();
    
    console.log('[SISTEM] Memeriksa Modul WhatsApp...');
    if (fs.existsSync('./auth_info_baileys/creds.json')) startWA();
    
    console.log('[SISTEM] Bot OTP siap melayani.');
})();
