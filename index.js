const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar, Cookie } = require('tough-cookie');
const cheerio = require('cheerio');
const pino = require('pino');
const sqlite3 = require('sqlite3').verbose();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = require('baileys');
require('dotenv').config();

// --- KONFIGURASI ENV ---
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { 
    polling: true,
    request: {
        family: 4 // Memaksa bot menggunakan IPv4
    }
});
const POLLING_INTERVAL = process.env.POLLING_INTERVAL || 30000;
const BROADCAST_CHANNEL = process.env.BROADCAST_CHANNEL_ID ? process.env.BROADCAST_CHANNEL_ID.trim() : null;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? process.env.ADMIN_CHAT_ID.trim() : null; 

// ==========================================
// SETUP SQLITE DATABASE
// ==========================================
const sqlDb = new sqlite3.Database('./pansa_bot.db');

// Helper untuk menggunakan Promises di SQLite
const dbRun = (sql, params = []) => new Promise((res, rej) => sqlDb.run(sql, params, function(err) { if(err) rej(err); else res(this); }));
const dbGet = (sql, params = []) => new Promise((res, rej) => sqlDb.get(sql, params, (err, row) => err ? rej(err) : res(row)));
const dbAll = (sql, params = []) => new Promise((res, rej) => sqlDb.all(sql, params, (err, rows) => err ? rej(err) : res(rows)));

sqlDb.serialize(() => {
    dbRun(`CREATE TABLE IF NOT EXISTS sessions (chat_id TEXT PRIMARY KEY, cookies TEXT, last_total_sms INTEGER DEFAULT -1)`);
    dbRun(`CREATE TABLE IF NOT EXISTS seen_ids (msg_id TEXT PRIMARY KEY, chat_id TEXT)`);
    dbRun(`CREATE TABLE IF NOT EXISTS wa_numbers (number TEXT PRIMARY KEY, chat_id TEXT, range_name TEXT)`);
});

const userStates = {}; 
function getTodayUTC() { return new Date().toISOString().split('T')[0]; }

// ==========================================
// MODUL 1: IVAS SMS (OTP POLLING & API JSON)
// ==========================================

