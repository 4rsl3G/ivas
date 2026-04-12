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
    polling: true,
    request: { family: 4 }
});

const POLLING_INTERVAL = process.env.POLLING_INTERVAL || 5000;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? process.env.ADMIN_CHAT_ID.trim() : null; 
const REQUIRED_CHANNEL_ID = process.env.REQUIRED_CHANNEL_ID ? process.env.REQUIRED_CHANNEL_ID.trim() : null;
const REQUIRED_CHANNEL_LINK = process.env.REQUIRED_CHANNEL_LINK ? process.env.REQUIRED_CHANNEL_LINK.trim() : 'https://t.me/yourchannel';

const whitelistedUsers = new Set();
const userStates = {}; 
const activeSessions = new Map();
const activeOtpPolling = new Map();
const jobQueue = new Map();

const SPEED_MODES = {
    fast: { batch: 10, delay: 1000 },
    normal: { batch: 5, delay: 3000 },
    slow: { batch: 2, delay: 6000 }
};

let sock; 
let isConnectingWA = false;

const sqlDb = new sqlite3.Database('./pansa_bot.db');

const dbRun = (sql, params = []) => new Promise((res, rej) => sqlDb.run(sql, params, function(err) { 
    if(err) rej(err); else res(this); 
}));
const dbGet = (sql, params = []) => new Promise((res, rej) => sqlDb.get(sql, params, (err, row) => 
    err ? rej(err) : res(row)
));
const dbAll = (sql, params = []) => new Promise((res, rej) => sqlDb.all(sql, params, (err, rows) => 
    err ? rej(err) : res(rows)
));

sqlDb.serialize(() => {
    dbRun(`CREATE TABLE IF NOT EXISTS sessions (chat_id TEXT PRIMARY KEY, cookies TEXT, last_total_sms INTEGER DEFAULT -1)`);
    dbRun(`CREATE TABLE IF NOT EXISTS seen_ids (msg_id TEXT PRIMARY KEY, chat_id TEXT)`);
    dbRun(`CREATE TABLE IF NOT EXISTS wa_numbers (number TEXT PRIMARY KEY, chat_id TEXT, range_name TEXT)`);
    dbRun(`CREATE TABLE IF NOT EXISTS whitelisted_users (chat_id TEXT PRIMARY KEY, username TEXT, added_at TEXT)`);
    dbRun(`CREATE TABLE IF NOT EXISTS user_assigned_numbers (user_chat_id TEXT PRIMARY KEY, number TEXT, range_name TEXT, assigned_at TEXT)`);
    dbRun(`CREATE TABLE IF NOT EXISTS used_numbers (number TEXT PRIMARY KEY, user_chat_id TEXT)`);
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function getTodayUTC() { return new Date().toISOString().split('T')[0]; }

function isAdmin(chatId) {
    return ADMIN_CHAT_ID && chatId.toString() === ADMIN_CHAT_ID;
}

function isUser(chatId) {
    return whitelistedUsers.has(chatId.toString());
}

function canAccess(chatId) {
    return isAdmin(chatId) || isUser(chatId);
}

async function loadWhitelistedUsers() {
    const rows = await dbAll('SELECT chat_id FROM whitelisted_users');
    rows.forEach(r => whitelistedUsers.add(r.chat_id));
}

async function checkForceSub(chatId) {
    if (!REQUIRED_CHANNEL_ID) return true; 
    if (isAdmin(chatId)) return true; 

    try {
        const member = await bot.getChatMember(REQUIRED_CHANNEL_ID, chatId);
        return ['creator', 'administrator', 'member', 'restricted'].includes(member.status);
    } catch (e) {
        return false;
    }
}

async function sendForceSubMessage(chatId, msgId = null) {
    const text = `🚫 *𝗔𝗖𝗖𝗘𝗦𝗦 𝗗𝗘𝗡𝗜𝗘𝗗*\n━━━━━━━━━━━━━━━━━━━━━━\nAkses dibatasi. Anda wajib bergabung dengan *Channel Resmi* kami untuk menggunakan layanan ini.\n\n👇 _Silakan join melalui tautan di bawah:_`;
    const markup = {
        inline_keyboard: [
            [{ text: '🔗 Join Channel Resmi', url: REQUIRED_CHANNEL_LINK }],
            [{ text: '✅ Saya Sudah Join', callback_data: 'check_join' }]
        ]
    };
    if (msgId) {
        await safeEditMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: markup });
    } else {
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: markup });
    }
}

const getMainMenuMarkup = () => ({
    inline_keyboard: [
        [{ text: '🔑 Cookies Auth', callback_data: 'cmd_login' }, { text: '🗃 Sync Database', callback_data: 'cmd_sync_db' }],
        [{ text: '🔍 Global Inbox', callback_data: 'cmd_search' }, { text: '🛒 Browse Range', callback_data: 'cmd_search_range' }],
        [{ text: '📡 Auto-Snipe WA', callback_data: 'cmd_hunt_wa' }, { text: '📱 Extract Data WA', callback_data: 'cmd_get_wa_numbers_0' }],
        [{ text: '🔗 Connect Meta', callback_data: 'cmd_wa_login' }, { text: '🔌 Disconnect Meta', callback_data: 'cmd_wa_logout' }],
        [{ text: '🗑 Purge All Data', callback_data: 'cmd_delete_all' }, { text: '🚪 Terminate Session', callback_data: 'cmd_logout' }],
        [{ text: '👥 User Access', callback_data: 'cmd_manage_users' }, { text: '⚙️ System Health', callback_data: 'cmd_status' }]
    ]
});

const getUserMenuMarkup = () => ({
    inline_keyboard: [
        [{ text: '📱 Request New Number', callback_data: 'user_get_number' }],
    ]
});

const getCancelMarkup = () => ({ 
    inline_keyboard: [[{ text: '❌ Batalkan Operasi', callback_data: 'cmd_cancel' }]] 
});

function formatMessageCard(msgData) {
    const otpMatch = msgData.text.match(/\b\d{3}[-\s]?\d{3}\b/) || msgData.text.match(/\b\d{4,8}\b/);
    const cleanOtp = otpMatch ? otpMatch[0].replace(/\D/g, '') : null;
    
    let text = `✦ *𝗦𝗘𝗖𝗨𝗥𝗘 𝗢𝗧𝗣 𝗚𝗔𝗧𝗘𝗪𝗔𝗬* ✦\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `📱 𝗡𝘂𝗺𝗯𝗲𝗿 : \`${msgData.phoneNumber}\`\n`;
    text += `🌍 𝗥𝗲𝗴𝗶𝗼𝗻 : ${msgData.countryRange}\n`;
    text += `📨 𝗦𝗲𝗻𝗱𝗲𝗿 : ${msgData.sender}\n`;
    text += `⏱ 𝗧𝗶𝗺𝗲   : ${msgData.time} (UTC)\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `💬 𝗠𝗲𝘀𝘀𝗮𝗴𝗲 :\n_${msgData.text}_\n`;
    
    if (cleanOtp) {
        text += `\n🔑 *𝗘𝘅𝘁𝗿𝗮𝗰𝘁𝗲𝗱 𝗢𝗧𝗣* : \`${cleanOtp}\``;
    }
    
    const inline_keyboard = [];
    if (cleanOtp) inline_keyboard.push([{ text: `📋 Copy OTP: ${cleanOtp}`, callback_data: 'dummy_btn' }]);
    inline_keyboard.push([{ text: '🤖 Kembali ke Dashboard', url: `https://t.me/${process.env.BOT_USERNAME || 'bot'}` }]); 
    
    return { text, reply_markup: { inline_keyboard } };
}

async function safeEditMessageText(text, options) {
    try { 
        await bot.editMessageText(text, options); 
    } catch (e) { 
        if (!e.message.includes('message is not modified')) console.error(e.message); 
    }
}

