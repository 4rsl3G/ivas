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

const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { 
    polling: { interval: 300, autoStart: true, params: { timeout: 10 } },
    request: { family: 4 }
});

const POLLING_INTERVAL = process.env.POLLING_INTERVAL || 5000;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? process.env.ADMIN_CHAT_ID.trim() : null; 
const REQUIRED_CHANNEL_ID = process.env.REQUIRED_CHANNEL_ID ? process.env.REQUIRED_CHANNEL_ID.trim() : null;
const REQUIRED_CHANNEL_LINK = process.env.REQUIRED_CHANNEL_LINK ? process.env.REQUIRED_CHANNEL_LINK.trim() : 'https://t.me/yourchannel';

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

// ⚡ Optimasi SQLite untuk Skala Enterprise (Ribuan User)
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

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function getTodayUTC() { return new Date().toISOString().split('T')[0]; }
function isAdmin(chatId) { return ADMIN_CHAT_ID && chatId.toString() === ADMIN_CHAT_ID; }

async function checkForceSub(chatId) {
    if (!REQUIRED_CHANNEL_ID || isAdmin(chatId)) return true; 
    const now = Date.now();
    if (forceSubCache.has(chatId)) {
        const cached = forceSubCache.get(chatId);
        if (now - cached.timestamp < CACHE_TTL) return cached.status;
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

// 🎛️ Dasbor Admin yang Diperbarui
const getMainMenuMarkup = () => ({
    inline_keyboard: [
        [{ text: '🔑 Tambah Akun IVAS', callback_data: 'cmd_login' }, { text: '🗃 Sinkronisasi Global', callback_data: 'cmd_sync_db' }],
        [{ text: '📢 Siarkan Rentang Aktif', callback_data: 'cmd_active_ranges' }, { text: '🛒 Telusuri Lintas Akun', callback_data: 'cmd_search_range' }],
        [{ text: '📡 Eksekusi Otomatis (Turbo)', callback_data: 'cmd_hunt_wa' }, { text: '📱 Data Node Meta', callback_data: 'cmd_get_wa_numbers_0' }],
        [{ text: '🧹 Purge Node Mati', callback_data: 'cmd_clean_dead_nodes' }, { text: '🗑 Purge Semua Akun', callback_data: 'cmd_delete_all' }],
        [{ text: '🔗 Hubungkan Meta', callback_data: 'cmd_wa_login' }, { text: '🔌 Putuskan Meta', callback_data: 'cmd_wa_logout' }],
        [{ text: '⚙️ Status Server', callback_data: 'cmd_status' }, { text: '🔍 Kotak Masuk Global', callback_data: 'cmd_search' }]
    ]
});

const getUserMenuMarkup = () => ({ inline_keyboard: [[{ text: '📱 Alokasikan Nomor Baru', callback_data: 'user_get_number' }]] });
const getCancelMarkup = () => ({ inline_keyboard: [[{ text: '❌ Batalkan Operasi', callback_data: 'cmd_cancel' }]] });

function formatMessageCard(msgData) {
    const otpMatch = msgData.text.match(/\b\d{3}[-\s]?\d{3}\b/) || msgData.text.match(/\b\d{4,8}\b/);
    const cleanOtp = otpMatch ? otpMatch[0].replace(/\D/g, '') : null;
    let text = `✦ *GERBANG OTP AMAN* ✦\n━━━━━━━━━━━━━━━━━━━━━━\n📱 𝗡𝗼𝗺𝗼𝗿  : \`${msgData.phoneNumber}\`\n🌍 𝗪𝗶𝗹𝗮𝘆𝗮𝗵 : ${msgData.countryRange}\n📨 𝗣𝗲𝗻𝗴𝗶𝗿𝗶𝗺: ${msgData.sender}\n⏱ 𝗪𝗮𝗸𝘁𝘂   : ${msgData.time} (UTC)\n━━━━━━━━━━━━━━━━━━━━━━\n💬 𝗣𝗲𝘀𝗮𝗻 :\n_${msgData.text}_\n`;
    if (cleanOtp) text += `\n🔑 *OTP Terekstrak* : \`${cleanOtp}\``;
    const inline_keyboard = [];
    if (cleanOtp) inline_keyboard.push([{ text: `📋 Salin OTP: ${cleanOtp}`, callback_data: 'dummy_btn' }]);
    inline_keyboard.push([{ text: '🤖 Kembali ke Dasbor Utama', url: `https://t.me/${process.env.BOT_USERNAME || 'bot'}` }]); 
    return { text, reply_markup: { inline_keyboard } };
}

async function safeEditMessageText(text, options) {
    try { await bot.editMessageText(text, options); } catch (e) { if (!e.message.includes('message is not modified')) console.error(e.message); }
}

class IVASAccount {
    constructor(accountId, cookies) {
        this.accountId = accountId;
        this.cookies = cookies;
        this.jar = new CookieJar();
        this.client = wrapper(axios.create({
            jar: this.jar, baseURL: 'https://www.ivasms.com', timeout: 15000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'application/json, text/javascript, */*; q=0.01' }
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
            const res = await this.client.get(`/portal/numbers?${params.toString()}`, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
            if (res.status === 200 && res.data && res.data.data) return res.data.data.map(item => ({ number: item.Number.toString(), range: item.range }));
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
            const res = await this.client.get(`/portal/sms/test/sms?${params.toString()}`, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
            if (res.status === 200 && res.data && res.data.data) return res.data.data;
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
            const res = await this.client.get(`/portal/numbers/test?${params.toString()}`, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
            if (res.status === 200 && res.data && res.data.data) return res.data.data.map(item => ({ id: item.id, number: item.test_number, rate: item.A2P }));
            return [];
        } catch (e) { return []; }
    }
    async getTerminationDetails(id) {
        try {
            const payload = new URLSearchParams({ 'id': id, '_token': this.csrfToken });
            const res = await this.client.post('/portal/numbers/termination/details', payload.toString(), { headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } });
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
            const res = await this.client.post('/portal/numbers/termination/number/add', payload.toString(), { headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } });
            if (res.status === 200 && res.data) return res.data;
            return null;
        } catch (e) { return null; }
    }
    async getCountries(dateStr) {
        try {
            const payload = new URLSearchParams({ 'from': dateStr, 'to': dateStr, '_token': this.csrfToken });
            const res = await this.client.post('/portal/sms/received/getsms', payload.toString(), { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
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
            const res = await this.client.post('/portal/sms/received/getsms/number', payload.toString(), { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
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
            const res = await this.client.post('/portal/sms/received/getsms/number/sms', payload.toString(), { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
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
            const res = await this.client.post('/portal/numbers/return/allnumber/bluck', payload.toString(), { headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } });
            if (res.status === 200 && res.data) return res.data;
            return null;
        } catch (e) { return null; }
    }
}

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

    if (phoneNumberForPairing && !sock.authState.creds.registered) {
        await notifyUI(`❖ *INTEGRASI META*\n⏳ Meminta kode pemasangan untuk: \`${phoneNumberForPairing}\``);
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumberForPairing);
                const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
                await notifyUI(`✅ *KODE PEMASANGAN SIAP*\n🔑 \`${formattedCode}\`\n\n1️⃣ Buka WA > Perangkat Tertaut\n2️⃣ Tautkan dengan nomor telepon\n3️⃣ Masukkan kode.`);
            } catch (error) { await notifyUI(`❌ *GAGAL*\n${error.message}`); isConnectingWA = false; }
        }, 4000); 
    }

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
            if (msgId || phoneNumberForPairing) await notifyUI('✅ *SINKRONISASI META BERHASIL*'); 
        }
    });
}

async function autoFilterAndSaveNumbers(chatId, numbersObjArray, msgId, accountId) {
    if (!numbersObjArray || numbersObjArray.length === 0) return;
    
    if (!sock?.authState?.creds?.registered) {
        await safeEditMessageText(`⚠️ *META TERPUTUS*\nMenyimpan ${numbersObjArray.length} Node secara instan tanpa filter WA...`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        const placeholders = numbersObjArray.map(() => '(?, ?, ?)').join(', ');
        const values = numbersObjArray.flatMap(n => [n.number, accountId, n.range]);
        await dbRun(`INSERT OR IGNORE INTO wa_nodes (number, account_id, range_name) VALUES ${placeholders}`, values);
        await safeEditMessageText(`✅ *SINKRONISASI SELESAI*\n${numbersObjArray.length} data diamankan ke Akun ID: ${accountId}.`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        return;
    }

    const CONCURRENCY = 20; let activeCount = 0; let processed = 0; const total = numbersObjArray.length;
    await safeEditMessageText(`⚡ *MESIN PENYARINGAN AKTIF*\nMemproses ${total} data melalui Server WhatsApp...`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });

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
        
        safeEditMessageText(`⚡ *MENYARING LINTAS AKUN...*\nAkun ID: ${accountId}\n\n🔄 Progres: ${processed}/${total} Node\n✅ Terverifikasi WA: *${activeCount}*`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(() => {});
        await delay(300);
    }
    
    await safeEditMessageText(`✅ *OPERASI PENYARINGAN SELESAI*\n━━━━━━━━━━━━━━━━━━━━━━\nTotal Pemindaian : ${total}\nWA Terverifikasi : *${activeCount}* data\n_(Via Akun ID: ${accountId})_`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
}

async function assignRandomNumberToUser(userChatId) {
    const existing = await dbGet('SELECT number, range_name FROM user_assigned_numbers WHERE user_chat_id = ?', [userChatId]);
    if (existing) return existing; 
    const row = await dbGet(`SELECT number, range_name FROM wa_nodes WHERE number NOT IN (SELECT number FROM user_assigned_numbers) AND number NOT IN (SELECT number FROM used_numbers WHERE user_chat_id != ?) ORDER BY RANDOM() LIMIT 1`, [userChatId]);
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
        if (messages && messages.length > 0) return messages[messages.length - 1]; 
    } catch (e) {}
    return null;
}

function stopOtpPolling(userChatId) {
    const existing = activeOtpPolling.get(userChatId);
    if (existing) { clearTimeout(existing.timeoutId); activeOtpPolling.delete(userChatId); }
}

async function startOtpPolling(userChatId, number, rangeName, msgId) {
    stopOtpPolling(userChatId);
    let attempts = 0; const MAX_ATTEMPTS = 24; const lastSeenId = userStates[userChatId]?.lastSeenMsgId;

    const poll = async () => {
        attempts++; const elapsed = attempts * 5;
        await safeEditMessageText(`🔄 *PEMANTAUAN NODE AKTIF*\n━━━━━━━━━━━━━━━━━━━━━━\n📱 𝗡𝗼𝗺𝗼𝗿  : \`${number}\`\n🌍 𝗪𝗶𝗹𝗮𝘆𝗮𝗵 : ${rangeName}\n\n⏳ Iterasi ke-${attempts} (${elapsed} detik)...`, { chat_id: userChatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Batalkan Operasi', callback_data: 'user_cancel_otp' }]] } }).catch(() => {});

        const msg = await checkOtpForNumber(number, rangeName);
        const currentMsgId = msg ? `${msg.time}_${msg.text}` : null;
        
        if (msg && currentMsgId !== lastSeenId) {
            stopOtpPolling(userChatId);
            if (!userStates[userChatId]) userStates[userChatId] = {};
            userStates[userChatId].lastSeenMsgId = currentMsgId;
            await dbRun(`INSERT OR REPLACE INTO used_numbers (number, user_chat_id) VALUES (?, ?)`, [number, userChatId]);

            const otpMatch = msg.text.match(/\b\d{4,8}\b/g); const otp = otpMatch ? otpMatch[0] : null;
            let replyText = `✦ *OTP BARU DITERIMA* ✦\n━━━━━━━━━━━━━━━━━━━━━━\n📱 𝗡𝗼𝗺𝗼𝗿   : \`${number}\`\n📨 𝗣𝗲𝗻𝗴𝗶𝗿𝗶𝗺 : ${msg.sender}\n⏱ 𝗪𝗮𝗸𝘁𝘂    : ${msg.time} (UTC)\n🔐 *Status  : Node Terkunci*\n\n💬 𝗣𝗲𝘀𝗮𝗻 :\n_${msg.text}_\n`;
            if (otp) replyText += `━━━━━━━━━━━━━━━━━━━━━━\n🔑 *OTP Terekstrak : \`${otp}\`*`;

            await safeEditMessageText(replyText, { chat_id: userChatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [ otp ? [{ text: `📋 Salin OTP: ${otp}`, callback_data: 'dummy_btn' }] : [], [{ text: '🔄 Ajukan Nomor Baru', callback_data: 'user_new_number' }, { text: '🔁 Sinkronisasi Ulang', callback_data: 'user_get_otp' }] ].filter(r => r.length > 0) } }).catch(() => {});
            return;
        }

        if (attempts >= MAX_ATTEMPTS) {
            stopOtpPolling(userChatId);
            await safeEditMessageText(`⏰ *WAKTU HABIS (TIMEOUT)*\nTarget: \`${number}\`\nPastikan instruksi pengiriman OTP telah dieksekusi.`, { chat_id: userChatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔄 Ganti Nomor Lain', callback_data: 'user_new_number' }, { text: '🔁 Ulangi Pemantauan', callback_data: 'user_get_otp' }]] } }).catch(() => {});
            return;
        }
        const timeoutId = setTimeout(poll, 5000); activeOtpPolling.set(userChatId, { timeoutId, msgId });
    };
    const timeoutId = setTimeout(poll, 5000); activeOtpPolling.set(userChatId, { timeoutId, msgId });
}

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
        safeEditMessageText(`⏳ *EKSTRAKSI DATA MASSAL BERJALAN*\nProgres: ${processed} / ${total}\n_Jeda sistem ${config.delay/1000} detik..._`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }); 
        if (processed < total) await delay(config.delay);
    }
    
    safeEditMessageText(`✅ *EKSTRAKSI SELESAI*\n━━━━━━━━━━━━━━━━━━━━━━\n📊 Total Dianalisis : ${total}\n👤 Akun Personal : *${countP}*\n🏢 Akun Bisnis : *${countB}*\n❌ Tidak Terdaftar : *${countU}*`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
    if (countP > 0) bot.sendDocument(chatId, Buffer.from(resPersonal, 'utf-8'), {}, { filename: `Personal_Lead_${Date.now()}.txt`, contentType: 'text/plain' });
    if (countB > 0) bot.sendDocument(chatId, Buffer.from(resBisnis, 'utf-8'), {}, { filename: `Business_Lead_${Date.now()}.txt`, contentType: 'text/plain' });
    if (countU > 0) bot.sendDocument(chatId, Buffer.from(resUnreg, 'utf-8'), {}, { filename: `Unregistered_${Date.now()}.txt`, contentType: 'text/plain' });
}

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
                            if (!isSeen) { await dbRun('INSERT INTO seen_ids (msg_id, account_id) VALUES (?, ?)', [msgId, accountId]); hasNew = true; }
                        }
                    }
                }
                if (hasNew) await dbRun(`DELETE FROM seen_ids WHERE rowid NOT IN (SELECT rowid FROM seen_ids WHERE account_id = ? ORDER BY rowid DESC LIMIT 1000)`, [accountId]);
            } catch (e) {
                if (e.response && (e.response.status === 401 || e.response.status === 403)) { account.loggedIn = false; activeSessions.delete(accountId); }
            }
        }
    } finally { setTimeout(pollAllAccounts, POLLING_INTERVAL); }
}