class IVASAccount {
    constructor(chatId, cookies) {
        this.chatId = chatId;
        this.cookies = cookies;
        this.jar = new CookieJar();
        this.client = wrapper(axios.create({
            jar: this.jar, baseURL: 'https://www.ivasms.com', timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/javascript, */*; q=0.01',
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
                if (csrfInput.length) {
                    this.csrfToken = csrfInput.val();
                    this.loggedIn = true; return true;
                }
            }
            return false;
        } catch (e) { return false; }
    }

    async getMyNumbers() {
        try {
            const params = new URLSearchParams({ draw: 1, start: 0, length: 2000, 'search[value]': '' });
            const res = await this.client.get(`/portal/numbers?${params.toString()}`, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
            if (res.status === 200 && res.data && res.data.data) {
                return res.data.data.map(item => ({ number: item.Number.toString(), range: item.range }));
            }
            return [];
        } catch (e) { return []; }
    }

    async returnAllNumbers() {
        try {
            const payload = new URLSearchParams({ '_token': this.csrfToken });
            const res = await this.client.post('/portal/numbers/return/allnumber/bluck', payload.toString(), { 
                headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } 
            });
            if (res.status === 200 && res.data) return res.data;
            return null;
        } catch (e) { return null; }
    }

    async fetchLiveTestSMS() {
        try {
            const params = new URLSearchParams({
                'draw': '1', 'columns[0][data]': 'range', 'columns[1][data]': 'termination.test_number',
                'columns[2][data]': 'originator', 'columns[3][data]': 'messagedata', 'columns[4][data]': 'senttime',
                'order[0][column]': '4', 'order[0][dir]': 'desc', 'start': '0', 'length': '50', 'search[value]': '', '_': Date.now()
            });
            const res = await this.client.get(`/portal/sms/test/sms?${params.toString()}`, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
            if (res.status === 200 && res.data && res.data.data) return res.data.data;
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
            const res = await this.client.get(`/portal/numbers/test?${params.toString()}`, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
            if (res.status === 200 && res.data && res.data.data) {
                return res.data.data.map(item => ({ id: item.id, number: item.test_number, rate: item.A2P }));
            }
            return [];
        } catch (e) { return []; }
    }

    async getTerminationDetails(id) {
        try {
            const payload = new URLSearchParams({ 'id': id, '_token': this.csrfToken });
            const res = await this.client.post('/portal/numbers/termination/details', payload.toString(), { 
                headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } 
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
                headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }
            });
            if (res.status === 200 && res.data) return res.data;
            return null;
        } catch (e) { return null; }
    }

    async getCountries(dateStr) {
        try {
            const res = await this.client.post('/portal/sms/received/getsms', new URLSearchParams({ 'from': dateStr, 'to': dateStr, '_token': this.csrfToken }).toString(), { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
            if (res.status === 200) {
                const $ = cheerio.load(res.data);
                const countries = []; $('div.rng').each((i, el) => countries.push($(el).find('.rname').text().trim()));
                const countMatch = res.data.match(/#CountSMS"\)\.html\("([^"]+)"\)/);
                const totalSms = countMatch ? parseInt(countMatch[1]) : 0;
                return { countries, totalSms };
            }
            return { countries: [], totalSms: 0 };
        } catch (e) { return { countries: [], totalSms: 0 }; }
    }

    async getNumbers(countryRange, dateStr) {
        try {
            const res = await this.client.post('/portal/sms/received/getsms/number', new URLSearchParams({ '_token': this.csrfToken, 'start': dateStr, 'end': dateStr, 'range': countryRange }).toString(), { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
            if (res.status === 200) {
                const numbers = []; cheerio.load(res.data)('div.nrow').each((i, el) => numbers.push(cheerio.load(el)('.nnum').text().trim())); return numbers;
            } return [];
        } catch (e) { return []; }
    }

    async getMessages(phoneNumber, countryRange, dateStr) {
        try {
            const res = await this.client.post('/portal/sms/received/getsms/number/sms', new URLSearchParams({ '_token': this.csrfToken, 'start': dateStr, 'end': dateStr, 'Number': phoneNumber, 'Range': countryRange }).toString(), { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
            if (res.status === 200) {
                const messages = []; cheerio.load(res.data)('tbody tr').each((i, el) => {
                    const text = cheerio.load(el)('.msg-text').text().trim();
                    if (text) messages.push({ sender: cheerio.load(el)('.cli-tag').text().trim(), text, time: cheerio.load(el)('.time-cell').text().trim(), phoneNumber, countryRange });
                }); return messages;
            } return [];
        } catch (e) { return []; }
    }
}

const activeSessions = new Map();

// ==========================================
// MODUL 2: WHATSAPP BAILEYS & AUTO-FILTER DB
// ==========================================
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let sock; let isConnectingWA = false; 

async function startWA(phoneNumberForPairing = null, reportChatId = ADMIN_CHAT_ID, msgId = null) {
    if (isConnectingWA) return; isConnectingWA = true;
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({ version, printQRInTerminal: false, browser: Browsers.macOS('Chrome'), auth: state, logger: pino({ level: 'silent' }), markOnlineOnConnect: false, generateHighQualityLinkPreview: true });
    sock.ev.on('creds.update', saveCreds);

    const notifyUI = async (text) => {
        const opts = { parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() };
        if (msgId) await safeEditMessageText(text, { chat_id: reportChatId, message_id: msgId, ...opts });
        else if (phoneNumberForPairing) await bot.sendMessage(reportChatId, text, opts).catch(()=>{});
    };

    if (phoneNumberForPairing && !sock.authState.creds.registered) {
        await notifyUI(`⏳ *Menghubungkan ke Meta...*\nMeminta kode untuk nomor: \`${phoneNumberForPairing}\``);
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumberForPairing);
                const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
                await notifyUI(`✅ *KODE PAIRING ANDA:* \`${formattedCode}\`\n\n1️⃣ Buka WhatsApp di HP\n2️⃣ Titik tiga -> *Linked Devices*\n3️⃣ *Link with phone number instead*\n4️⃣ Masukkan kode di atas.`);
            } catch (error) { 
                await notifyUI(`❌ *Gagal request kode:* ${error.message}`); 
                isConnectingWA = false; 
            }
        }, 4000); 
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            isConnectingWA = false;
            if (lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                setTimeout(() => startWA(null, reportChatId, msgId), 5000); 
            } else { 
                if (msgId) await notifyUI("❌ *WhatsApp Dikeluarkan dari Perangkat!*\nSilakan login ulang.");
                if (fs.existsSync('./auth_info_baileys')) fs.rmSync('./auth_info_baileys', { recursive: true, force: true }); 
                sock = null; 
            }
        } else if (connection === 'open') { 
            isConnectingWA = false; 
            if (msgId || phoneNumberForPairing) await notifyUI('✅ *WhatsApp Berhasil Terhubung!*'); 
        }
    });
}

// [MESIN PINTAR SQLITE] Otomatis Cek WA & Masukkan ke DB
async function autoFilterAndSaveNumbers(chatId, numbersObjArray, msgId) {
    if (!numbersObjArray || numbersObjArray.length === 0) return;

    if (!sock?.authState?.creds?.registered) {
        await safeEditMessageText(`⚠️ *WA Belum Terhubung!*\nMenyimpan semua *${numbersObjArray.length}* nomor ke DB tanpa filter status WhatsApp...`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        for (const n of numbersObjArray) {
            await dbRun('INSERT OR IGNORE INTO wa_numbers (number, chat_id, range_name) VALUES (?, ?, ?)', [n.number, chatId, n.range]);
        }
        await delay(2000);
        return;
    }

    await safeEditMessageText(`⏳ *Auto-Filter WhatsApp Aktif!*\nMengecek status WA untuk *${numbersObjArray.length}* nomor baru...`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });

    let activeCount = 0;
    let total = numbersObjArray.length;
    let processed = 0;

    for (const n of numbersObjArray) {
        processed++;
        const jid = `${n.number}@s.whatsapp.net`;
        try {
            await delay(250); // Jeda anti-banned
            const [status] = await sock.onWhatsApp(jid);
            if (status?.exists) {
                await dbRun('INSERT OR IGNORE INTO wa_numbers (number, chat_id, range_name) VALUES (?, ?, ?)', [n.number, chatId, n.range]);
                activeCount++;
            }
        } catch(e) {}

        if (processed % 5 === 0 || processed === total) {
            safeEditMessageText(`⏳ *Memfilter Nomor WA...*\nProgress: ${processed} / ${total}\n✅ Aktif WA: *${activeCount}* Disimpan ke DB`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{});
        }
    }
    await safeEditMessageText(`✅ *Filter WA Selesai!*\nTotal Ditarik: ${total}\n📲 Aktif WA (Disimpan): *${activeCount}* Nomor`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
}

// Inisialisasi Booting
(async () => {
    console.log('[SYSTEM] Menyiapkan SQLite & Ivasms Sessions...');
    const sessions = await dbAll('SELECT * FROM sessions');
    for (const session of sessions) {
        const account = new IVASAccount(session.chat_id, JSON.parse(session.cookies));
        if (await account.initSession()) activeSessions.set(session.chat_id, account);
    }
    pollAllAccounts(); 
    console.log('[SYSTEM] Mengecek Sesi WhatsApp...');
    if (fs.existsSync('./auth_info_baileys/creds.json')) startWA();
})();

// ==========================================
// MODUL 3: TELEGRAM UI & ROUTING HANDLERS
// ==========================================

const getMainMenuMarkup = () => ({
    inline_keyboard: [
        [{ text: '🔑 Login Cookie', callback_data: 'cmd_login' }, { text: '🗃 Sync Data (Filter WA)', callback_data: 'cmd_sync_db' }],
        [{ text: '🔍 Cek Inbox (Nomor)', callback_data: 'cmd_search' }, { text: '🛒 Cari Range (Add)', callback_data: 'cmd_search_range' }],
        [{ text: '📡 AUTO-SNIPER WA', callback_data: 'cmd_hunt_wa' }, { text: '🗑 Hapus Semua', callback_data: 'cmd_delete_all' }],
        [{ text: '📱 Hubungkan WA', callback_data: 'cmd_wa_login' }, { text: '⚙️ Status Sistem', callback_data: 'cmd_status' }],
        [{ text: '🚪 Logout IVAS', callback_data: 'cmd_logout' }]
    ]
});

const getCancelMarkup = () => ({ inline_keyboard: [[{ text: '❌ Batal', callback_data: 'cmd_cancel' }]] });

function formatMessageCard(msgData, isManual = false) {
    const otpMatch = msgData.text.match(/\b\d{3}[-\s]?\d{3}\b/);
    const cleanOtp = otpMatch ? otpMatch[0].replace(/\D/g, '') : null;
    const text = `🌐 *PANSA STUDIO | OTP CHECKER*\n━━━━━━━━━━━━━━━━━━\n📱 *Nomor:* \`${msgData.phoneNumber}\`\n🌍 *Region:* ${msgData.countryRange}\n📨 *Sender:* ${msgData.sender}\n⏱ *Time:* ${msgData.time} (UTC)\n━━━━━━━━━━━━━━━━━━\n💬 *Pesan:*\n_${msgData.text}_\n━━━━━━━━━━━━━━━━━━` + (cleanOtp ? `\n\n💡 _Tap angka di bawah ini untuk copy:_ \n👉 \`${cleanOtp}\` 👈` : '');
    const inline_keyboard = [];
    if (cleanOtp) inline_keyboard.push([{ text: `📋 OTP: ${cleanOtp}`, callback_data: 'dummy_btn' }]);
    inline_keyboard.push([{ text: '🤖 Kembali ke Panel Pansa AI', url: `https://t.me/${process.env.BOT_USERNAME || 'bot'}` }]); 
    return { text, reply_markup: { inline_keyboard } };
}

async function safeEditMessageText(text, options) {
    try { await bot.editMessageText(text, options); } 
    catch (e) { if (!e.message.includes('message is not modified')) console.error(e.message); }
}

bot.onText(/\/(start|menu)/, async (msg) => {
    const chatId = msg.chat.id.toString();
    bot.deleteMessage(chatId, msg.message_id).catch(()=>{});
    const sentMsg = await bot.sendMessage(chatId, `*🤖 Panel Universal Pansa AI*\nManajemen Ivasms & WA Bulk Checker\n\nSilakan pilih menu di bawah ini:`, { parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
    userStates[chatId] = { state: 'IDLE', lastMsgId: sentMsg.message_id };
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id.toString();
    const msgId = query.message.message_id;
    const action = query.data;

    bot.answerCallbackQuery(query.id);
    if (action === 'dummy_btn') return; 
    if (!userStates[chatId]) userStates[chatId] = { state: 'IDLE', lastMsgId: msgId };

    if (action === 'cmd_login') {
        userStates[chatId].state = 'WAITING_COOKIE';
        safeEditMessageText("🔑 *Update Cookie IVAS*\nKirimkan *JSON Object* cookie kamu di sini.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getCancelMarkup() });
    } 
    else if (action === 'cmd_sync_db') {
        if (!activeSessions.has(chatId)) return safeEditMessageText("⚠️ Kamu belum login IVAS!", { chat_id: chatId, message_id: msgId, reply_markup: getMainMenuMarkup() });
        safeEditMessageText("⏳ *Sedang Menarik Data Nomor...*\nMengambil daftar nomor aktif dari API Ivasms...", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        
        const acc = activeSessions.get(chatId);
        const myNumbers = await acc.getMyNumbers();
        
        // Hapus data lama agar benar-benar tersinkronisasi
        await dbRun('DELETE FROM wa_numbers WHERE chat_id = ?', [chatId]);
        
        // Proses ke Auto-Filter WA Engine
        await autoFilterAndSaveNumbers(chatId, myNumbers, msgId);
    }
    else if (action === 'cmd_search_range') {
        if (!activeSessions.has(chatId)) return safeEditMessageText("⚠️ Kamu belum login IVAS!", { chat_id: chatId, message_id: msgId, reply_markup: getMainMenuMarkup() });
        userStates[chatId].state = 'WAITING_RANGE';
        safeEditMessageText(`🛒 *Cari Range Ivasms (Test Number)*\nMasukkan nama Range (contoh: \`INDONESIA 232428\`).\nBot akan menampilkan daftar nomor yang tersedia untuk ditambahkan.`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getCancelMarkup() });
    }
    else if (action.startsWith('term_detail_')) {
        if (!activeSessions.has(chatId)) return safeEditMessageText("⚠️ Kamu belum login IVAS!", { chat_id: chatId, message_id: msgId, reply_markup: getMainMenuMarkup() });
        const termId = action.replace('term_detail_', '');
        await safeEditMessageText("⏳ *Mengambil detail nomor...*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        const acc = activeSessions.get(chatId);
        const details = await acc.getTerminationDetails(termId);
        if (details) {
            let detailText = `📄 *DETAIL TERMINATION*\n━━━━━━━━━━━━━━━━━━\n📌 *Range:* \`${details.rangeName}\`\n💵 *Penghasilan (A2P):* ${details.a2pRate}\n\n📊 *Spesifikasi / Limit:*\n`;
            details.limits.forEach(l => { detailText += `  └ *${l.key}:* ${l.val}\n`; });
            const detailMarkup = { inline_keyboard: [ [{ text: '➕ Add Number', callback_data: `add_term_${termId}` }], [{ text: '⬅️ Kembali', callback_data: 'cmd_cancel' }] ] };
            safeEditMessageText(detailText, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: detailMarkup });
        } else { safeEditMessageText("❌ Gagal mengambil detail nomor dari server.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() }); }
    }
    else if (action.startsWith('add_term_')) {
        if (!activeSessions.has(chatId)) return safeEditMessageText("⚠️ Kamu belum login IVAS!", { chat_id: chatId, message_id: msgId, reply_markup: getMainMenuMarkup() });
        const termId = action.replace('add_term_', '');
        await safeEditMessageText("⏳ *Memproses Penambahan...*\nMenambahkan nomor ke akun kamu...", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        
        const acc = activeSessions.get(chatId);
        const result = await acc.addNumber(termId);
        
        if (result && result.message) {
            // Ambil nomor yang baru dibeli
            const existingNums = await dbAll('SELECT number FROM wa_numbers WHERE chat_id = ?', [chatId]);
            const existingSet = new Set(existingNums.map(n => n.number));
            const allMyNumbers = await acc.getMyNumbers();
            
            // Filter nomor yang benar-benar baru
            const newNumbers = allMyNumbers.filter(n => !existingSet.has(n.number));
            
            // Lemparkan ke Auto-Filter WA
            if (newNumbers.length > 0) {
                await autoFilterAndSaveNumbers(chatId, newNumbers, msgId);
            } else {
                safeEditMessageText(`✅ *Range Berhasil Ditambahkan!*\n${result.message}\n\n_Belum ada nomor baru yang didapatkan. Silakan Sync DB nanti._`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
            }
        } else { safeEditMessageText("❌ *Gagal menambahkan nomor.*\nMungkin limit sudah penuh atau nomor sudah diambil orang lain.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() }); }
    }
    else if (action === 'cmd_hunt_wa') {
        if (!activeSessions.has(chatId)) return safeEditMessageText("⚠️ Kamu belum login IVAS!", { chat_id: chatId, message_id: msgId, reply_markup: getMainMenuMarkup() });
        const acc = activeSessions.get(chatId);
        const MAX_BUY = 3; 
        await safeEditMessageText(`🎯 *AUTO-SNIPER WA AKTIF*\nBot akan memonitor Live Feed, mencari Range WA yang gacor, dan *otomatis menambahkan* 1 Range dari setiap temuan.\n\n_Maksimal target: ${MAX_BUY} Range. Harap tunggu..._`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });

        const uniqueRanges = new Set();
        const purchasedRanges = [];
        const maxRetries = 15; 

        for (let i = 1; i <= maxRetries; i++) {
            const data = await acc.fetchLiveTestSMS();
            for (const item of data) {
                const $orig = cheerio.load(item.originator);
                const sender = $orig('p').text().trim().toLowerCase();
                
                if (sender.includes('whatsapp') || sender.includes('wa')) {
                    if (!uniqueRanges.has(item.range)) {
                        uniqueRanges.add(item.range);
                        await safeEditMessageText(`🎯 *AUTO-SNIPER WA*\nDitemukan Range aktif: \`${item.range}\`\n_Mencoba eksekusi auto-add..._`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
                        
                        const availableNums = await acc.getTestNumbersByRange(item.range);
                        if (availableNums.length > 0) {
                            const targetTermId = availableNums[0].id;
                            const buyResult = await acc.addNumber(targetTermId);
                            
                            if (buyResult && buyResult.message && buyResult.message.toLowerCase().includes('done')) {
                                purchasedRanges.push({ range: item.range, rate: availableNums[0].rate });
                            }
                        }
                        if (purchasedRanges.length >= MAX_BUY) break; 
                    }
                }
            }
            if (purchasedRanges.length >= MAX_BUY) break;
            if (i < maxRetries) await delay(3000); 
        }

        if (purchasedRanges.length > 0) {
            let reply = `✅ *SNIPER BERHASIL!*\nBerhasil menambahkan ${purchasedRanges.length} Range aktif secara otomatis:\n\n`;
            purchasedRanges.forEach((d, i) => { reply += `${i+1}. 🌍 *${d.range}*\n   └ 💵 Rate: +$${d.rate}\n\n`; });
            
            await safeEditMessageText(reply + `⏳ _Memulai sinkronisasi dan filter WA untuk nomor baru..._`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
            
            // Proses Sinkronisasi & Filter WA untuk nomor yang baru didapat
            const existingNums = await dbAll('SELECT number FROM wa_numbers WHERE chat_id = ?', [chatId]);
            const existingSet = new Set(existingNums.map(n => n.number));
            const allMyNumbers = await acc.getMyNumbers();
            const newNumbers = allMyNumbers.filter(n => !existingSet.has(n.number));
            
            if (newNumbers.length > 0) {
                await delay(2000);
                await autoFilterAndSaveNumbers(chatId, newNumbers, msgId);
            } else {
                safeEditMessageText(reply + `*🤖 Panel Universal Pansa AI*`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
            }
        } else {
            let reason = uniqueRanges.size > 0 ? "Range WA ditemukan, tapi gagal menambahkan nomor (mungkin limit/sudah diambil)." : "Lalu lintas SMS WhatsApp sedang kosong. Coba lagi nanti.";
            safeEditMessageText(`❌ *SNIPER SELESAI*\n${reason}`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        }
    }
    else if (action === 'cmd_search') {
        if (!activeSessions.has(chatId)) return safeEditMessageText("⚠️ Kamu belum login IVAS!", { chat_id: chatId, message_id: msgId, reply_markup: getMainMenuMarkup() });
        userStates[chatId].state = 'WAITING_NUMBER';
        const countRow = await dbGet('SELECT COUNT(*) as count FROM wa_numbers WHERE chat_id = ?', [chatId]);
        safeEditMessageText(`🔍 *Cek Inbox Nomor*\nMasukkan nomor telepon (contoh: \`2250787560321\`).\nBot akan mencari OTP yang masuk untuk nomor ini.\n\n_DB Aktif WA Lokal: ${countRow.count}_`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getCancelMarkup() });
    }
    else if (action === 'cmd_delete_all') {
        if (!activeSessions.has(chatId)) return safeEditMessageText("⚠️ Kamu belum login IVAS!", { chat_id: chatId, message_id: msgId, reply_markup: getMainMenuMarkup() });
        const confirmMarkup = { inline_keyboard: [ [{ text: '✅ Ya, Hapus Semua', callback_data: 'cmd_confirm_delete_all' }], [{ text: '❌ Batal', callback_data: 'cmd_cancel' }] ] };
        safeEditMessageText("⚠️ *KONFIRMASI HAPUS NOMOR*\n\nApakah kamu yakin ingin mengembalikan/menghapus **SEMUA** nomor dari server Ivasms?\nTindakan ini tidak dapat dibatalkan.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: confirmMarkup });
    }
    else if (action === 'cmd_confirm_delete_all') {
        if (!activeSessions.has(chatId)) return safeEditMessageText("⚠️ Kamu belum login IVAS!", { chat_id: chatId, message_id: msgId, reply_markup: getMainMenuMarkup() });
        await safeEditMessageText("⏳ *Sedang Menghapus Nomor...*\nMemproses permintaan Bulk Return ke server Ivasms...", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        const acc = activeSessions.get(chatId);
        const result = await acc.returnAllNumbers();
        if (result) {
            await dbRun('DELETE FROM wa_numbers WHERE chat_id = ?', [chatId]);
            safeEditMessageText(`✅ *Berhasil!*\n${result.message || `Berhasil mengembalikan nomor ke sistem.`}\n\n_Database lokal dibersihkan._`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        } else {
            safeEditMessageText("❌ *Gagal menghapus nomor.*\nTerjadi kesalahan jaringan atau cookie expired.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        }
    }
    else if (action === 'cmd_status') {
        const countRow = await dbGet('SELECT COUNT(*) as count FROM wa_numbers WHERE chat_id = ?', [chatId]);
        const statusMsg = `🟢 *IVAS:* ${activeSessions.has(chatId) ? 'AKTIF' : 'OFFLINE'}\n🤖 *BOT WA:* ${sock?.authState?.creds?.registered ? 'TERHUBUNG' : 'DISCONNECTED'}\n🗃 *DB SQLite:* ${countRow.count} WA Aktif Tersimpan`;
        safeEditMessageText(statusMsg, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
    }
    else if (action === 'cmd_logout') {
        await dbRun('DELETE FROM sessions WHERE chat_id = ?', [chatId]);
        await dbRun('DELETE FROM wa_numbers WHERE chat_id = ?', [chatId]);
        activeSessions.delete(chatId);
        safeEditMessageText("✅ IVAS Logout berhasil. Data dihapus dari SQLite.", { chat_id: chatId, message_id: msgId, reply_markup: getMainMenuMarkup() });
    }
    else if (action === 'cmd_cancel') {
        userStates[chatId].state = 'IDLE';
        safeEditMessageText("Operasi dibatalkan.\n\n*🤖 Panel Universal Pansa AI*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
    }
    else if (action === 'cmd_wa_login') {
        if (chatId !== ADMIN_CHAT_ID) return bot.sendMessage(chatId, "⛔ Akses Ditolak: Khusus Admin.");
        if (fs.existsSync('./auth_info_baileys/creds.json')) return bot.answerCallbackQuery(query.id, { text: 'WhatsApp sudah terhubung!', show_alert: true });
        userStates[chatId].state = 'WAITING_WA_PHONE';
        safeEditMessageText("📱 *Pairing WhatsApp*\nMasukkan nomor WA yang ada di HP Anda.\n_(Format: 628xxx tanpa spasi)_", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getCancelMarkup() });
    }
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id.toString();
    const text = msg.text;

    if (!text || text.startsWith('/')) return;
    bot.deleteMessage(chatId, msg.message_id).catch(() => {});

    if (!userStates[chatId]) return;
    const { state: currentState, lastMsgId: menuMsgId } = userStates[chatId];

    if (currentState === 'WAITING_COOKIE') {
        userStates[chatId].state = 'IDLE'; 
        try {
            let cookiesObj = {};
            const cookiesRaw = JSON.parse(text);
            if (Array.isArray(cookiesRaw)) cookiesRaw.forEach(c => { if (c.name && c.value) cookiesObj[c.name] = c.value; });
            else cookiesObj = cookiesRaw;

            if (!cookiesObj['ivas_sms_session']) throw new Error('Invalid');
            
            await dbRun('INSERT OR REPLACE INTO sessions (chat_id, cookies, last_total_sms) VALUES (?, ?, ?)', [chatId, JSON.stringify(cookiesObj), -1]);

            await safeEditMessageText("⏳ Login IVAS...", { chat_id: chatId, message_id: menuMsgId });
            const success = await startIvasSession(chatId);
            
            if (success) {
                const acc = activeSessions.get(chatId);
                const myNumbers = await acc.getMyNumbers();
                
                await dbRun('DELETE FROM wa_numbers WHERE chat_id = ?', [chatId]);
                await autoFilterAndSaveNumbers(chatId, myNumbers, menuMsgId);
            } else {
                safeEditMessageText("❌ *Login Gagal!*", { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
            }
        } catch (e) { safeEditMessageText("❌ Format Cookie Salah!", { chat_id: chatId, message_id: menuMsgId, reply_markup: getMainMenuMarkup() }); }
    } 
    else if (currentState === 'WAITING_RANGE') {
        userStates[chatId].state = 'IDLE';
        const targetRange = text.trim();
        const acc = activeSessions.get(chatId);
        bot.sendChatAction(chatId, 'typing').catch(()=>{});

        await safeEditMessageText(`🔍 *Mencari Nomor di Range*\nSedang menarik data nomor yang tersedia untuk region \`${targetRange}\`...`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown' });

        try {
            const availableNumbers = await acc.getTestNumbersByRange(targetRange);
            if (availableNumbers && availableNumbers.length > 0) {
                let reply = `✅ *Range Ditemukan: ${targetRange}*\nTersedia ${availableNumbers.length} nomor test.\n\n👇 *Pilih nomor untuk melihat detail:*`;
                const inline_keyboard = [];
                availableNumbers.slice(0, 10).forEach((n) => {
                    inline_keyboard.push([{ text: `📱 ${n.number} - Rate: $${n.rate}`, callback_data: `term_detail_${n.id}` }]);
                });
                inline_keyboard.push([{ text: '❌ Batal', callback_data: 'cmd_cancel' }]);
                
                safeEditMessageText(reply, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard } });
            } else {
                safeEditMessageText(`❌ Tidak ada nomor yang tersedia untuk Range \`${targetRange}\` saat ini.`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
            }
        } catch (e) { safeEditMessageText(`⚠️ Terjadi kesalahan: ${e.message}`, { chat_id: chatId, message_id: menuMsgId, reply_markup: getMainMenuMarkup() }); }
    }
    else if (currentState === 'WAITING_NUMBER') {
        userStates[chatId].state = 'IDLE';
        const targetNumber = text.trim();
        const acc = activeSessions.get(chatId);
        const todayStr = getTodayUTC();
        
        bot.sendChatAction(chatId, 'typing').catch(()=>{});

        try {
            let foundMsgs = null; let foundC = '';
            
            // Cek di DB SQLite
            const dbRegionRow = await dbGet('SELECT range_name FROM wa_numbers WHERE number = ? AND chat_id = ?', [targetNumber, chatId]);

            if (dbRegionRow) {
                await safeEditMessageText(`⚡ *Fast Search DB Aktif!*\nRegion ditemukan di DB: \`${dbRegionRow.range_name}\`\nMengunduh pesan dari server...`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown' });
                foundMsgs = await acc.getMessages(targetNumber, dbRegionRow.range_name, todayStr);
                foundC = dbRegionRow.range_name;
            } else {
                await safeEditMessageText(`🔍 *Pencarian Global*\nNomor tidak ada di DB SQLite. Memindai seluruh region Ivasms...`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown' });
                const checkData = await acc.getCountries(todayStr);
                for (const c of checkData.countries) {
                    const numbersInCountry = await acc.getNumbers(c, todayStr);
                    if (numbersInCountry.includes(targetNumber)) {
                        foundMsgs = await acc.getMessages(targetNumber, c, todayStr);
                        foundC = c; break; 
                    }
                }
            }

            if (foundMsgs && foundMsgs.length > 0 && BROADCAST_CHANNEL) {
                for (const m of foundMsgs) {
                    const card = formatMessageCard(m, true);
                    await bot.sendMessage(BROADCAST_CHANNEL, card.text, { parse_mode: 'Markdown', reply_markup: card.reply_markup });
                }
                safeEditMessageText(`✅ Pencarian selesai. Pesan untuk nomor \`${targetNumber}\` telah dikirim ke Channel.\n\n*🤖 Panel Universal Pansa AI*`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
            } else {
                safeEditMessageText(`❌ Nomor \`${targetNumber}\` tidak memiliki pesan di server hari ini.`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
            }
        } catch (e) { safeEditMessageText(`⚠️ Terjadi kesalahan: ${e.message}`, { chat_id: chatId, message_id: menuMsgId, reply_markup: getMainMenuMarkup() }); }
    }
    else if (currentState === 'WAITING_WA_PHONE') {
        userStates[chatId].state = 'IDLE';
        const phoneNumber = text.replace(/\D/g, '');
        if (phoneNumber.length < 9 || !phoneNumber.startsWith('62')) {
            return safeEditMessageText("❌ Format WA salah! (Gunakan 62...)", { chat_id: chatId, message_id: menuMsgId, reply_markup: getMainMenuMarkup() });
        }
        await safeEditMessageText(`⏳ Menghubungi server Meta untuk \`${phoneNumber}\`...`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown' });
        startWA(phoneNumber, chatId, menuMsgId);
    }
});

// --- SMART POLLING SQLITE ---
async function pollAllAccounts() {
    const today = getTodayUTC();
    const sessions = await dbAll('SELECT * FROM sessions');

    for (const session of sessions) {
        const chatId = session.chat_id;
        const account = activeSessions.get(chatId);
        if (!account || !account.loggedIn) continue;

        try {
            const checkData = await account.getCountries(today);
            const currentTotalSms = checkData.totalSms;

            if (currentTotalSms === session.last_total_sms) continue; 
            
            let hasNew = false;
            for (const country of checkData.countries) {
                const numbersInCountry = await account.getNumbers(country, today);
                for (const number of numbersInCountry) {
                    const messages = await account.getMessages(number, country, today);
                    for (const msg of messages) {
                        const msgId = `${msg.phoneNumber}_${msg.time}_${msg.sender}`;
                        
                        // Cek apakah pesan sudah dilihat di DB
                        const isSeen = await dbGet('SELECT msg_id FROM seen_ids WHERE msg_id = ? AND chat_id = ?', [msgId, chatId]);
                        
                        if (!isSeen) {
                            await dbRun('INSERT INTO seen_ids (msg_id, chat_id) VALUES (?, ?)', [msgId, chatId]);
                            hasNew = true;
                            if (BROADCAST_CHANNEL) {
                                const card = formatMessageCard(msg, false);
                                bot.sendMessage(BROADCAST_CHANNEL, card.text, { parse_mode: 'Markdown', reply_markup: card.reply_markup }).catch(()=>{});
                            }
                        }
                    }
                }
            }
            
            if (hasNew) { 
                await dbRun('UPDATE sessions SET last_total_sms = ? WHERE chat_id = ?', [currentTotalSms, chatId]);
                // Bersihkan histori seen_ids yang sudah terlalu lama agar DB tidak bengkak
                await dbRun(`DELETE FROM seen_ids WHERE rowid NOT IN (SELECT rowid FROM seen_ids WHERE chat_id = ? ORDER BY rowid DESC LIMIT 1000)`, [chatId]);
            }
        } catch (e) {
            if (e.response && (e.response.status === 401 || e.response.status === 403)) { 
                account.loggedIn = false; activeSessions.delete(chatId); 
            }
        }
    }
    setTimeout(pollAllAccounts, POLLING_INTERVAL);
}