class IVASAccount {
    constructor(chatId, cookies) {
        this.chatId = chatId;
        this.cookies = cookies;
        this.jar = new CookieJar();
        this.client = wrapper(axios.create({
            jar: this.jar, 
            baseURL: 'https://www.ivasms.com', 
            timeout: 15000,
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
                    this.loggedIn = true; 
                    return true;
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

    async getLiveNumbers(terminationId) {
        try {
            const payload = new URLSearchParams({ '_token': this.csrfToken, 'termination_id': terminationId });
            const res = await this.client.post('/portal/live/getNumbers', payload.toString(), {
                headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }
            });
            if (res.status === 200 && Array.isArray(res.data)) return res.data.map(item => item.Number.toString());
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
            const payload = new URLSearchParams({ 'from': dateStr, 'to': dateStr, '_token': this.csrfToken });
            const res = await this.client.post('/portal/sms/received/getsms', payload.toString(), { 
                headers: { 'X-Requested-With': 'XMLHttpRequest' } 
            });
            if (res.status === 200) {
                const $ = cheerio.load(res.data);
                const countries = []; 
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
                headers: { 'X-Requested-With': 'XMLHttpRequest' } 
            });
            if (res.status === 200) {
                const numbers = []; 
                const $ = cheerio.load(res.data);
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
                headers: { 'X-Requested-With': 'XMLHttpRequest' } 
            });
            if (res.status === 200) {
                const messages = []; 
                const $ = cheerio.load(res.data);
                $('tbody tr').each((i, el) => {
                    const text = $(el).find('.msg-text').text().trim();
                    if (text) {
                        messages.push({ 
                            sender: $(el).find('.cli-tag').text().trim(), 
                            text, 
                            time: $(el).find('.time-cell').text().trim(), 
                            phoneNumber, 
                            countryRange 
                        });
                    }
                }); 
                return messages;
            } 
            return [];
        } catch (e) { return []; }
    }
}

async function startIvasSession(chatId) {
    try {
        const session = await dbGet('SELECT cookies FROM sessions WHERE chat_id = ?', [chatId]);
        if (session && session.cookies) {
            const cookiesObj = JSON.parse(session.cookies);
            const account = new IVASAccount(chatId, cookiesObj);
            if (await account.initSession()) {
                activeSessions.set(chatId, account);
                return true;
            }
        }
    } catch (error) { console.error('[System] Error startIvasSession:', error); }
    return false;
}

function getAdminSession() {
    return activeSessions.get(ADMIN_CHAT_ID) || null;
}

async function startWA(phoneNumberForPairing = null, reportChatId = ADMIN_CHAT_ID, msgId = null) {
    if (isConnectingWA) return; 
    isConnectingWA = true;

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();
    
    sock = makeWASocket({ 
        version, 
        printQRInTerminal: false, 
        browser: Browsers.macOS('Chrome'), 
        auth: state, 
        logger: pino({ level: 'silent' }), 
        markOnlineOnConnect: false, 
        generateHighQualityLinkPreview: true 
    });
    
    sock.ev.on('creds.update', saveCreds);

    const notifyUI = async (text) => {
        const opts = { parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() };
        if (msgId) await safeEditMessageText(text, { chat_id: reportChatId, message_id: msgId, ...opts });
        else if (phoneNumberForPairing) await bot.sendMessage(reportChatId, text, opts).catch(()=>{});
    };

    if (phoneNumberForPairing && !sock.authState.creds.registered) {
        await notifyUI(`❖ *𝗠𝗘𝗧𝗔 𝗜𝗡𝗧𝗘𝗚𝗥𝗔𝗧𝗜𝗢𝗡*\n━━━━━━━━━━━━━━━━━━━━━━\n⏳ Menghubungkan ke server...\nMeminta kode pairing untuk: \`${phoneNumberForPairing}\``);
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumberForPairing);
                const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
                await notifyUI(`✅ *𝗣𝗔𝗜𝗥𝗜𝗡𝗚 𝗖𝗢𝗗𝗘 𝗥𝗘𝗔𝗗𝗬*\n━━━━━━━━━━━━━━━━━━━━━━\n🔑 \`${formattedCode}\`\n\n1️⃣ Buka WhatsApp di perangkat utama\n2️⃣ Navigasi ke *Linked Devices*\n3️⃣ Pilih *Link with phone number instead*\n4️⃣ Masukkan kode di atas.`);
            } catch (error) { 
                await notifyUI(`❌ *ERROR: Request Gagal*\n${error.message}`); 
                isConnectingWA = false; 
            }
        }, 4000); 
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            isConnectingWA = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            
            if (statusCode !== DisconnectReason.loggedOut) {
                setTimeout(() => startWA(null, reportChatId, msgId), 5000); 
            } else { 
                if (msgId) await notifyUI("❌ *𝗦𝗘𝗦𝗦𝗜𝗢𝗡 𝗧𝗘𝗥𝗠𝗜𝗡𝗔𝗧𝗘𝗗*\nWhatsApp telah diputuskan dari perangkat.");
                if (fs.existsSync('./auth_info_baileys')) fs.rmSync('./auth_info_baileys', { recursive: true, force: true }); 
                sock = null; 
            }
        } else if (connection === 'open') { 
            isConnectingWA = false; 
            if (msgId || phoneNumberForPairing) await notifyUI('✅ *𝗠𝗘𝗧𝗔 𝗦𝗬𝗡𝗖 𝗦𝗨𝗖𝗖𝗘𝗦𝗦*\nKoneksi WhatsApp berhasil dibangun.'); 
        }
    });
}