bot.onText(/\/(start|menu)/, async (msg) => {
    const chatId = msg.chat.id.toString();
    bot.deleteMessage(chatId, msg.message_id).catch(()=>{});
    if (!isAdmin(chatId)) await dbRun('INSERT OR IGNORE INTO whitelisted_users (chat_id, username, added_at) VALUES (?, ?, ?)', [chatId, msg.from.username || msg.from.first_name || 'Pengguna Publik', new Date().toISOString()]);
    
    if (isAdmin(chatId)) {
        const sentMsg = await bot.sendMessage(chatId, `❖ *RUANG KERJA PANSA AI* ❖\n━━━━━━━━━━━━━━━━━━━━━━\nSelamat datang di Panel Kendali. Multi-Akun Aktif: ${activeSessions.size}`, { parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        userStates[chatId] = { state: 'IDLE', lastMsgId: sentMsg.message_id };
    } else {
        if (!(await checkForceSub(chatId))) return sendForceSubMessage(chatId);
        const sentMsg = await bot.sendMessage(chatId, `❖ *PORTAL KLIEN PANSA* ❖\n━━━━━━━━━━━━━━━━━━━━━━\nAkses terverifikasi. Anda terhubung dengan Infrastruktur API kami.`, { parse_mode: 'Markdown', reply_markup: getUserMenuMarkup() });
        userStates[chatId] = { state: 'IDLE', lastMsgId: sentMsg.message_id };
    }
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id.toString(); const msgId = query.message.message_id; const action = query.data;
    bot.answerCallbackQuery(query.id);

    if (action === 'dummy_btn') return; 
    if (action === 'check_join') {
        if (await checkForceSub(chatId)) {
            bot.answerCallbackQuery(query.id, { text: "✅ Verifikasi berhasil!" });
            return safeEditMessageText(`❖ *PORTAL KLIEN PANSA* ❖\nAkses terverifikasi.`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: !isAdmin(chatId) ? getUserMenuMarkup() : getMainMenuMarkup() });
        } else return bot.answerCallbackQuery(query.id, { text: "❌ Anda belum berada di Kanal Resmi!", show_alert: true });
    }

    if (!isAdmin(chatId) && !(await checkForceSub(chatId))) return sendForceSubMessage(chatId, msgId);

    if (action === 'user_get_number' || action === 'user_new_number') {
        if (action === 'user_new_number') { stopOtpPolling(chatId); await releaseNumberFromUser(chatId); }
        if (activeSessions.size === 0) return safeEditMessageText("⚠️ *SISTEM LURING (OFFLINE)*\nInfrastruktur API kosong.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: !isAdmin(chatId) ? getUserMenuMarkup() : getMainMenuMarkup() });

        await safeEditMessageText("🔄 *MENGEKSEKUSI PERMINTAAN*\nMengalokasikan *jalur khusus (dedicated line)*...", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        const assigned = await assignRandomNumberToUser(chatId);
        if (!assigned) return safeEditMessageText("❌ *SUMBER DAYA HABIS*\nNode sedang dioperasikan pengguna lain.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔄 Ajukan Ulang', callback_data: 'user_get_number' }]] } });

        userStates[chatId] = { ...userStates[chatId], assignedNumber: assigned.number, assignedRange: assigned.range_name, lastSeenMsgId: null };
        await safeEditMessageText(`✅ *SUMBER DAYA DIALOKASIKAN*\n━━━━━━━━━━━━━━━━━━━━━━\n📱 𝗡𝗼𝗺𝗼𝗿  : \`${assigned.number}\`\n🌍 𝗪𝗶𝗹𝗮𝘆𝗮𝗵 : ${assigned.range_name}\n\n💡 _Node disiapkan._`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [ [{ text: `📋 Salin: ${assigned.number}`, callback_data: 'dummy_btn' }], [{ text: '📨 Mulai Pemantauan OTP', callback_data: 'user_get_otp' }], [{ text: '🔄 Buat Ulang Jalur', callback_data: 'user_new_number' }] ] } });
        return;
    }
    if (action === 'user_get_otp') {
        const state = userStates[chatId]; let number = state?.assignedNumber; let rangeName = state?.assignedRange;
        if (!number || !rangeName) {
            const assigned = await dbGet('SELECT number, range_name FROM user_assigned_numbers WHERE user_chat_id = ?', [chatId]);
            if (!assigned) return safeEditMessageText("❌ *SESI TIDAK VALID*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: !isAdmin(chatId) ? getUserMenuMarkup() : getMainMenuMarkup() });
            userStates[chatId] = { ...userStates[chatId], assignedNumber: assigned.number, assignedRange: assigned.range_name };
        }
        await safeEditMessageText(`🔍 *MEMULAI PEMANTAUAN NODE*\nTarget: \`${userStates[chatId].assignedNumber}\`\nSinkronisasi real-time dimulai...`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        startOtpPolling(chatId, userStates[chatId].assignedNumber, userStates[chatId].assignedRange, msgId);
        return;
    }
    if (action === 'user_cancel_otp') {
        stopOtpPolling(chatId);
        return safeEditMessageText(`✋ *PEMANTAUAN DIJEDA*\nNode masih diamankan:\n\`${userStates[chatId]?.assignedNumber || '-'}\``, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [ [{ text: '📨 Lanjutkan Pemantauan', callback_data: 'user_get_otp' }], [{ text: '🔄 Lepas & Buat Ulang', callback_data: 'user_new_number' }] ] } });
    }

    if (!isAdmin(chatId)) return;
    if (!userStates[chatId]) userStates[chatId] = { state: 'IDLE', lastMsgId: msgId };

    if (action === 'cmd_active_ranges') {
        const ranges = await dbAll('SELECT range_name, COUNT(*) as count FROM wa_nodes GROUP BY range_name ORDER BY count DESC');
        if (ranges.length === 0) return safeEditMessageText("⚠️ *TIDAK ADA DATA*\nBasis data *node* saat ini kosong.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        
        let text = `📢 *REKAP RENTANG AKTIF (ACTIVE RANGES)*\n━━━━━━━━━━━━━━━━━━━━━━\n`;
        ranges.forEach((r, i) => { text += `${i+1}. *${r.range_name}* - ${r.count} Node\n`; });
        text += `\n_Silakan salin teks di atas atau gunakan tombol di bawah untuk menyiarkan ke Kanal Resmi._`;

        const markup = { inline_keyboard: [ REQUIRED_CHANNEL_ID ? [{ text: '📤 Siarkan ke Kanal Resmi', callback_data: 'cmd_broadcast_ranges' }] : [], [{ text: '⬅️ Kembali ke Dasbor', callback_data: 'cmd_cancel' }] ] };
        return safeEditMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: markup });
    }

    if (action === 'cmd_broadcast_ranges') {
        const ranges = await dbAll('SELECT range_name, COUNT(*) as count FROM wa_nodes GROUP BY range_name ORDER BY count DESC');
        let text = `🔥 *UPDATE RENTANG NODE AKTIF* 🔥\n━━━━━━━━━━━━━━━━━━━━━━\nBot Infrastruktur OTP kami telah diisi ulang dengan *Dedicated Node* untuk wilayah berikut:\n\n`;
        let total = 0;
        ranges.forEach((r) => { text += `🌍 *${r.range_name}* : ✅ Tersedia\n`; total += r.count; });
        text += `\nTotal *${total}* Jalur siap disinkronisasi!\n\n👇 Akses Bot Sekarang: @${process.env.BOT_USERNAME || 'PansaBot'}`;
        
        try {
            await bot.sendMessage(REQUIRED_CHANNEL_ID, text, { parse_mode: 'Markdown' });
            safeEditMessageText("✅ *SIARAN BERHASIL DIKIRIM KE KANAL*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        } catch (e) { safeEditMessageText(`❌ *GAGAL MENYIARKAN*\nPastikan bot adalah Admin di Kanal. (${e.message})`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() }); }
        return;
    }

    if (action === 'cmd_login') {
        userStates[chatId].state = 'WAITING_COOKIE'; userStates[chatId].tempCookies = {};
        return safeEditMessageText("🔑 *TAMBAH AKUN IVAS BARU*\n━━━━━━━━━━━━━━━━━━━━━━\nInjeksi kuki untuk akun tambahan. Format: `nama=nilai`", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getCancelMarkup() });
    } 
    if (action === 'cmd_finish_login') {
        const cookiesObj = userStates[chatId].tempCookies;
        if (!cookiesObj['ivas_sms_session']) return safeEditMessageText("❌ *KESALAHAN FATAL*\nParameter `ivas_sms_session` wajib ada.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getCancelMarkup() });
        userStates[chatId].state = 'IDLE';
        
        await safeEditMessageText("⏳ *MENAMBAHKAN AKUN KE DATABASE...*\nSistem sedang memvalidasi sesi...", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        
        const res = await dbRun('INSERT INTO ivas_accounts (cookies, added_at) VALUES (?, ?)', [JSON.stringify(cookiesObj), new Date().toISOString()]);
        const accountId = res.lastID;
        const account = new IVASAccount(accountId, cookiesObj);
        
        if (await account.initSession()) {
            activeSessions.set(accountId, account);
            const myNumbers = await account.getMyNumbers();
            if (myNumbers.length > 0) {
                await autoFilterAndSaveNumbers(chatId, myNumbers, msgId, accountId);
            } else {
                safeEditMessageText(`✅ *AKUN DITAMBAHKAN*\nID Akun: ${accountId}. Node aktif: 0.`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
            }
        } else safeEditMessageText("❌ *AUTENTIKASI GAGAL*\nKuki tidak valid atau sudah kedaluwarsa.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        return;
    }
    
    if (action === 'cmd_sync_db') {
        if (activeSessions.size === 0) return safeEditMessageText("⚠️ *TIDAK ADA AKUN IVAS*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        await safeEditMessageText("⏳ *SINKRONISASI LINTAS AKUN*\nMempersiapkan penarikan data dari seluruh peladen...", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        
        await dbRun('DELETE FROM wa_nodes');
        let totalSynced = 0;
        let processedAccs = 0;
        const totalAccs = activeSessions.size;

        for (const [accId, acc] of activeSessions.entries()) {
            processedAccs++;
            await safeEditMessageText(`⏳ *SINKRONISASI LINTAS AKUN*\n\n🔄 Memproses Akun ID: ${accId} (${processedAccs}/${totalAccs} Akun)...\n_Tunggu sebentar, sedang menarik node..._`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{});
            
            const myNumbers = await acc.getMyNumbers();
            if(myNumbers.length > 0) {
                await autoFilterAndSaveNumbers(chatId, myNumbers, msgId, accId);
                totalSynced += myNumbers.length;
            }
        }
        safeEditMessageText(`✅ *SINKRONISASI GLOBAL SELESAI*\nTotal Data Terintegrasi: ${totalSynced} Node dari ${totalAccs} Akun.`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        return;
    }
    
    if (action.startsWith('cmd_get_wa_numbers_')) {
        const offset = parseInt(action.replace('cmd_get_wa_numbers_', '')) || 0; const limit = 3;
        try {
            const countRow = await dbGet('SELECT COUNT(*) as count FROM wa_nodes'); const total = countRow.count;
            if (total === 0) return safeEditMessageText("❌ *KUMPULAN DATA KOSONG*\nBasis Data Meta bersih.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });

            const currentOffset = offset >= total ? 0 : offset;
            const numbers = await dbAll('SELECT number, range_name, account_id FROM wa_nodes LIMIT ? OFFSET ?', [limit, currentOffset]);

            let text = `📱 *DATA NODE META TERVERIFIKASI*\nMenampilkan ${currentOffset + 1} - ${Math.min(currentOffset + limit, total)} dari total *${total}* rekaman.\n\n`;
            const inline_keyboard = [];
            numbers.forEach((n, i) => {
                text += `${currentOffset + i + 1}. 🌍 *${n.range_name}* (Akun: ${n.account_id})\n   └ 📱 \`${n.number}\`\n\n`;
                inline_keyboard.push([{ text: `📋 Ekstrak: ${n.number}`, callback_data: 'dummy_btn' }]);
            });

            const navButtons = [];
            if (total > limit) navButtons.push({ text: '🔄 Muat Lebih Banyak', callback_data: `cmd_get_wa_numbers_${currentOffset + limit}` });
            navButtons.push({ text: '⬅️ Kembali ke Dasbor', callback_data: 'cmd_cancel' });
            inline_keyboard.push(navButtons);
            safeEditMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard } });
        } catch (e) { safeEditMessageText(`⚠️ *KESALAHAN SISTEM*: ${e.message}`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() }); }
        return;
    }

    if (action === 'cmd_search_range') {
        if (activeSessions.size === 0) return safeEditMessageText("⚠️ *TIDAK ADA AKUN IVAS*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        userStates[chatId].state = 'WAITING_RANGE';
        return safeEditMessageText(`🛒 *TELUSURI RENTANG LINTAS AKUN*\nMasukkan string Rentang (misal: \`INDONESIA 232428\`).\nSistem memindai API dari semua akun IVAS secara bergiliran.`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getCancelMarkup() });
    }
    
    if (action.startsWith('term_detail_')) {
        const parts = action.split('_'); const termId = parts[2]; const accId = parseInt(parts[3]);
        const acc = activeSessions.get(accId);
        if (!acc) return safeEditMessageText("❌ Akun asal tidak ditemukan di sesi.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        
        await safeEditMessageText("⏳ *MENGAMBIL SPESIFIKASI NODE...*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        const details = await acc.getTerminationDetails(termId);
        if (details) {
            let detailText = `📄 *SPESIFIKASI TERMINASI*\n📌 *Rentang:* \`${details.rangeName}\`\n💵 *Hasil A2P:* ${details.a2pRate}\n🏢 *Akun Bot ID:* ${accId}\n\n📊 *Parameter Sistem:*\n`;
            details.limits.forEach(l => { detailText += `  └ *${l.key}:* ${l.val}\n`; });
            const detailMarkup = { inline_keyboard: [ [{ text: '➕ Eksekusi Beli (Via Akun Ini)', callback_data: `add_term_${termId}_${accId}` }], [{ text: '⬅️ Kembali', callback_data: 'cmd_cancel' }] ] };
            safeEditMessageText(detailText, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: detailMarkup });
        } else safeEditMessageText("❌ *KEGAGALAN API*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        return;
    }
    
    if (action.startsWith('add_term_')) {
        const parts = action.split('_'); const termId = parts[2]; const accId = parseInt(parts[3]);
        const acc = activeSessions.get(accId);
        await safeEditMessageText(`⏳ *MENGEKSEKUSI TRANSAKSI VIA AKUN ${accId}...*`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        
        const result = await acc.addNumber(termId);
        if (result && result.message) {
            const existingNums = await dbAll('SELECT number FROM wa_nodes WHERE account_id = ?', [accId]);
            const existingSet = new Set(existingNums.map(n => n.number));
            const allMyNumbers = await acc.getMyNumbers();
            const newNumbers = allMyNumbers.filter(n => !existingSet.has(n.number));
            
            if (newNumbers.length > 0) await autoFilterAndSaveNumbers(chatId, newNumbers, msgId, accId);
            else safeEditMessageText(`✅ *TRANSAKSI BERHASIL*\nStatus: ${result.message}`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        } else safeEditMessageText("❌ *TRANSAKSI GAGAL*\nLimit tercapai / Race Condition.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() }); 
        return;
    }
    
    // 📌 MESIN SNIPE YANG SUDAH BEBAS BUG
    if (action === 'cmd_hunt_wa') {
        if (activeSessions.size === 0) return safeEditMessageText("⚠️ *TIDAK ADA AKUN IVAS*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        
        const MAX_BUY = 10; 
        const MAX_RETRIES = 100; 
        
        await safeEditMessageText(`🎯 *MESIN EKSEKUSI OTOMATIS (TURBO)*\nMenginisialisasi pemantauan *Live Feed* kecepatan tinggi...`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });

        const globalUniqueRanges = new Set(); 
        const purchasedRanges = [];
        const accountArray = Array.from(activeSessions.entries()); 
        let currentAccIndex = 0; 
        const watcherAcc = accountArray[0][1];

        for (let i = 1; i <= MAX_RETRIES; i++) {
            if (i % 3 === 0 || i === 1) {
                await safeEditMessageText(`🎯 *MESIN EKSEKUSI OTOMATIS (TURBO)*\nMemantau *Live Feed* secara terpusat...\n\n🔄 Iterasi Pemantauan: ${i}/${MAX_RETRIES}\n📦 Diakuisisi Global: ${purchasedRanges.length}/${MAX_BUY} Node Unik`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{});
            }

            const data = await watcherAcc.fetchLiveTestSMS();
            for (const item of data) {
                const originatorText = String(item.originator || '').toLowerCase();
                const messageText = String(item.messagedata || '').toLowerCase();
                
                if (originatorText.includes('whatsapp') || originatorText.includes('wa') || messageText.includes('whatsapp')) {
                    if (!globalUniqueRanges.has(item.range)) {
                        globalUniqueRanges.add(item.range); 
                        const [buyerId, buyerAcc] = accountArray[currentAccIndex];
                        
                        await safeEditMessageText(`🎯 *TARGET TERKUNCI*\nRange: \`${item.range}\`\n_Mengeksekusi cepat via Akun ID: ${buyerId}..._`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{});
                        
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
            let reply = `✅ *EKSEKUSI TURBO SELESAI*\nBerhasil mengamankan ${purchasedRanges.length} Node Unik Lintas Akun:\n`;
            purchasedRanges.forEach((d, i) => { reply += `${i+1}. *${d.range}* (Via Akun ${d.accountId})\n`; });
            await safeEditMessageText(reply + `\n⏳ _Menginisialisasi Sinkronisasi Meta..._`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
            
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
        } else {
            safeEditMessageText(`❌ *OPERASI DIHENTIKAN*\nSiklus pemantauan selesai. Jaringan saat ini sepi dari *traffic* WhatsApp.`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        }
        return;
    }
    
    // 📌 FITUR BARU: AUTO-PURGE DEAD NODES
    if (action === 'cmd_clean_dead_nodes') {
        if (!sock?.authState?.creds?.registered) return safeEditMessageText("⚠️ *META TERPUTUS*\nSistem tidak dapat memverifikasi status nomor. Silakan hubungkan WhatsApp terlebih dahulu.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        
        const nodes = await dbAll('SELECT number FROM wa_nodes');
        if(nodes.length === 0) return safeEditMessageText("❌ *KUMPULAN DATA KOSONG*\nBasis data lokal tidak memiliki node untuk dipindai.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        
        await safeEditMessageText(`⏳ *MEMULAI PEMINDAIAN NODE MATI...*\nMemverifikasi ${nodes.length} data dengan peladen Meta secara langsung.`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        
        let deadCount = 0;
        let processed = 0;
        
        for(let i = 0; i < nodes.length; i++) {
            processed++;
            if (processed % 10 === 0) {
                await safeEditMessageText(`🧹 *PEMBERSIHAN BERJALAN*\n\n🔄 Memverifikasi: ${processed}/${nodes.length} Node\n❌ Dihapus: ${deadCount} (Tidak Terdaftar / Banned)`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{});
            }
            
            const jid = `${nodes[i].number}@s.whatsapp.net`;
            try {
                const [res] = await sock.onWhatsApp(jid);
                if(!res || !res.exists) {
                    await dbRun('DELETE FROM wa_nodes WHERE number = ?', [nodes[i].number]);
                    // Otomatis lepaskan dari sesi user jika ada
                    await dbRun('DELETE FROM user_assigned_numbers WHERE number = ?', [nodes[i].number]);
                    await dbRun('DELETE FROM used_numbers WHERE number = ?', [nodes[i].number]);
                    deadCount++;
                }
            } catch(e) {}
            await delay(300); // Hindari Rate Limit WA Socket
        }
        
        return safeEditMessageText(`✅ *PEMBERSIHAN SELESAI*\n━━━━━━━━━━━━━━━━━━━━━━\n📊 Total Diperiksa : ${nodes.length}\n🗑️ Berhasil Dihapus : *${deadCount}* Node Mati\n🟢 Sisa Node Aktif : ${nodes.length - deadCount}`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
    }

    if (action === 'cmd_delete_all') {
        const confirmMarkup = { inline_keyboard: [ [{ text: '⚠️ YA, KOSONGKAN SEMUA AKUN', callback_data: 'cmd_confirm_delete_all' }], [{ text: '❌ Batalkan Sekuens', callback_data: 'cmd_cancel' }] ] };
        return safeEditMessageText("⚠️ *TINDAKAN KRITIS TERDETEKSI*\nMem-*purge* (mengembalikan) seluruh node dari SEMUA AKUN secara serentak.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: confirmMarkup });
    }
    if (action === 'cmd_confirm_delete_all') {
        await safeEditMessageText("⏳ *MENGEKSEKUSI PEMBERSIHAN MASSAL LINTAS AKUN...*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        for (const [accId, acc] of activeSessions.entries()) { await acc.returnAllNumbers(); }
        await dbRun('DELETE FROM wa_nodes'); await dbRun('DELETE FROM user_assigned_numbers'); await dbRun('DELETE FROM used_numbers');
        return safeEditMessageText(`✅ *PEMBERSIHAN SELESAI*\nSeluruh node dikembalikan. Tabel lokal dikosongkan.`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
    }
    
    // 📌 FITUR BARU: ADVANCED DASHBOARD
    if (action === 'cmd_status') {
        const userCountRow = await dbGet('SELECT COUNT(*) as count FROM whitelisted_users');
        const assignedCountRow = await dbGet('SELECT COUNT(*) as count FROM user_assigned_numbers');
        
        let statusMsg = `⚙️ *STATUS SISTEM & KESEHATAN*\n━━━━━━━━━━━━━━━━━━━━━━\n`;
        statusMsg += `🤖 *Soket Meta   :* ${sock?.authState?.creds?.registered ? '🟢 TERHUBUNG' : '🔴 TERPUTUS'}\n`;
        statusMsg += `👥 *Total Klien  :* ${userCountRow.count} Identitas\n`;
        statusMsg += `📱 *Sesi Dipinjam:* ${assignedCountRow.count} Node\n\n`;
        
        statusMsg += `📊 *RINCIAN NODE PER AKUN (IVAS)*\n`;
        const accStats = await dbAll('SELECT account_id, COUNT(*) as count FROM wa_nodes GROUP BY account_id');
        
        let totalNodes = 0;
        if (accStats.length === 0) {
            statusMsg += `_Kosong (Tidak ada alokasi data)_\n`;
        } else {
            accStats.forEach(stat => {
                statusMsg += `  └ ID ${stat.account_id}: *${stat.count}* Node Tersimpan\n`;
                totalNodes += stat.count;
            });
        }
        
        statusMsg += `\n🗃 *Total Penyimpanan Global:* ${totalNodes} Node Aman.`;
        return safeEditMessageText(statusMsg, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
    }
    
    if (action === 'cmd_manage_users') {
        const users = await dbAll('SELECT chat_id, username, added_at FROM whitelisted_users ORDER BY added_at DESC LIMIT 50');
        const countRow = await dbGet('SELECT COUNT(*) as count FROM whitelisted_users');
        let text = `👥 *REKAM DATA PENGGUNA PUBLIK*\n━━━━━━━━━━━━━━━━━━━━━━\nTotal Pengguna Unik: ${countRow.count}\n\n_50 Entitas Terakhir:_\n`;
        if (users.length > 0) { users.forEach((u, i) => { text += `${i+1}. ${u.username} (\`${u.chat_id}\`)\n`; }); } 
        else { text += '_Basis data kosong._\n'; }
        return safeEditMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '⬅️ Kembali ke Ruang Kerja', callback_data: 'cmd_cancel' }]] } });
    }

    if (action === 'cmd_search') {
        userStates[chatId].state = 'WAITING_NUMBER';
        return safeEditMessageText(`🔍 *KOTAK MASUK GLOBAL*\nMasukkan nomor WA (Contoh: \`2250787560321\`)`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getCancelMarkup() });
    }
    
    if (action === 'cmd_wa_login') {
        if (fs.existsSync('./auth_info_baileys/creds.json')) return bot.answerCallbackQuery(query.id, { text: 'Soket Meta sudah terhubung.', show_alert: true });
        userStates[chatId].state = 'WAITING_WA_PHONE';
        return safeEditMessageText("📱 *KONEKSI SOKET META*\n━━━━━━━━━━━━━━━━━━━━━━\nMasukkan nomor root utama disertai *Kode Negara*.\n_(Format Murni: 628xxx, 447xxx, tanpa '+' atau '0')_", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getCancelMarkup() });
    }
    
    if (action === 'cmd_wa_logout') {
        if (fs.existsSync('./auth_info_baileys/creds.json')) {
            await safeEditMessageText("⏳ *MENUTUP SOKET META...*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
            try { if (sock) await sock.logout(); } catch(e) {}
            if (fs.existsSync('./auth_info_baileys')) fs.rmSync('./auth_info_baileys', { recursive: true, force: true });
            sock = null; isConnectingWA = false;
            safeEditMessageText("✅ *SOKET DITUTUP*\nSesi lokal dan komunikasi peladen berhasil dihapus secara aman.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        } else safeEditMessageText("⚠️ *KESALAHAN: STATUS TIDAK VALID*\nSoket tidak ditemukan di dalam sistem.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        return;
    }

    if (action === 'cmd_cancel') { 
        userStates[chatId].state = 'IDLE'; 
        return safeEditMessageText("⚠️ *TINDAKAN DIBATALKAN*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() }); 
    }
    
    if (action.startsWith('start_')) {
        if (!sock?.authState?.creds?.registered) return bot.answerCallbackQuery(query.id, { text: '⚠️ Soket Meta terputus!', show_alert: true });
        const parts = action.split('_'); const mode = parts[parts.length - 1]; const jobId = parts.slice(1, parts.length - 1).join('_');
        const numbersList = jobQueue.get(jobId);
        
        if (!numbersList) return bot.answerCallbackQuery(query.id, { text: 'Berkas data telah kedaluwarsa di dalam tumpukan memori (memory heap).', show_alert: true });

        safeEditMessageText(`⏳ *MEMULAI EKSTRAKSI DATA MASSAL*\n━━━━━━━━━━━━━━━━━━━━━━\n⚙️ Mode Thread : *${mode.toUpperCase()}*\n📊 Beban Kerja : *${numbersList.length}* muatan data`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        processBulkCheck(numbersList, SPEED_MODES[mode], chatId, msgId);
        jobQueue.delete(jobId);
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
            const markup = { inline_keyboard: [ [{ text: '✅ Eksekusi Fase Autentikasi', callback_data: 'cmd_finish_login' }], [{ text: '❌ Batalkan', callback_data: 'cmd_cancel' }] ] };
            safeEditMessageText(`🔑 *GERBANG AUTENTIKASI*\n✅ Kunci Saat Ini: ${addedKeys}\nInjeksi string berikutnya atau tekan *Eksekusi*.`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: markup });
        } else {
            const markup = { inline_keyboard: [ [{ text: '✅ Eksekusi Fase Autentikasi', callback_data: 'cmd_finish_login' }], [{ text: '❌ Batalkan', callback_data: 'cmd_cancel' }] ] };
            safeEditMessageText(`❌ *SINTAKSIS RUSAK*\nGunakan pemisah '=' pada muatan data.\nContoh: \`ivas_sms_session=eyJp...\``, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: markup });
        }
    } 
    
    else if (currentState === 'WAITING_RANGE') {
        userStates[chatId].state = 'IDLE'; const targetRange = text.trim(); bot.sendChatAction(chatId, 'typing').catch(()=>{});
        
        try {
            let foundNumbers = [];
            let processedAccs = 0;
            const totalAccs = activeSessions.size;

            for (const [accId, acc] of activeSessions.entries()) {
                processedAccs++;
                await safeEditMessageText(`🔍 *KUERI LINTAS AKUN DIEKSEKUSI*\nMemindai wilayah \`${targetRange}\` ke seluruh API...\n\n🔄 Memeriksa Akun ID: ${accId} (${processedAccs}/${totalAccs} Akun)`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown' }).catch(()=>{});
                
                const nums = await acc.getTestNumbersByRange(targetRange);
                if (nums.length > 0) { nums.forEach(n => n.accId = accId); foundNumbers = foundNumbers.concat(nums); }
            }
            
            if (foundNumbers.length > 0) {
                let reply = `✅ *DITEMUKAN: ${targetRange}*\n\n👇 *Pilih Node & Eksekusi melalui Akun spesifik:*`;
                const inline_keyboard = [];
                foundNumbers.slice(0, 10).forEach((n) => {
                    inline_keyboard.push([{ text: `📱 ${n.number} ($${n.rate}) - Akun ${n.accId}`, callback_data: `term_detail_${n.id}_${n.accId}` }]);
                });
                inline_keyboard.push([{ text: '❌ Batalkan Operasi', callback_data: 'cmd_cancel' }]);
                safeEditMessageText(reply, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard } });
            } else safeEditMessageText(`❌ *TIDAK DITEMUKAN PADA SEMUA AKUN*\nTitik akhir kosong untuk rentang \`${targetRange}\`.`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        } catch (e) { safeEditMessageText(`⚠️ *KESALAHAN SISTEM*: ${e.message}`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() }); }
    }
    
    else if (currentState === 'WAITING_NUMBER') {
        userStates[chatId].state = 'IDLE'; const targetNumber = text.trim(); const todayStr = getTodayUTC();
        try {
            let foundMsgs = null; 
            const dbRegionRow = await dbGet('SELECT range_name, account_id FROM wa_nodes WHERE number = ?', [targetNumber]);

            if (dbRegionRow) {
                await safeEditMessageText(`⚡ *CACHE LOKAL DITEMUKAN!*\nMengunduh riwayat pesan dari Akun ID: ${dbRegionRow.account_id}...`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown' });
                const acc = activeSessions.get(dbRegionRow.account_id);
                if (acc) foundMsgs = await acc.getMessages(targetNumber, dbRegionRow.range_name, todayStr);
            } else {
                let processedAccs = 0;
                const totalAccs = activeSessions.size;

                for (const [accId, acc] of activeSessions.entries()) {
                    processedAccs++;
                    await safeEditMessageText(`🔍 *PEMINDAIAN GLOBAL*\nCache Miss. Memindai silang (cross-scan) seluruh fragmen server...\n\n🔄 Memeriksa Akun ID: ${accId} (${processedAccs}/${totalAccs} Akun)`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown' }).catch(()=>{});
                    
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
                    const card = formatMessageCard(m); 
                    await bot.sendMessage(chatId, card.text, { parse_mode: 'Markdown', reply_markup: card.reply_markup });
                }
                safeEditMessageText(`✅ *OPERASI SELESAI*`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
            } else safeEditMessageText(`❌ *TIDAK ADA REKAMAN DITEMUKAN*\nEndpoint kosong untuk string \`${targetNumber}\`.`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        } catch (e) { safeEditMessageText(`⚠️ *KESALAHAN SISTEM*: ${e.message}`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() }); }
    }
    
    else if (currentState === 'WAITING_WA_PHONE') {
        userStates[chatId].state = 'IDLE'; const phoneNumber = text.replace(/\D/g, '');
        if (phoneNumber.length < 8) return safeEditMessageText("❌ *PERMINTAAN DITOLAK (BAD REQUEST)*\nParameter kurang. Masukkan string data lengkap (misal: 628xxx).", { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        await safeEditMessageText(`⏳ Menyebarkan titik pantau untuk \`${phoneNumber}\`...`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown' });
        startWA(phoneNumber, chatId, menuMsgId);
    }
});

bot.on('document', async (msg) => {
    const chatId = msg.chat.id.toString();
    if (!isAdmin(chatId)) return;
    
    bot.deleteMessage(chatId, msg.message_id).catch(()=>{});
    
    if (!sock?.authState?.creds?.registered) {
        const sm = await bot.sendMessage(chatId, '⚠️ Soket Meta terputus!', { reply_markup: getMainMenuMarkup() });
        if(userStates[chatId]) userStates[chatId].lastMsgId = sm.message_id;
        return;
    }
    if (!msg.document.file_name.endsWith('.txt')) {
        const sm = await bot.sendMessage(chatId, '❌ Mime-Type Tidak Valid. Sistem hanya menerima berkas TXT.', { reply_markup: getMainMenuMarkup() });
        if(userStates[chatId]) userStates[chatId].lastMsgId = sm.message_id;
        return;
    }
    
    try {
        const fileLink = await bot.getFileLink(msg.document.file_id);
        const res = await axios.get(fileLink);
        let rawNumbers = res.data.split('\n').map(n => n.replace(/\D/g, '')).filter(n => n.length > 8);
        const uniqueNumbers = [...new Set(rawNumbers.map(n => n.startsWith('0') ? '62' + n.slice(1) : n))];
        
        if (uniqueNumbers.length === 0) {
            const sm = await bot.sendMessage(chatId, '❌ Muatan Data Kosong (Null Payload). Gagal mengekstrak data valid.', { reply_markup: getMainMenuMarkup() });
            if(userStates[chatId]) userStates[chatId].lastMsgId = sm.message_id;
            return;
        }
        
        const jobId = Date.now().toString(); 
        jobQueue.set(jobId, uniqueNumbers);
        const sm = await bot.sendMessage(chatId, `📁 *MUATAN DATA DITERIMA*\n━━━━━━━━━━━━━━━━━━━━━━\n*${uniqueNumbers.length}* string siap diproses.\n\nPilih konfigurasi pelambatan antrean (*Throttle*):`, { 
            parse_mode: 'Markdown', 
            reply_markup: { inline_keyboard: [ [{ text: '🚀 Turbo (Agresif)', callback_data: `start_${jobId}_fast` }, { text: '🚗 Bawaan (Seimbang)', callback_data: `start_${jobId}_normal` }, { text: '🚲 Siluman (Aman)', callback_data: `start_${jobId}_slow` }] ] } 
        });
        if(userStates[chatId]) userStates[chatId].lastMsgId = sm.message_id;
    } catch (e) { 
        const sm = await bot.sendMessage(chatId, `❌ *PENGECUALIAN (EXCEPTION)*: ${e.message}`, { reply_markup: getMainMenuMarkup() }); 
        if(userStates[chatId]) userStates[chatId].lastMsgId = sm.message_id;
    }
});

(async () => {
    console.log('[SISTEM] Menyiapkan Basis Data Lintas-Akun...');
    const accounts = await dbAll('SELECT * FROM ivas_accounts');
    for (const accData of accounts) {
        const account = new IVASAccount(accData.id, JSON.parse(accData.cookies));
        if (await account.initSession()) {
            activeSessions.set(accData.id, account);
            console.log(`[IVAS] Akun ID ${accData.id} Berhasil Dimuat.`);
        } else {
            console.log(`[IVAS] Akun ID ${accData.id} Gagal Dimuat (Sesi Kedaluwarsa).`);
        }
    }
    
    pollAllAccounts(); 
    if (fs.existsSync('./auth_info_baileys/creds.json')) startWA();
})();