async function autoFilterAndSaveNumbers(chatId, numbersObjArray, msgId) {
    if (!numbersObjArray || numbersObjArray.length === 0) {
        await safeEditMessageText(`✅ *𝗔𝗖𝗧𝗜𝗢𝗡 𝗖𝗢𝗠𝗣𝗟𝗘𝗧𝗘*\nData kosong. Tidak ada nomor di akun ini.`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        return;
    }

    if (!sock?.authState?.creds?.registered) {
        await safeEditMessageText(`⚠️ *𝗠𝗘𝗧𝗔 𝗗𝗜𝗦𝗖𝗢𝗡𝗡𝗘𝗖𝗧𝗘𝗗*\nMemotong tahapan filter WhatsApp...\nMenyimpan *${numbersObjArray.length}* nomor mentah ke dalam database...`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        
        const placeholders = numbersObjArray.map(() => '(?, ?, ?)').join(', ');
        const values = numbersObjArray.flatMap(n => [n.number, chatId, n.range]);
        await dbRun(`INSERT OR IGNORE INTO wa_numbers (number, chat_id, range_name) VALUES ${placeholders}`, values);
        
        await safeEditMessageText(`✅ *𝗦𝗬𝗡𝗖 𝗖𝗢𝗠𝗣𝗟𝗘𝗧𝗘*\n${numbersObjArray.length} data berhasil diamankan.`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        return;
    }

    const CONCURRENCY = 20;
    let activeCount = 0;
    let processed = 0;
    const total = numbersObjArray.length;

    await safeEditMessageText(`⚡ *𝗔𝗨𝗧𝗢-𝗙𝗜𝗟𝗧𝗘𝗥 𝗘𝗡𝗚𝗜𝗡𝗘 𝗔𝗖𝗧𝗜𝗩𝗘*\nMemproses *${total}* threads secara konkuren...\n\n⏳ Progress: 0 / ${total}`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });

    for (let i = 0; i < total; i += CONCURRENCY) {
        const chunk = numbersObjArray.slice(i, i + CONCURRENCY);

        const results = await Promise.allSettled(
            chunk.map(async (n) => {
                const jid = `${n.number}@s.whatsapp.net`;
                try {
                    const [status] = await sock.onWhatsApp(jid);
                    if (status?.exists) return n;
                } catch (e) {}
                return null;
            })
        );

        const batchInsert = [];
        for (const r of results) {
            processed++;
            if (r.status === 'fulfilled' && r.value !== null) {
                batchInsert.push(r.value);
                activeCount++;
            }
        }

        if (batchInsert.length > 0) {
            const placeholders = batchInsert.map(() => '(?, ?, ?)').join(', ');
            const values = batchInsert.flatMap(n => [n.number, chatId, n.range]);
            await dbRun(`INSERT OR IGNORE INTO wa_numbers (number, chat_id, range_name) VALUES ${placeholders}`, values).catch(() => {});
        }

        safeEditMessageText(`⚡ *𝗔𝗨𝗧𝗢-𝗙𝗜𝗟𝗧𝗘𝗥 𝗘𝗡𝗚𝗜𝗡𝗘...*\nProgress: ${processed} / ${total}\n✅ Verified Meta Data: *${activeCount}*`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(() => {});
        await delay(300);
    }

    await safeEditMessageText(`✅ *𝗙𝗜𝗟𝗧𝗘𝗥 𝗢𝗣𝗘𝗥𝗔𝗧𝗜𝗢𝗡 𝗖𝗢𝗠𝗣𝗟𝗘𝗧𝗘*\n━━━━━━━━━━━━━━━━━━━━━━\nTotal Scan : ${total}\nVerified WA : *${activeCount}* data`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
}

async function assignRandomNumberToUser(userChatId) {
    const existing = await dbGet('SELECT number, range_name FROM user_assigned_numbers WHERE user_chat_id = ?', [userChatId]);
    if (existing) return existing; 

    const query = `
        SELECT number, range_name FROM wa_numbers 
        WHERE number NOT IN (SELECT number FROM user_assigned_numbers)
        AND number NOT IN (SELECT number FROM used_numbers WHERE user_chat_id != ?)
        ORDER BY RANDOM() LIMIT 1
    `;

    const row = await dbGet(query, [userChatId]);
    if (!row) return null;

    const now = new Date().toISOString();
    await dbRun(
        `INSERT OR REPLACE INTO user_assigned_numbers (user_chat_id, number, range_name, assigned_at) VALUES (?, ?, ?, ?)`,
        [userChatId, row.number, row.range_name, now]
    );

    return { number: row.number, range_name: row.range_name };
}

async function releaseNumberFromUser(userChatId) {
    await dbRun('DELETE FROM user_assigned_numbers WHERE user_chat_id = ?', [userChatId]);
}

async function checkOtpForNumber(number, rangeName) {
    const acc = getAdminSession();
    if (!acc || !acc.loggedIn) return null;

    const todayStr = getTodayUTC();
    try {
        const messages = await acc.getMessages(number, rangeName, todayStr);
        if (messages && messages.length > 0) {
            return messages[messages.length - 1]; 
        }
    } catch (e) {}
    return null;
}

function stopOtpPolling(userChatId) {
    const existing = activeOtpPolling.get(userChatId);
    if (existing) {
        clearTimeout(existing.timeoutId);
        activeOtpPolling.delete(userChatId);
    }
}

async function startOtpPolling(userChatId, number, rangeName, msgId) {
    stopOtpPolling(userChatId);

    let attempts = 0;
    const MAX_ATTEMPTS = 24; 
    const lastSeenId = userStates[userChatId]?.lastSeenMsgId;

    const poll = async () => {
        attempts++;
        const elapsed = attempts * 5;

        await safeEditMessageText(
            `🔄 *𝗟𝗜𝗩𝗘 𝗣𝗢𝗟𝗟𝗜𝗡𝗚 𝗘𝗡𝗚𝗜𝗡𝗘*\n━━━━━━━━━━━━━━━━━━━━━━\n📱 𝗡𝘂𝗺𝗯𝗲𝗿 : \`${number}\`\n🌍 𝗥𝗲𝗴𝗶𝗼𝗻 : ${rangeName}\n\n⏳ Iterasi ke-${attempts} (${elapsed}s)...\n_Harap selesaikan permintaan OTP di aplikasi target._`,
            { 
                chat_id: userChatId, 
                message_id: msgId, 
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '❌ Batalkan Operasi', callback_data: 'user_cancel_otp' }]] }
            }
        ).catch(() => {});

        const msg = await checkOtpForNumber(number, rangeName);
        const currentMsgId = msg ? `${msg.time}_${msg.text}` : null;
        
        if (msg && currentMsgId !== lastSeenId) {
            stopOtpPolling(userChatId);
            
            if (!userStates[userChatId]) userStates[userChatId] = {};
            userStates[userChatId].lastSeenMsgId = currentMsgId;

            await dbRun(`INSERT OR REPLACE INTO used_numbers (number, user_chat_id) VALUES (?, ?)`, [number, userChatId]);

            const otpMatch = msg.text.match(/\b\d{4,8}\b/g);
            const otp = otpMatch ? otpMatch[0] : null;
            
            let replyText = `✦ *𝗡𝗘𝗪 𝗢𝗧𝗣 𝗥𝗘𝗖𝗘𝗜𝗩𝗘𝗗* ✦\n━━━━━━━━━━━━━━━━━━━━━━\n`;
            replyText += `📱 𝗡𝘂𝗺𝗯𝗲𝗿 : \`${number}\`\n📨 𝗦𝗲𝗻𝗱𝗲𝗿 : ${msg.sender}\n⏱ 𝗧𝗶𝗺𝗲   : ${msg.time} (UTC)\n`;
            replyText += `🔐 *𝗦𝘁𝗮𝘁𝘂𝘀 : Node Locked ke Akun Anda*\n\n💬 𝗠𝗲𝘀𝘀𝗮𝗴𝗲 :\n_${msg.text}_\n`;
            
            if (otp) replyText += `━━━━━━━━━━━━━━━━━━━━━━\n🔑 *𝗘𝘅𝘁𝗿𝗮𝗰𝘁𝗲𝗱 𝗢𝗧𝗣 : \`${otp}\`*`;

            await safeEditMessageText(replyText, {
                chat_id: userChatId,
                message_id: msgId,
                parse_mode: 'Markdown',
                reply_markup: { 
                    inline_keyboard: [
                        otp ? [{ text: `📋 Copy OTP: ${otp}`, callback_data: 'dummy_btn' }] : [],
                        [{ text: '🔄 Request Nomor Baru', callback_data: 'user_new_number' }, { text: '🔁 Listen OTP Lagi', callback_data: 'user_get_otp' }]
                    ].filter(r => r.length > 0)
                }
            }).catch(() => {});
            return;
        }

        if (attempts >= MAX_ATTEMPTS) {
            stopOtpPolling(userChatId);
            await safeEditMessageText(
                `⏰ *𝗣𝗢𝗟𝗟𝗜𝗡𝗚 𝗧𝗜𝗠𝗘𝗢𝗨𝗧*\n━━━━━━━━━━━━━━━━━━━━━━\nServer tidak menerima OTP baru selama 2 menit.\nTarget: \`${number}\`\n\nPastikan instruksi pengiriman OTP telah ditekan pada platform target.`,
                { 
                    chat_id: userChatId, 
                    message_id: msgId, 
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '🔄 Ganti Nomor Lain', callback_data: 'user_new_number' }, { text: '🔁 Ulangi Listen OTP', callback_data: 'user_get_otp' }]] }
                }
            ).catch(() => {});
            return;
        }

        const timeoutId = setTimeout(poll, 5000);
        activeOtpPolling.set(userChatId, { timeoutId, msgId });
    };

    const timeoutId = setTimeout(poll, 5000);
    activeOtpPolling.set(userChatId, { timeoutId, msgId });
}

async function processBulkCheck(numbers, config, chatId, msgId) {
    let resPersonal = "=== WA PERSONAL ===\n\n";
    let resBisnis = "=== WA BISNIS ===\n\n";
    let resUnreg = "=== UNREGISTERED ===\n\n";
    
    let countP = 0, countB = 0, countU = 0;
    let processed = 0;
    const total = numbers.length;
    
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
                        if (biz) { 
                            result.isBiz = true; 
                            result.desc = biz.description || '-'; 
                            result.cat = biz.category || '-'; 
                        } 
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
                    if (v.isBiz) { 
                        resBisnis += `${v.num}\nBio: ${v.bio}\nCat: ${v.cat}\nDesc: ${v.desc}\nDP: ${v.dp}\n---\n`; 
                        countB++; 
                    } else { 
                        resPersonal += `${v.num}\nBio: ${v.bio}\nDP: ${v.dp}\n---\n`; 
                        countP++; 
                    } 
                } else { 
                    resUnreg += `${v.num}\n`; 
                    countU++; 
                } 
            } 
        });
        
        processed += batch.length; 
        safeEditMessageText(`⏳ *𝗕𝗨𝗟𝗞 𝗘𝗫𝗧𝗥𝗔𝗖𝗧𝗜𝗢𝗡 𝗔𝗖𝗧𝗜𝗩𝗘*\nProgress: ${processed} / ${total}\n_Cooldown ${config.delay/1000}s..._`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }); 
        if (processed < total) await delay(config.delay);
    }
    
    safeEditMessageText(`✅ *𝗘𝗫𝗧𝗥𝗔𝗖𝗧𝗜𝗢𝗡 𝗖𝗢𝗠𝗣𝗟𝗘𝗧𝗘*\n━━━━━━━━━━━━━━━━━━━━━━\n📊 Total Analyzed : ${total}\n👤 Personal : *${countP}*\n🏢 Business : *${countB}*\n❌ Unregistered : *${countU}*`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
    if (countP > 0) bot.sendDocument(chatId, Buffer.from(resPersonal, 'utf-8'), {}, { filename: `Personal_Lead_${Date.now()}.txt`, contentType: 'text/plain' });
    if (countB > 0) bot.sendDocument(chatId, Buffer.from(resBisnis, 'utf-8'), {}, { filename: `Business_Lead_${Date.now()}.txt`, contentType: 'text/plain' });
    if (countU > 0) bot.sendDocument(chatId, Buffer.from(resUnreg, 'utf-8'), {}, { filename: `Unregistered_${Date.now()}.txt`, contentType: 'text/plain' });
}

async function pollAllAccounts() {
    const today = getTodayUTC();
    const sessions = await dbAll('SELECT * FROM sessions');

    try {
        for (const session of sessions) {
            const chatId = session.chat_id;
            const account = activeSessions.get(chatId);
            if (!account || !account.loggedIn) continue;

            try {
                const checkData = await account.getCountries(today);
                let hasNew = false;
                
                for (const country of checkData.countries) {
                    const numbersInCountry = await account.getNumbers(country, today);
                    for (const number of numbersInCountry) {
                        const messages = await account.getMessages(number, country, today);
                        for (const msg of messages) {
                            const msgId = `${msg.phoneNumber}_${msg.time}_${msg.sender}`;
                            const isSeen = await dbGet('SELECT msg_id FROM seen_ids WHERE msg_id = ? AND chat_id = ?', [msgId, chatId]);
                            
                            if (!isSeen) {
                                await dbRun('INSERT INTO seen_ids (msg_id, chat_id) VALUES (?, ?)', [msgId, chatId]);
                                hasNew = true;
                            }
                        }
                    }
                }
                
                if (hasNew) { 
                    await dbRun(`DELETE FROM seen_ids WHERE rowid NOT IN (SELECT rowid FROM seen_ids WHERE chat_id = ? ORDER BY rowid DESC LIMIT 1000)`, [chatId]);
                }
            } catch (e) {
                if (e.response && (e.response.status === 401 || e.response.status === 403)) { 
                    account.loggedIn = false; 
                    activeSessions.delete(chatId); 
                }
            }
        }
    } finally {
        setTimeout(pollAllAccounts, POLLING_INTERVAL);
    }
}

bot.onText(/\/(start|menu)/, async (msg) => {
    const chatId = msg.chat.id.toString();
    bot.deleteMessage(chatId, msg.message_id).catch(()=>{});
    
    if (isAdmin(chatId)) {
        const sentMsg = await bot.sendMessage(chatId, `❖ *𝗣𝗔𝗡𝗦𝗔 𝗔𝗜 𝗪𝗢𝗥𝗞𝗦𝗣𝗔𝗖𝗘* ❖\n━━━━━━━━━━━━━━━━━━━━━━\nSelamat datang di Control Panel. Silakan pilih modul administrasi di bawah ini:`, { parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        userStates[chatId] = { state: 'IDLE', lastMsgId: sentMsg.message_id };
    } else if (isUser(chatId)) {
        if (!(await checkForceSub(chatId))) return sendForceSubMessage(chatId);

        const sentMsg = await bot.sendMessage(chatId, `❖ *𝗣𝗔𝗡𝗦𝗔 𝗖𝗟𝗜𝗘𝗡𝗧 𝗣𝗢𝗥𝗧𝗔𝗟* ❖\n━━━━━━━━━━━━━━━━━━━━━━\nAkses diverifikasi. Anda terhubung dengan API Infrastruktur kami.\n\n👇 Gunakan modul di bawah untuk memulai:`, { parse_mode: 'Markdown', reply_markup: getUserMenuMarkup() });
        userStates[chatId] = { state: 'IDLE', lastMsgId: sentMsg.message_id };
    } else {
        bot.sendMessage(chatId, "🚫 *𝗔𝗖𝗖𝗘𝗦𝗦 𝗗𝗘𝗡𝗜𝗘𝗗*\nAnda tidak memiliki izin (whitelist) pada sistem ini.", { parse_mode: 'Markdown' });
    }
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id.toString();
    const msgId = query.message.message_id;
    const action = query.data;

    bot.answerCallbackQuery(query.id);
    
    if (!canAccess(chatId)) {
        return bot.answerCallbackQuery(query.id, { text: "⛔ Akses ditolak.", show_alert: true });
    }

    if (action === 'dummy_btn') return; 

    if (action === 'check_join') {
        const isSubbed = await checkForceSub(chatId);
        if (isSubbed) {
            bot.answerCallbackQuery(query.id, { text: "✅ Verifikasi berhasil! Menginisialisasi sistem..." });
            const markup = isUser(chatId) && !isAdmin(chatId) ? getUserMenuMarkup() : getMainMenuMarkup();
            return safeEditMessageText(`❖ *𝗣𝗔𝗡𝗦𝗔 𝗖𝗟𝗜𝗘𝗡𝗧 𝗣𝗢𝗥𝗧𝗔𝗟* ❖\n━━━━━━━━━━━━━━━━━━━━━━\nAkses diverifikasi. Anda terhubung dengan API Infrastruktur kami.\n\n👇 Gunakan modul di bawah untuk memulai:`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: markup });
        } else {
            return bot.answerCallbackQuery(query.id, { text: "❌ Sistem mendeteksi Anda belum berada di Channel!", show_alert: true });
        }
    }

    if (isUser(chatId) && !isAdmin(chatId)) {
        if (!(await checkForceSub(chatId))) {
            return sendForceSubMessage(chatId, msgId);
        }
    }

    if (action === 'user_get_number' || action === 'user_new_number') {
        if (action === 'user_new_number') {
            stopOtpPolling(chatId);
            await releaseNumberFromUser(chatId);
        }

        const acc = getAdminSession();
        if (!acc || !acc.loggedIn) {
            return safeEditMessageText("⚠️ *𝗦𝗬𝗦𝗧𝗘𝗠 𝗢𝗙𝗙𝗟𝗜𝗡𝗘*\nInfrastruktur API belum diinisialisasi oleh Administrator.", {
                chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                reply_markup: getUserMenuMarkup()
            });
        }

        await safeEditMessageText("🔄 *𝗘𝗫𝗘𝗖𝗨𝗧𝗜𝗡𝗚 𝗥𝗘𝗤𝗨𝗘𝗦𝗧*\nMengalokasikan *dedicated line* pada server...", {
            chat_id: chatId, message_id: msgId, parse_mode: 'Markdown'
        });

        const assigned = await assignRandomNumberToUser(chatId);
        
        if (!assigned) {
            return safeEditMessageText("❌ *𝗡𝗢 𝗥𝗘𝗦𝗢𝗨𝗥𝗖𝗘𝗦 𝗔𝗩𝗔𝗜𝗟𝗔𝗕𝗟𝗘*\nSeluruh node / nomor sedang dioperasikan oleh pengguna lain.", {
                chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '🔄 Coba Request Ulang', callback_data: 'user_get_number' }]] }
            });
        }

        userStates[chatId] = { 
            ...userStates[chatId], 
            assignedNumber: assigned.number, 
            assignedRange: assigned.range_name,
            lastSeenMsgId: null
        };

        await safeEditMessageText(
            `✅ *𝗥𝗘𝗦𝗢𝗨𝗥𝗖𝗘 𝗔𝗟𝗟𝗢𝗖𝗔𝗧𝗘𝗗*\n━━━━━━━━━━━━━━━━━━━━━━\n📱 𝗡𝘂𝗺𝗯𝗲𝗿 : \`${assigned.number}\`\n🌍 𝗥𝗲𝗴𝗶𝗼𝗻 : ${assigned.range_name}\n\n💡 _Node telah disiapkan. Input nomor pada platform, lalu aktifkan mode Listening._`,
            {
                chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: `📋 Copy Data: ${assigned.number}`, callback_data: 'dummy_btn' }],
                        [{ text: '📨 Start Listening (Get OTP)', callback_data: 'user_get_otp' }],
                        [{ text: '🔄 Regenerate Line', callback_data: 'user_new_number' }]
                    ]
                }
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
            if (!assigned) {
                return safeEditMessageText("❌ *𝗘𝗥𝗥𝗢𝗥 𝗜𝗡𝗩𝗔𝗟𝗜𝗗 𝗦𝗧𝗔𝗧𝗘*\nTidak ada session yang aktif. Tekan Request New Number.", {
                    chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                    reply_markup: getUserMenuMarkup()
                });
            }
            userStates[chatId] = { ...userStates[chatId], assignedNumber: assigned.number, assignedRange: assigned.range_name };
        }

        const finalNumber = userStates[chatId]?.assignedNumber;
        const finalRange = userStates[chatId]?.assignedRange;

        await safeEditMessageText(
            `🔍 *𝗜𝗡𝗜𝗧𝗜𝗔𝗧𝗜𝗡𝗚 𝗟𝗜𝗦𝗧𝗘𝗡𝗘𝗥*\n━━━━━━━━━━━━━━━━━━━━━━\n📱 Target : \`${finalNumber}\`\n🌍 Node : ${finalRange}\n\nSinkronisasi real-time setiap 5 detik dimulai...`,
            { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
        );

        startOtpPolling(chatId, finalNumber, finalRange, msgId);
        return;
    }

    if (action === 'user_cancel_otp') {
        stopOtpPolling(chatId);
        const state = userStates[chatId];
        return safeEditMessageText(
            `✋ *𝗟𝗜𝗦𝗧𝗘𝗡𝗘𝗥 𝗧𝗘𝗥𝗠𝗜𝗡𝗔𝗧𝗘𝗗*\n━━━━━━━━━━━━━━━━━━━━━━\nProses dihentikan. Nomor masih dikunci di akun Anda:\n\`${state?.assignedNumber || '-'}\``,
            {
                chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📨 Resume Listening', callback_data: 'user_get_otp' }],
                        [{ text: '🔄 Release & Regenerate', callback_data: 'user_new_number' }]
                    ]
                }
            }
        );
    }

    if (!isAdmin(chatId)) return;

    if (!userStates[chatId]) userStates[chatId] = { state: 'IDLE', lastMsgId: msgId };

    if (action === 'cmd_manage_users') {
        const users = await dbAll('SELECT chat_id, username, added_at FROM whitelisted_users');
        let text = `👥 *𝗔𝗖𝗖𝗘𝗦𝗦 𝗠𝗔𝗡𝗔𝗚𝗘𝗠𝗘𝗡𝗧*\n━━━━━━━━━━━━━━━━━━━━━━\nTotal: ${users.length} Active Users\n\n`;
        if (users.length > 0) {
            users.forEach((u, i) => { text += `${i+1}. ${u.username || 'Guest'} (\`${u.chat_id}\`)\n`; });
        } else {
            text += '_Database kosong._\n';
        }
        text += '\n_Console commands:_\n└ `/adduser <chat_id> <username>`\n└ `/removeuser <chat_id>`';
        safeEditMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '⬅️ Back to Workspace', callback_data: 'cmd_cancel' }]] } });
        return;
    }
    
    if (action === 'cmd_login') {
        userStates[chatId].state = 'WAITING_COOKIE';
        userStates[chatId].tempCookies = {};
        const markup = {
            inline_keyboard: [
                [{ text: '✅ Execute Auth Phase', callback_data: 'cmd_finish_login' }],
                [{ text: '❌ Abort', callback_data: 'cmd_cancel' }]
            ]
        };
        safeEditMessageText("🔑 *𝗔𝗨𝗧𝗛𝗘𝗡𝗧𝗜𝗖𝗔𝗧𝗜𝗢𝗡 𝗚𝗔𝗧𝗘𝗪𝗔𝗬*\n━━━━━━━━━━━━━━━━━━━━━━\nInject session cookies. Gunakan format:\n`nama=nilai`\n\nContoh: `ivas_sms_session=eyJp...`", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: markup });
        return;
    } 
    
    if (action === 'cmd_finish_login') {
        if (!userStates[chatId] || !userStates[chatId].tempCookies) return;
        const cookiesObj = userStates[chatId].tempCookies;
        
        if (!cookiesObj['ivas_sms_session']) {
            const markup = { inline_keyboard: [[{ text: '❌ Abort', callback_data: 'cmd_cancel' }]] };
            return safeEditMessageText("❌ *𝗙𝗔𝗧𝗔𝗟 𝗘𝗥𝗥𝗢𝗥*\nPayload invalid. Parameter `ivas_sms_session` wajib ada.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: markup });
        }

        userStates[chatId].state = 'IDLE';
        await safeEditMessageText("⏳ *𝗦𝗬𝗡𝗖𝗜𝗡𝗚 𝗖𝗥𝗘𝗗𝗘𝗡𝗧𝗜𝗔𝗟𝗦...*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        
        await dbRun('INSERT OR REPLACE INTO sessions (chat_id, cookies) VALUES (?, ?)', [chatId, JSON.stringify(cookiesObj)]);
        const success = await startIvasSession(chatId);
        
        if (success) {
            const acc = activeSessions.get(chatId);
            const myNumbers = await acc.getMyNumbers();
            await dbRun('DELETE FROM wa_numbers WHERE chat_id = ?', [chatId]);
            
            if (myNumbers.length > 0) {
                await autoFilterAndSaveNumbers(chatId, myNumbers, msgId);
            } else {
                safeEditMessageText(`✅ *𝗔𝗨𝗧𝗛 𝗦𝗨𝗖𝗖𝗘𝗦𝗦𝗙𝗨𝗟*\nLogin tervalidasi. Dataset kosong (0 active nodes).`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
            }
        } else {
            safeEditMessageText("❌ *𝗔𝗨𝗧𝗛 𝗙𝗔𝗜𝗟𝗘𝗗*\nCookie expired atau *Invalid Signature*.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        }
        return;
    }
    
    if (action === 'cmd_sync_db') {
        if (!activeSessions.has(chatId)) return safeEditMessageText("⚠️ *𝗔𝗨𝗧𝗛 𝗥𝗘𝗤𝗨𝗜𝗥𝗘𝗗*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        safeEditMessageText("⏳ *𝗙𝗘𝗧𝗖𝗛𝗜𝗡𝗚 𝗗𝗔𝗧𝗔𝗦𝗘𝗧*\nMenarik cluster data via Endpoint...", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        
        const acc = activeSessions.get(chatId);
        const myNumbers = await acc.getMyNumbers();
        
        await dbRun('DELETE FROM wa_numbers WHERE chat_id = ?', [chatId]);
        
        if(myNumbers.length > 0) {
            await autoFilterAndSaveNumbers(chatId, myNumbers, msgId);
        } else {
            safeEditMessageText(`✅ *𝗦𝗬𝗡𝗖 𝗦𝗨𝗖𝗖𝗘𝗦𝗦𝗙𝗨𝗟*\nData sinkron. Nodes: 0.`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        }
        return;
    }
    
    if (action.startsWith('cmd_get_wa_numbers_')) {
        const offset = parseInt(action.replace('cmd_get_wa_numbers_', '')) || 0;
        const limit = 3;

        try {
            const countRow = await dbGet('SELECT COUNT(*) as count FROM wa_numbers WHERE chat_id = ?', [chatId]);
            const total = countRow.count;

            if (total === 0) {
                return safeEditMessageText("❌ *𝗘𝗠𝗣𝗧𝗬 𝗗𝗔𝗧𝗔𝗦𝗘𝗧*\nDatabase Meta Numbers bersih.\n_Execute module Sync atau Auto-Snipe._", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
            }

            const currentOffset = offset >= total ? 0 : offset;
            const numbers = await dbAll('SELECT number, range_name FROM wa_numbers WHERE chat_id = ? LIMIT ? OFFSET ?', [chatId, limit, currentOffset]);

            let text = `📱 *𝗩𝗘𝗥𝗜𝗙𝗜𝗘𝗗 𝗠𝗘𝗧𝗔 𝗗𝗔𝗧𝗔𝗦𝗘𝗧*\n━━━━━━━━━━━━━━━━━━━━━━\nShowing ${currentOffset + 1} - ${Math.min(currentOffset + limit, total)} of *${total}* records.\n\n`;
            const inline_keyboard = [];
            
            numbers.forEach((n, i) => {
                text += `${currentOffset + i + 1}. 🌍 *${n.range_name}*\n   └ 📱 \`${n.number}\`\n\n`;
                inline_keyboard.push([{ text: `📋 Ext: ${n.number}`, callback_data: 'dummy_btn' }]);
            });

            const navButtons = [];
            if (total > limit) {
                const nextOffset = currentOffset + limit;
                navButtons.push({ text: '🔄 Load More', callback_data: `cmd_get_wa_numbers_${nextOffset}` });
            }
            navButtons.push({ text: '⬅️ Back to Workspace', callback_data: 'cmd_cancel' });
            
            inline_keyboard.push(navButtons);
            safeEditMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard } });
        } catch (e) {
            safeEditMessageText(`⚠️ *𝗦𝗬𝗦𝗧𝗘𝗠 𝗘𝗥𝗥𝗢𝗥*: ${e.message}`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        }
        return;
    }
    
    if (action === 'cmd_search_range') {
        if (!activeSessions.has(chatId)) return safeEditMessageText("⚠️ *𝗔𝗨𝗧𝗛 𝗥𝗘𝗤𝗨𝗜𝗥𝗘𝗗*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        userStates[chatId].state = 'WAITING_RANGE';
        safeEditMessageText(`🛒 *𝗕𝗥𝗢𝗪𝗦𝗘 𝗠𝗔𝗥𝗞𝗘𝗧 𝗥𝗔𝗡𝗚𝗘*\n━━━━━━━━━━━━━━━━━━━━━━\nSilakan input string Range (e.g. \`INDONESIA 232428\`).\nSistem akan mengambil *available lines* dari API.`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getCancelMarkup() });
        return;
    }
    
    if (action.startsWith('term_detail_')) {
        if (!activeSessions.has(chatId)) return safeEditMessageText("⚠️ *𝗔𝗨𝗧𝗛 𝗥𝗘𝗤𝗨𝗜𝗥𝗘𝗗*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        const termId = action.replace('term_detail_', '');
        await safeEditMessageText("⏳ *𝗙𝗘𝗧𝗖𝗛𝗜𝗡𝗚 𝗡𝗢𝗗𝗘 𝗗𝗘𝗧𝗔𝗜𝗟𝗦...*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        
        const acc = activeSessions.get(chatId);
        const details = await acc.getTerminationDetails(termId);
        
        if (details) {
            let detailText = `📄 *𝗧𝗘𝗥𝗠𝗜𝗡𝗔𝗧𝗜𝗢𝗡 𝗦𝗣𝗘𝗖𝗦*\n━━━━━━━━━━━━━━━━━━━━━━\n📌 *Range:* \`${details.rangeName}\`\n💵 *A2P Yield:* ${details.a2pRate}\n\n📊 *Parameters:*\n`;
            details.limits.forEach(l => { detailText += `  └ *${l.key}:* ${l.val}\n`; });
            const detailMarkup = { inline_keyboard: [ [{ text: '➕ Execute Buy', callback_data: `add_term_${termId}` }], [{ text: '⬅️ Back', callback_data: 'cmd_cancel' }] ] };
            safeEditMessageText(detailText, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: detailMarkup });
        } else { 
            safeEditMessageText("❌ *𝗔𝗣𝗜 𝗙𝗔𝗨𝗟𝗧* - Gagal mengambil details.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() }); 
        }
        return;
    }
    
    if (action.startsWith('add_term_')) {
        if (!activeSessions.has(chatId)) return safeEditMessageText("⚠️ *𝗔𝗨𝗧𝗛 𝗥𝗘𝗤𝗨𝗜𝗥𝗘𝗗*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        const termId = action.replace('add_term_', '');
        await safeEditMessageText("⏳ *𝗘𝗫𝗘𝗖𝗨𝗧𝗜𝗡𝗚 𝗣𝗨𝗥𝗖𝗛𝗔𝗦𝗘...*\nKoneksi API diaktifkan...", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        
        const acc = activeSessions.get(chatId);
        const result = await acc.addNumber(termId);
        
        if (result && result.message) {
            const existingNums = await dbAll('SELECT number FROM wa_numbers WHERE chat_id = ?', [chatId]);
            const existingSet = new Set(existingNums.map(n => n.number));
            const allMyNumbers = await acc.getMyNumbers();
            const newNumbers = allMyNumbers.filter(n => !existingSet.has(n.number));
            
            if (newNumbers.length > 0) {
                await autoFilterAndSaveNumbers(chatId, newNumbers, msgId);
            } else {
                safeEditMessageText(`✅ *𝗧𝗥𝗔𝗡𝗦𝗔𝗖𝗧𝗜𝗢𝗡 𝗦𝗨𝗖𝗖𝗘𝗦𝗦*\n━━━━━━━━━━━━━━━━━━━━━━\nStatus: ${result.message}\n_Queue nomor baru belum siap._`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
            }
        } else { 
            safeEditMessageText("❌ *𝗧𝗥𝗔𝗡𝗦𝗔𝗖𝗧𝗜𝗢𝗡 𝗙𝗔𝗜𝗟𝗘𝗗*\nLimit tercapai atau *Race Condition* gagal dimenangkan.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() }); 
        }
        return;
    }
    
    if (action === 'cmd_hunt_wa') {
        if (!activeSessions.has(chatId)) return safeEditMessageText("⚠️ *𝗔𝗨𝗧𝗛 𝗥𝗘𝗤𝗨𝗜𝗥𝗘𝗗*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        const acc = activeSessions.get(chatId);
        const MAX_BUY = 4; 
        await safeEditMessageText(`🎯 *𝗦𝗡𝗜𝗣𝗘𝗥 𝗘𝗡𝗚𝗜𝗡𝗘 𝗢𝗡𝗟𝗜𝗡𝗘*\n━━━━━━━━━━━━━━━━━━━━━━\nSistem memonitor Live Feed SMS Meta secara background.\nMaksimum payload: ${MAX_BUY} Ranges...`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });

        const uniqueRanges = new Set();
        const purchasedRanges = [];
        const maxRetries = 100; 

        for (let i = 1; i <= maxRetries; i++) {
            const data = await acc.fetchLiveTestSMS();
            for (const item of data) {
                const $orig = cheerio.load(item.originator);
                const sender = $orig('p').text().trim().toLowerCase();
                
                if (sender.includes('whatsapp') || sender.includes('wa')) {
                    if (!uniqueRanges.has(item.range)) {
                        uniqueRanges.add(item.range);
                        await safeEditMessageText(`🎯 *𝗦𝗡𝗜𝗣𝗘𝗥 𝗟𝗢𝗖𝗞𝗘𝗗 𝗢𝗡 𝗧𝗔𝗥𝗚𝗘𝗧*\nFound: \`${item.range}\`\n_Executing micro-transaction..._`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
                        
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
            let reply = `✅ *𝗦𝗡𝗜𝗣𝗘𝗥 𝗘𝗫𝗘𝗖𝗨𝗧𝗜𝗢𝗡 𝗦𝗨𝗖𝗖𝗘𝗦𝗦*\n━━━━━━━━━━━━━━━━━━━━━━\nBerhasil bypass system & secure ${purchasedRanges.length} Node:\n\n`;
            purchasedRanges.forEach((d, i) => { reply += `${i+1}. 🌍 *${d.range}*\n   └ 💵 Yield: +$${d.rate}\n\n`; });
            
            await safeEditMessageText(reply + `⏳ _Initializing Meta Sync & Routing..._`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
            
            const existingNums = await dbAll('SELECT number FROM wa_numbers WHERE chat_id = ?', [chatId]);
            const existingSet = new Set(existingNums.map(n => n.number));
            const allMyNumbers = await acc.getMyNumbers();
            const newNumbers = allMyNumbers.filter(n => !existingSet.has(n.number));
            
            if (newNumbers.length > 0) {
                await delay(2000);
                await autoFilterAndSaveNumbers(chatId, newNumbers, msgId);
            } else {
                safeEditMessageText(reply + `❖ *𝗣𝗔𝗡𝗦𝗔 𝗔𝗜 𝗪𝗢𝗥𝗞𝗦𝗣𝗔𝗖𝗘*`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
            }
        } else {
            let reason = uniqueRanges.size > 0 ? "Target *Locked* namun di-*override* oleh buyer lain." : "Network Feed sepi dari traffic Meta.";
            safeEditMessageText(`❌ *𝗦𝗡𝗜𝗣𝗘𝗥 𝗢𝗣𝗘𝗥𝗔𝗧𝗜𝗢𝗡 𝗛𝗔𝗟𝗧𝗘𝗗*\n━━━━━━━━━━━━━━━━━━━━━━\n${reason}`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        }
        return;
    }
    
    if (action === 'cmd_search') {
        if (!activeSessions.has(chatId)) return safeEditMessageText("⚠️ *𝗔𝗨𝗧𝗛 𝗥𝗘𝗤𝗨𝗜𝗥𝗘𝗗*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        userStates[chatId].state = 'WAITING_NUMBER';
        const countRow = await dbGet('SELECT COUNT(*) as count FROM wa_numbers WHERE chat_id = ?', [chatId]);
        safeEditMessageText(`🔍 *𝗚𝗟𝗢𝗕𝗔𝗟 𝗜𝗡𝗕𝗢𝗫 𝗤𝗨𝗘𝗥𝗬*\n━━━━━━━━━━━━━━━━━━━━━━\nMasukkan format string untuk eksekusi regex.\nContoh: \`2250787560321\`\n\n_Local Meta Storage DB: ${countRow.count}_`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getCancelMarkup() });
        return;
    }
    
    if (action === 'cmd_delete_all') {
        if (!activeSessions.has(chatId)) return safeEditMessageText("⚠️ *𝗔𝗨𝗧𝗛 𝗥𝗘𝗤𝗨𝗜𝗥𝗘𝗗*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        const confirmMarkup = { inline_keyboard: [ [{ text: '⚠️ YA, EKSEKUSI PURGE', callback_data: 'cmd_confirm_delete_all' }], [{ text: '❌ Abort Sequence', callback_data: 'cmd_cancel' }] ] };
        safeEditMessageText("⚠️ *𝗖𝗥𝗜𝗧𝗜𝗖𝗔𝗟 𝗔𝗖𝗧𝗜𝗢𝗡 𝗗𝗘𝗧𝗘𝗖𝗧𝗘𝗗*\n━━━━━━━━━━━━━━━━━━━━━━\nOtorisasi diminta untuk mem-*purge* (mengembalikan) seluruh node dari database. Operasi ini bersifat ireversibel.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: confirmMarkup });
        return;
    }
    
    if (action === 'cmd_confirm_delete_all') {
        if (!activeSessions.has(chatId)) return safeEditMessageText("⚠️ *𝗔𝗨𝗧𝗛 𝗥𝗘𝗤𝗨𝗜𝗥𝗘𝗗*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        await safeEditMessageText("⏳ *𝗘𝗫𝗘𝗖𝗨𝗧𝗜𝗡𝗚 𝗕𝗨𝗟𝗞 𝗣𝗨𝗥𝗚𝗘...*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        
        const acc = activeSessions.get(chatId);
        const result = await acc.returnAllNumbers();
        
        if (result) {
            await dbRun('DELETE FROM wa_numbers WHERE chat_id = ?', [chatId]);
            await dbRun('DELETE FROM user_assigned_numbers'); 
            await dbRun('DELETE FROM used_numbers');
            
            safeEditMessageText(`✅ *𝗣𝗨𝗥𝗚𝗘 𝗖𝗢𝗠𝗣𝗟𝗘𝗧𝗘*\n━━━━━━━━━━━━━━━━━━━━━━\n${result.message || `API Acknowledged.`}\n_Local storage tables wiped._`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        } else {
            safeEditMessageText("❌ *𝗣𝗨𝗥𝗚𝗘 𝗙𝗔𝗜𝗟𝗘𝗗*\nAPI memutus koneksi atau timeout.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        }
        return;
    }
    
    if (action === 'cmd_status') {
        const countRow = await dbGet('SELECT COUNT(*) as count FROM wa_numbers WHERE chat_id = ?', [chatId]);
        const userCountRow = await dbGet('SELECT COUNT(*) as count FROM whitelisted_users');
        const assignedCountRow = await dbGet('SELECT COUNT(*) as count FROM user_assigned_numbers');
        const lockedCountRow = await dbGet('SELECT COUNT(*) as count FROM used_numbers');
        
        const statusMsg = `⚙️ *𝗦𝗬𝗦𝗧𝗘𝗠 𝗛𝗘𝗔𝗟𝗧𝗛*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
                          `🟢 *𝗜𝗩𝗔𝗦 𝗚𝗔𝗧𝗘𝗪𝗔𝗬  :* ${activeSessions.has(chatId) ? 'ONLINE' : 'OFFLINE'}\n` +
                          `🤖 *𝗠𝗘𝗧𝗔 𝗘𝗡𝗚𝗜𝗡𝗘  :* ${sock?.authState?.creds?.registered ? 'CONNECTED' : 'DISCONNECTED'}\n\n` +
                          `🗃 *𝗟𝗼𝗰𝗮𝗹 𝗗𝗮𝘁𝗮𝗯𝗮𝘀𝗲 :* ${countRow.count} Secure Nodes\n` +
                          `👥 *𝗪𝗵𝗶𝘁𝗲𝗹𝗶𝘀𝘁𝗲𝗱   :* ${userCountRow.count} Identities\n` +
                          `📱 *𝗔𝗰𝘁𝗶𝘃𝗲 𝗦𝗲𝘀𝘀𝗶𝗼𝗻𝘀:* ${assignedCountRow.count} Nodes Rented\n` +
                          `🔐 *𝗟𝗼𝗰𝗸𝗲𝗱 𝗡𝗼𝗱𝗲𝘀  :* ${lockedCountRow.count} Numbers Bound`;
                          
        safeEditMessageText(statusMsg, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        return;
    }
    
    if (action === 'cmd_logout') {
        await dbRun('DELETE FROM sessions WHERE chat_id = ?', [chatId]);
        await dbRun('DELETE FROM wa_numbers WHERE chat_id = ?', [chatId]);
        activeSessions.delete(chatId);
        safeEditMessageText("✅ *𝗦𝗘𝗦𝗦𝗜𝗢𝗡 𝗧𝗘𝗥𝗠𝗜𝗡𝗔𝗧𝗘𝗗*\nCookie data and cache flushed.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        return;
    }
    
    if (action === 'cmd_wa_login') {
        if (fs.existsSync('./auth_info_baileys/creds.json')) return bot.answerCallbackQuery(query.id, { text: 'Meta Socket is already connected.', show_alert: true });
        userStates[chatId].state = 'WAITING_WA_PHONE';
        safeEditMessageText("📱 *𝗠𝗘𝗧𝗔 𝗦𝗢𝗖𝗞𝗘𝗧 𝗖𝗢𝗡𝗡𝗘𝗖𝗧𝗜𝗢𝗡*\n━━━━━━━━━━━━━━━━━━━━━━\nInput nomor master root dengan *Country Code*.\n_(Format Murni: 628xxx, 447xxx, tanpa '+' atau '0')_", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getCancelMarkup() });
        return;
    }
    
    if (action === 'cmd_wa_logout') {
        if (fs.existsSync('./auth_info_baileys/creds.json')) {
            await safeEditMessageText("⏳ *𝗧𝗘𝗥𝗠𝗜𝗡𝗔𝗧𝗜𝗡𝗚 𝗠𝗘𝗧𝗔 𝗦𝗢𝗖𝗞𝗘𝗧...*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
            try { if (sock) await sock.logout(); } catch(e) {}
            if (fs.existsSync('./auth_info_baileys')) fs.rmSync('./auth_info_baileys', { recursive: true, force: true });
            sock = null;
            isConnectingWA = false;
            safeEditMessageText("✅ *𝗦𝗢𝗖𝗞𝗘𝗧 𝗖𝗟𝗢𝗦𝗘𝗗*\nSesi lokal dan server berhasil dihapus.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        } else {
            safeEditMessageText("⚠️ *𝗘𝗥𝗥𝗢𝗥 𝗜𝗡𝗩𝗔𝗟𝗜𝗗 𝗦𝗧𝗔𝗧𝗘*\nSocket tidak ditemukan.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        }
        return;
    }
    
    if (action === 'cmd_cancel') {
        userStates[chatId].state = 'IDLE';
        safeEditMessageText("⚠️ *𝗔𝗖𝗧𝗜𝗢𝗡 𝗔𝗕𝗢𝗥𝗧𝗘𝗗*\n\n❖ *𝗣𝗔𝗡𝗦𝗔 𝗔𝗜 𝗪𝗢𝗥𝗞𝗦𝗣𝗔𝗖𝗘*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        return;
    }
    
    if (action.startsWith('start_')) {
        if (!sock?.authState?.creds?.registered) return bot.answerCallbackQuery(query.id, { text: '⚠️ Meta Socket terputus!', show_alert: true });
        const parts = action.split('_');
        const mode = parts[parts.length - 1];
        const jobId = parts.slice(1, parts.length - 1).join('_');
        const numbersList = jobQueue.get(jobId);
        
        if (!numbersList) return bot.answerCallbackQuery(query.id, { text: 'File expired dalam memory heap.', show_alert: true });

        safeEditMessageText(`⏳ *𝗜𝗡𝗜𝗧𝗜𝗔𝗧𝗜𝗡𝗚 𝗕𝗨𝗟𝗞 𝗘𝗫𝗧𝗥𝗔𝗖𝗧𝗜𝗢𝗡*\n━━━━━━━━━━━━━━━━━━━━━━\n⚙️ Thread Mode : *${mode.toUpperCase()}*\n📊 Workload : *${numbersList.length}* payloads`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        processBulkCheck(numbersList, SPEED_MODES[mode], chatId, msgId);
        jobQueue.delete(jobId);
    }
});

bot.onText(/\/adduser (.+)/, async (msg, match) => {
    const chatId = msg.chat.id.toString();
    if (!isAdmin(chatId)) return;
    bot.deleteMessage(chatId, msg.message_id).catch(()=>{});

    const args = match[1].trim().split(/\s+/);
    const targetId = args[0];
    const username = args[1] || 'Guest';

    if (!targetId || isNaN(targetId)) {
        return bot.sendMessage(chatId, '❌ Syntax: `/adduser <chat_id> <username>`', { parse_mode: 'Markdown' });
    }

    await dbRun(
        'INSERT OR REPLACE INTO whitelisted_users (chat_id, username, added_at) VALUES (?, ?, ?)',
        [targetId, username, new Date().toISOString()]
    );
    whitelistedUsers.add(targetId);

    bot.sendMessage(chatId, `✅ Identity \`${targetId}\` terdaftar dalam sistem.`, { parse_mode: 'Markdown' });
    bot.sendMessage(targetId, `❖ *𝗦𝗬𝗦𝗧𝗘𝗠 𝗡𝗢𝗧𝗜𝗙𝗜𝗖𝗔𝗧𝗜𝗢𝗡*\n━━━━━━━━━━━━━━━━━━━━━━\nOtorisasi Client diberikan oleh Admin.\n\nKetik /start untuk membuka portal.`, { parse_mode: 'Markdown' }).catch(()=>{});
});

bot.onText(/\/removeuser (.+)/, async (msg, match) => {
    const chatId = msg.chat.id.toString();
    if (!isAdmin(chatId)) return;
    bot.deleteMessage(chatId, msg.message_id).catch(()=>{});

    const targetId = match[1].trim();
    await dbRun('DELETE FROM whitelisted_users WHERE chat_id = ?', [targetId]);
    await dbRun('DELETE FROM user_assigned_numbers WHERE user_chat_id = ?', [targetId]);
    stopOtpPolling(targetId);
    whitelistedUsers.delete(targetId);

    bot.sendMessage(chatId, `✅ Identity \`${targetId}\` direvoke dari sistem.`, { parse_mode: 'Markdown' });
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id.toString();
    const text = msg.text;

    if (!text || text.startsWith('/')) return;
    bot.deleteMessage(chatId, msg.message_id).catch(() => {});
    
    if (!isAdmin(chatId)) return; 
    if (!userStates[chatId]) return;

    const { state: currentState, lastMsgId: menuMsgId } = userStates[chatId];

    if (currentState === 'WAITING_COOKIE') {
        const parts = text.split('=');
        if (parts.length >= 2) {
            const name = parts[0].trim();
            const value = parts.slice(1).join('=').trim();
            if (!userStates[chatId].tempCookies) userStates[chatId].tempCookies = {};
            userStates[chatId].tempCookies[name] = value;
            
            const addedKeys = Object.keys(userStates[chatId].tempCookies).map(k => `\`${k}\``).join(', ');
            const markup = {
                inline_keyboard: [
                    [{ text: '✅ Execute Auth Phase', callback_data: 'cmd_finish_login' }],
                    [{ text: '❌ Abort', callback_data: 'cmd_cancel' }]
                ]
            };
            safeEditMessageText(`🔑 *𝗔𝗨𝗧𝗛𝗘𝗡𝗧𝗜𝗖𝗔𝗧𝗜𝗢𝗡 𝗚𝗔𝗧𝗘𝗪𝗔𝗬*\n━━━━━━━━━━━━━━━━━━━━━━\n✅ Key Loaded!\n\nCurrent Keys: ${addedKeys}\n\nInject next string atau tekan *Execute*.`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: markup });
        } else {
            const markup = {
                inline_keyboard: [
                    [{ text: '✅ Execute Auth Phase', callback_data: 'cmd_finish_login' }],
                    [{ text: '❌ Abort', callback_data: 'cmd_cancel' }]
                ]
            };
            safeEditMessageText(`❌ *𝗠𝗔𝗟𝗙𝗢𝗥𝗠𝗘𝗗 𝗦𝗬𝗡𝗧𝗔𝗫*\nGunakan pemisah '=' pada payload.\n\nContoh: \`ivas_sms_session=eyJp...\``, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: markup });
        }
    } 
    else if (currentState === 'WAITING_RANGE') {
        userStates[chatId].state = 'IDLE';
        const targetRange = text.trim();
        const acc = activeSessions.get(chatId);
        bot.sendChatAction(chatId, 'typing').catch(()=>{});

        await safeEditMessageText(`🔍 *𝗔𝗣𝗜 𝗤𝗨𝗘𝗥𝗬 𝗘𝗫𝗘𝗖𝗨𝗧𝗘𝗗*\n━━━━━━━━━━━━━━━━━━━━━━\nMenyusup ke endpoint region \`${targetRange}\`...`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown' });

        try {
            const availableNumbers = await acc.getTestNumbersByRange(targetRange);
            if (availableNumbers && availableNumbers.length > 0) {
                let reply = `✅ *𝗗𝗔𝗧𝗔𝗦𝗘𝗧 𝗙𝗢𝗨𝗡𝗗: ${targetRange}*\n${availableNumbers.length} Nodes ready untuk di-ping.\n\n👇 *Select node details:*`;
                const inline_keyboard = [];
                availableNumbers.slice(0, 10).forEach((n) => {
                    inline_keyboard.push([{ text: `📱 ${n.number} - Yield: $${n.rate}`, callback_data: `term_detail_${n.id}` }]);
                });
                inline_keyboard.push([{ text: '❌ Cancel Operation', callback_data: 'cmd_cancel' }]);
                
                safeEditMessageText(reply, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard } });
            } else {
                safeEditMessageText(`❌ *𝟰𝟬𝟰 𝗡𝗢𝗧 𝗙𝗢𝗨𝗡𝗗*\nEndpoint kosong untuk range \`${targetRange}\`.`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
            }
        } catch (e) { 
            safeEditMessageText(`⚠️ *𝗦𝗬𝗦𝗧𝗘𝗠 𝗘𝗥𝗥𝗢𝗥*: ${e.message}`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() }); 
        }
    }
    else if (currentState === 'WAITING_NUMBER') {
        userStates[chatId].state = 'IDLE';
        const targetNumber = text.trim();
        const acc = activeSessions.get(chatId);
        const todayStr = getTodayUTC();
        
        bot.sendChatAction(chatId, 'typing').catch(()=>{});

        try {
            let foundMsgs = null; 
            
            const dbRegionRow = await dbGet('SELECT range_name FROM wa_numbers WHERE number = ? AND chat_id = ?', [targetNumber, chatId]);

            if (dbRegionRow) {
                await safeEditMessageText(`⚡ *𝗟𝗢𝗖𝗔𝗟 𝗖𝗔𝗖𝗛𝗘 𝗛𝗜𝗧!*\n━━━━━━━━━━━━━━━━━━━━━━\nMapping ditemukan: \`${dbRegionRow.range_name}\`\nDownloading TCP packet...`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown' });
                foundMsgs = await acc.getMessages(targetNumber, dbRegionRow.range_name, todayStr);
            } else {
                await safeEditMessageText(`🔍 *𝗚𝗟𝗢𝗕𝗔𝗟 𝗦𝗖𝗔𝗡*\n━━━━━━━━━━━━━━━━━━━━━━\nCache Miss. Memindai seluruh fragment server...`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown' });
                const checkData = await acc.getCountries(todayStr);
                for (const c of checkData.countries) {
                    const numbersInCountry = await acc.getNumbers(c, todayStr);
                    if (numbersInCountry.includes(targetNumber)) {
                        foundMsgs = await acc.getMessages(targetNumber, c, todayStr);
                        break; 
                    }
                }
            }

            if (foundMsgs && foundMsgs.length > 0) {
                for (const m of foundMsgs) {
                    const card = formatMessageCard(m); 
                    await bot.sendMessage(chatId, card.text, { parse_mode: 'Markdown', reply_markup: card.reply_markup });
                }
                safeEditMessageText(`✅ *𝗢𝗣𝗘𝗥𝗔𝗧𝗜𝗢𝗡 𝗖𝗢𝗠𝗣𝗟𝗘𝗧𝗘*\nPesan historikal untuk \`${targetNumber}\` di-deploy ke chat ini.`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
            } else {
                safeEditMessageText(`❌ *𝗡𝗢 𝗥𝗘𝗖𝗢𝗥𝗗𝗦 𝗙𝗢𝗨𝗡𝗗*\nEndpoint kosong untuk string \`${targetNumber}\`.`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
            }
        } catch (e) { 
            safeEditMessageText(`⚠️ *𝗦𝗬𝗦𝗧𝗘𝗠 𝗘𝗥𝗥𝗢𝗥*: ${e.message}`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() }); 
        }
    }
    else if (currentState === 'WAITING_WA_PHONE') {
        userStates[chatId].state = 'IDLE';
        const phoneNumber = text.replace(/\D/g, '');
        if (phoneNumber.length < 8) {
            return safeEditMessageText("❌ *𝗕𝗔𝗗 𝗥𝗘𝗤𝗨𝗘𝗦𝗧*\nParameter kurang. Masukkan string lengkap (eg. 628xxx).", { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        }
        await safeEditMessageText(`⏳ Deploying listener for \`${phoneNumber}\`...`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown' });
        startWA(phoneNumber, chatId, menuMsgId);
    }
});

bot.on('document', async (msg) => {
    const chatId = msg.chat.id.toString();
    if (!isAdmin(chatId)) return;
    
    bot.deleteMessage(chatId, msg.message_id).catch(()=>{});
    
    if (!sock?.authState?.creds?.registered) {
        const sm = await bot.sendMessage(chatId, '⚠️ Meta Socket terputus!', { reply_markup: getMainMenuMarkup() });
        if(userStates[chatId]) userStates[chatId].lastMsgId = sm.message_id;
        return;
    }
    if (!msg.document.file_name.endsWith('.txt')) {
        const sm = await bot.sendMessage(chatId, '❌ Invalid Mime-Type. TXT Files Only.', { reply_markup: getMainMenuMarkup() });
        if(userStates[chatId]) userStates[chatId].lastMsgId = sm.message_id;
        return;
    }
    
    try {
        const fileLink = await bot.getFileLink(msg.document.file_id);
        const res = await axios.get(fileLink);
        let rawNumbers = res.data.split('\n').map(n => n.replace(/\D/g, '')).filter(n => n.length > 8);
        const uniqueNumbers = [...new Set(rawNumbers.map(n => n.startsWith('0') ? '62' + n.slice(1) : n))];
        
        if (uniqueNumbers.length === 0) {
            const sm = await bot.sendMessage(chatId, '❌ Null Payload. Gagal mengekstrak data valid.', { reply_markup: getMainMenuMarkup() });
            if(userStates[chatId]) userStates[chatId].lastMsgId = sm.message_id;
            return;
        }
        
        const jobId = Date.now().toString(); 
        jobQueue.set(jobId, uniqueNumbers);
        const sm = await bot.sendMessage(chatId, `📁 *𝗣𝗔𝗬𝗟𝗢𝗔𝗗 𝗔𝗖𝗖𝗘𝗣𝗧𝗘𝗗*\n━━━━━━━━━━━━━━━━━━━━━━\n*${uniqueNumbers.length}* string siap diolah.\n\nPilih konfigurasi *Throttle*:`, { 
            parse_mode: 'Markdown', 
            reply_markup: { inline_keyboard: [ [{ text: '🚀 Turbo (Aggressive)', callback_data: `start_${jobId}_fast` }, { text: '🚗 Default (Balanced)', callback_data: `start_${jobId}_normal` }, { text: '🚲 Stealth (Safe)', callback_data: `start_${jobId}_slow` }] ] } 
        });
        if(userStates[chatId]) userStates[chatId].lastMsgId = sm.message_id;
    } catch (e) { 
        const sm = await bot.sendMessage(chatId, `❌ *𝗘𝗫𝗖𝗘𝗣𝗧𝗜𝗢𝗡*: ${e.message}`, { reply_markup: getMainMenuMarkup() }); 
        if(userStates[chatId]) userStates[chatId].lastMsgId = sm.message_id;
    }
});

(async () => {
    console.log('[SYSTEM] Menyiapkan Database & Ivasms Sessions...');
    await loadWhitelistedUsers();
    const sessions = await dbAll('SELECT * FROM sessions');
    for (const session of sessions) {
        const account = new IVASAccount(session.chat_id, JSON.parse(session.cookies));
        if (await account.initSession()) activeSessions.set(session.chat_id, account);
    }
    
    pollAllAccounts(); 
    
    console.log('[SYSTEM] Mengecek Sesi Meta...');
    if (fs.existsSync('./auth_info_baileys/creds.json')) startWA();
})();
