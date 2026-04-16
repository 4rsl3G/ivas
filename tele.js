require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar, Cookie } = require('tough-cookie');
const cheerio = require('cheerio');
const sqlite3 = require('sqlite3').verbose();

// ─── KONFIGURASI BOT ───────────────────────────────────────────────────────
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { 
    polling: { interval: 300, autoStart: true, params: { timeout: 10 } },
    request: { family: 4 }
});

const POLLING_INTERVAL = 20000; // 20 detik untuk Global Sync
const BROADCAST_CHANNEL = process.env.BROADCAST_CHANNEL_ID ? process.env.BROADCAST_CHANNEL_ID.trim() : null;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? process.env.ADMIN_CHAT_ID.trim() : null; 
const REQUIRED_CHANNEL_ID = process.env.REQUIRED_CHANNEL_ID ? process.env.REQUIRED_CHANNEL_ID.trim() : null;
const REQUIRED_CHANNEL_LINK = process.env.REQUIRED_CHANNEL_LINK ? process.env.REQUIRED_CHANNEL_LINK.trim() : 'https://t.me/yourchannel';

// ─── MANAJEMEN STATE ───────────────────────────────────────────────────────
const userStates = {}; 
const activeSessions = new Map();
const activeOtpPolling = new Map();

const forceSubCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

// ─── BASIS DATA (SQLite WAL Mode) ──────────────────────────────────────────
const sqlDb = new sqlite3.Database('./pansa_bot.db', (err) => {
    if (!err) {
        sqlDb.run('PRAGMA journal_mode = WAL;');
        sqlDb.run('PRAGMA synchronous = NORMAL;');
    }
});

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
const escapeMarkdown = text => text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');

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
    const text = `🚫 *ACCESS DENIED*\n━━━━━━━━━━━━━━━━━━━━━━\nBot ini publik, namun Anda *wajib join Channel Resmi* kami.\n\n👇 _Join dulu, lalu klik Saya Sudah Join:_`;
    const markup = {
        inline_keyboard: [
            [{ text: '🔗 Join Channel Resmi', url: REQUIRED_CHANNEL_LINK }],
            [{ text: '✅ Saya Sudah Join', callback_data: 'check_join' }]
        ]
    };
    if (msgId) await safeEditMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: markup });
    else await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: markup });
}

// ─── UI / UX MARKUPS ───────────────────────────────────────────────────────
const getMainMenuMarkup = () => ({
    inline_keyboard: [
        [{ text: '🔑 Cookies Auth', callback_data: 'cmd_login' }, { text: '🗃 Sync Database', callback_data: 'cmd_sync_db' }],
        [{ text: '🔍 Global Inbox', callback_data: 'cmd_search' }, { text: '🛒 Browse Range', callback_data: 'cmd_search_range' }],
        [{ text: '📡 Auto-Snipe IVAS', callback_data: 'cmd_hunt_wa' }, { text: '📱 Check Saved Numbers', callback_data: 'cmd_get_wa_numbers_0' }],
        [{ text: '🗑 Purge All Data', callback_data: 'cmd_delete_all' }, { text: '🚪 Terminate Session', callback_data: 'cmd_logout' }],
        [{ text: '👥 Public Users List', callback_data: 'cmd_manage_users' }, { text: '⚙️ System Health', callback_data: 'cmd_status' }]
    ]
});

const getUserMenuMarkup = () => ({
    inline_keyboard: [[{ text: '📱 Request New Number', callback_data: 'user_get_number' }]]
});

const getCancelMarkup = () => ({ 
    inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cmd_cancel' }]] 
});

function formatMessageCard(msgData, isManual = false) {
    const otpMatch = msgData.text.match(/\b\d{3}[-\s]?\d{3}\b/) || msgData.text.match(/\b\d{4,8}\b/);
    const cleanOtp = otpMatch ? otpMatch[0].replace(/\D/g, '') : null;
    
    let text = `✦ *OTP RECEIVED* ✦\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `📱 Nomor : \`+${msgData.phoneNumber}\`\n`;
    text += `🌍 Region : ${msgData.countryRange}\n`;
    text += `📨 Sender : ${msgData.sender}\n`;
    text += `⏱ Time   : ${msgData.time} (UTC)\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `💬 Pesan :\n_${escapeMarkdown(msgData.text)}_\n`;
    
    const inline_keyboard = [];
    if (cleanOtp) {
        text += `\n🔑 *OTP* : \`${cleanOtp}\`\n_💡 Ketuk angka OTP di atas untuk menyalin_`;
        inline_keyboard.push([{ text: `🔑 ${cleanOtp}`, callback_data: 'dummy_btn' }]);
    }
    if (!isManual) inline_keyboard.push([{ text: '🤖 Kembali ke Dashboard', url: `https://t.me/${process.env.BOT_USERNAME || 'bot'}` }]); 
    
    return { text, reply_markup: { inline_keyboard } };
}

async function safeEditMessageText(text, options) {
    try { await bot.editMessageText(text, options); } 
    catch (e) { if (!e.message.includes('message is not modified')) console.error(e.message); }
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
            const res = await this.client.get(`/portal/numbers?${params.toString()}`);
            if (res.status === 200 && res.data?.data) return res.data.data.map(item => ({ number: item.Number.toString(), range: item.range }));
            return [];
        } catch (e) { return []; }
    }
    async fetchLiveTestSMS() {
        try {
            const params = new URLSearchParams({
                'draw': '1', 'columns[0][data]': 'range', 'columns[1][data]': 'termination.test_number',
                'columns[2][data]': 'originator', 'columns[3][data]': 'messagedata', 'columns[4][data]': 'senttime',
                'order[0][column]': '4', 'order[0][dir]': 'desc', 'start': '0', 'length': '50', 'search[value]': '', '_': Date.now()
            });
            const res = await this.client.get(`/portal/sms/test/sms?${params.toString()}`);
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

// ─── ALOKASI & MANAJEMEN NOMOR ─────────────────────────────────────────────
// Sesuai sistem baru, langsung masuk DB lokal tanpa Baileys (Super Ringan)
async function saveNumbersToDB(chatId, numbersObjArray, msgId, accountId) {
    if (!numbersObjArray || numbersObjArray.length === 0) {
        await safeEditMessageText(`✅ *ACTION COMPLETE*\nData kosong.`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        return;
    }

    await safeEditMessageText(`⚡ *SAVING DATASET*\nMenyimpan *${numbersObjArray.length}* nomor ke database...`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
    
    const placeholders = numbersObjArray.map(() => '(?, ?, ?)').join(', ');
    const values = numbersObjArray.flatMap(n => [n.number, accountId, n.range]);
    await dbRun(`INSERT OR IGNORE INTO wa_nodes (number, account_id, range_name) VALUES ${placeholders}`, values);
    
    await safeEditMessageText(`✅ *SYNC COMPLETE*\n*${numbersObjArray.length}* data tersimpan ke database lokal (Akun ID: ${accountId}).`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
}

async function assignRandomNumberToUser(userChatId) {
    const existing = await dbGet('SELECT number, range_name FROM user_assigned_numbers WHERE user_chat_id = ?', [userChatId]);
    if (existing) return existing; 
    
    // Mengecualikan nomor yang ada di used_numbers (Blacklist Permanen)
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

    // UI Update hanya sekali di awal agar silent 5 detik di background
    await safeEditMessageText(
        `🔄 *LIVE POLLING ACTIVE*\n━━━━━━━━━━━━━━━━━━━━━━\n📱 Nomor : \`+${number}\`\n🌍 Region : ${rangeName}\n\n⏳ _Sistem sedang memonitor inbox secara realtime (siluman)..._\n_Silakan request OTP di aplikasi target._`,
        { chat_id: userChatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'user_cancel_otp' }]] } }
    ).catch(() => {});

    const poll = async () => {
        attempts++;
        const msg = await checkOtpForNumber(number, rangeName);
        const currentMsgId = msg ? `${msg.time}_${msg.text}` : null;
        
        if (msg && currentMsgId !== lastSeenId) {
            stopOtpPolling(userChatId);
            if (!userStates[userChatId]) userStates[userChatId] = {};
            userStates[userChatId].lastSeenMsgId = currentMsgId;
            
            // Blacklist permanen karena OTP berhasil masuk
            await dbRun(`INSERT OR REPLACE INTO used_numbers (number, user_chat_id) VALUES (?, ?)`, [number, userChatId]);

            const otpMatch = msg.text.match(/\b\d{4,8}\b/g); const otp = otpMatch ? otpMatch[0] : null;
            let replyText = `✦ *OTP BARU DITERIMA* ✦\n━━━━━━━━━━━━━━━━━━━━━━\n📱 Nomor : \`+${number}\`\n📨 Sender : ${msg.sender}\n⏱ Time : ${msg.time} (UTC)\n🔐 *Status : Terpakai (Permanen)*\n\n💬 Pesan :\n_${escapeMarkdown(msg.text)}_\n`;
            
            if (otp) replyText += `━━━━━━━━━━━━━━━━━━━━━━\n🔑 *KODE OTP : \`${otp}\`*`;

            await safeEditMessageText(replyText, { 
                chat_id: userChatId, message_id: msgId, parse_mode: 'Markdown', 
                reply_markup: { inline_keyboard: [ 
                    ...(otp ? [[{ text: `🔑 ${otp}`, callback_data: 'dummy_btn' }]] : []), 
                    [{ text: '🔄 Request New Number', callback_data: 'user_new_number' }] 
                ]} 
            }).catch(() => {});
            return;
        }

        if (attempts >= MAX_ATTEMPTS) {
            stopOtpPolling(userChatId);
            await safeEditMessageText(`⏰ *POLLING TIMEOUT*\nTarget: \`+${number}\`\nTidak ada OTP masuk selama 2 menit.`, { chat_id: userChatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔄 Request New Number', callback_data: 'user_new_number' }, { text: '🔁 Listen Again', callback_data: 'user_get_otp' }]] } }).catch(() => {});
            return;
        }
        const timeoutId = setTimeout(poll, 5000); activeOtpPolling.set(userChatId, { timeoutId, msgId });
    };
    const timeoutId = setTimeout(poll, 5000); activeOtpPolling.set(userChatId, { timeoutId, msgId });
}

// ─── POLLING BACKGROUND GLOBAL ─────────────────────────────────────────────
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
                                if (BROADCAST_CHANNEL) {
                                    const card = formatMessageCard(msg, false);
                                    bot.sendMessage(BROADCAST_CHANNEL, card.text, { parse_mode: 'Markdown', reply_markup: card.reply_markup }).catch(()=>{});
                                }
                            }
                        }
                    }
                }
                if (hasNew) await dbRun(`DELETE FROM seen_ids WHERE rowid NOT IN (SELECT rowid FROM seen_ids WHERE account_id = ? ORDER BY rowid DESC LIMIT 1000)`, [accountId]);
            } catch (e) {
                if (e.response && (e.response.status === 401 || e.response.status === 403)) { 
                    account.loggedIn = false; 
                    activeSessions.delete(accountId); 
                }
            }
        }
    } finally { setTimeout(pollAllAccounts, POLLING_INTERVAL); } // 20 Detik Interval Global
}

// ─── TELEGRAM ROUTER (PERINTAH & CALLBACK) ─────────────────────────────────
bot.onText(/\/(start|menu)/, async (msg) => {
    const chatId = msg.chat.id.toString();
    bot.deleteMessage(chatId, msg.message_id).catch(()=>{});

    if (!isAdmin(chatId)) {
        await dbRun('INSERT OR IGNORE INTO whitelisted_users (chat_id, username, added_at) VALUES (?, ?, ?)', [chatId, msg.from.username || msg.from.first_name || 'User', new Date().toISOString()]);
    }
    
    if (isAdmin(chatId)) {
        const sentMsg = await bot.sendMessage(chatId, `❖ *FIX MERAH WORKSPACE* ❖\n━━━━━━━━━━━━━━━━━━━━━━\nSelamat datang di Control Panel.\nTotal Akun API: ${activeSessions.size}`, { parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        userStates[chatId] = { state: 'IDLE', lastMsgId: sentMsg.message_id };
    } else {
        if (!(await checkForceSub(chatId))) return sendForceSubMessage(chatId);
        const sentMsg = await bot.sendMessage(chatId, `❖ *FIX MERAH PORTAL* ❖\n━━━━━━━━━━━━━━━━━━━━━━\nAkses diverifikasi. Gunakan modul di bawah untuk memulai:`, { parse_mode: 'Markdown', reply_markup: getUserMenuMarkup() });
        userStates[chatId] = { state: 'IDLE', lastMsgId: sentMsg.message_id };
    }
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id.toString();
    const msgId = query.message.message_id;
    const action = query.data;

    if (action === 'dummy_btn') {
        return bot.answerCallbackQuery(query.id, { text: '💡 Ketuk (tap) angka OTP atau Nomor yang berwarna abu-abu pada pesan di atas untuk menyalin otomatis.', show_alert: true });
    }

    bot.answerCallbackQuery(query.id);

    if (action === 'check_join') {
        if (await checkForceSub(chatId)) return safeEditMessageText(`❖ *FIX MERAH PORTAL* ❖\n━━━━━━━━━━━━━━━━━━━━━━\nAkses diverifikasi.`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: !isAdmin(chatId) ? getUserMenuMarkup() : getMainMenuMarkup() });
        else return bot.answerCallbackQuery(query.id, { text: "❌ Anda belum berada di Kanal Resmi!", show_alert: true });
    }

    if (!isAdmin(chatId) && !(await checkForceSub(chatId))) return sendForceSubMessage(chatId, msgId);

    if (action === 'user_get_number' || action === 'user_new_number') {
        if (action === 'user_new_number') {
            const state = userStates[chatId];
            if (state?.assignedNumber) await dbRun(`INSERT OR IGNORE INTO used_numbers (number, user_chat_id) VALUES (?, ?)`, [state.assignedNumber, chatId]);
            stopOtpPolling(chatId);
            await releaseNumberFromUser(chatId);
        }

        if (activeSessions.size === 0) return safeEditMessageText("⚠️ *SYSTEM OFFLINE*\nInfrastruktur belum diinisialisasi.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: !isAdmin(chatId) ? getUserMenuMarkup() : getMainMenuMarkup() });

        await safeEditMessageText("🔄 *ALLOCATING LINE...*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });

        const assigned = await assignRandomNumberToUser(chatId);
        if (!assigned) return safeEditMessageText("❌ *NO RESOURCES*\nSemua node sedang dipakai.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔄 Coba Lagi', callback_data: 'user_get_number' }]] } });

        userStates[chatId] = { ...userStates[chatId], assignedNumber: assigned.number, assignedRange: assigned.range_name, lastSeenMsgId: null };

        await safeEditMessageText(`✅ *RESOURCE ALLOCATED*\n━━━━━━━━━━━━━━━━━━━━━━\n📱 Nomor : \`+${assigned.number}\`\n🌍 Region : ${assigned.range_name}\n\n💡 _Ketuk nomor di atas untuk menyalin._`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [ [{ text: `📱 +${assigned.number}`, callback_data: 'dummy_btn' }], [{ text: '📨 Start Listening', callback_data: 'user_get_otp' }], [{ text: '🔄 Regenerate Line', callback_data: 'user_new_number' }] ] } });
        return;
    }

    if (action === 'user_get_otp') {
        const state = userStates[chatId]; let number = state?.assignedNumber; let rangeName = state?.assignedRange;
        if (!number || !rangeName) {
            const assigned = await dbGet('SELECT number, range_name FROM user_assigned_numbers WHERE user_chat_id = ?', [chatId]);
            if (!assigned) return safeEditMessageText("❌ Tidak ada sesi aktif. Tekan Request New Number.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: !isAdmin(chatId) ? getUserMenuMarkup() : getMainMenuMarkup() });
            userStates[chatId] = { ...userStates[chatId], assignedNumber: assigned.number, assignedRange: assigned.range_name };
        }
        startOtpPolling(chatId, userStates[chatId].assignedNumber, userStates[chatId].assignedRange, msgId);
        return;
    }

    if (action === 'user_cancel_otp') {
        stopOtpPolling(chatId);
        const state = userStates[chatId];
        return safeEditMessageText(`✋ *LISTENER TERMINATED*\nNomor masih terkunci:\n\`+${state?.assignedNumber || '-'}\``, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [ [{ text: '📨 Resume Listening', callback_data: 'user_get_otp' }], [{ text: '🔄 Release & Ganti', callback_data: 'user_new_number' }] ] } });
    }

    if (!isAdmin(chatId)) return;
    if (!userStates[chatId]) userStates[chatId] = { state: 'IDLE', lastMsgId: msgId };

    if (action === 'cmd_manage_users') {
        const users = await dbAll('SELECT chat_id, username, added_at FROM whitelisted_users ORDER BY added_at DESC LIMIT 50');
        const countRow = await dbGet('SELECT COUNT(*) as count FROM whitelisted_users');
        let text = `👥 *PUBLIC USERS*\nTotal: ${countRow.count}\n\n`;
        if (users.length > 0) users.forEach((u, i) => { text += `${i+1}. ${u.username} (\`${u.chat_id}\`)\n`; });
        else text += '_Kosong._\n';
        safeEditMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'cmd_cancel' }]] } });
        return;
    }
    
    if (action === 'cmd_login') {
        userStates[chatId].state = 'WAITING_COOKIE'; userStates[chatId].tempCookies = {};
        safeEditMessageText("🔑 *AUTHENTICATION GATEWAY*\nInject cookie: `nama=nilai`\nContoh: `ivas_sms_session=eyJp...`", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getCancelMarkup() });
        return;
    } 
    
    if (action === 'cmd_finish_login') {
        if (!userStates[chatId] || !userStates[chatId].tempCookies) return;
        const cookiesObj = userStates[chatId].tempCookies;
        if (!cookiesObj['ivas_sms_session']) return safeEditMessageText("❌ *FATAL*\nParameter `ivas_sms_session` wajib ada.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getCancelMarkup() });

        userStates[chatId].state = 'IDLE';
        await safeEditMessageText("⏳ *SYNCING...*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        
        const res = await dbRun('INSERT INTO ivas_accounts (cookies, added_at) VALUES (?, ?)', [JSON.stringify(cookiesObj), new Date().toISOString()]);
        const accountId = res.lastID;
        const account = new IVASAccount(accountId, cookiesObj);
        
        if (await account.initSession()) {
            activeSessions.set(accountId, account);
            const myNumbers = await account.getMyNumbers();
            
            if (myNumbers.length > 0) await saveNumbersToDB(chatId, myNumbers, msgId, accountId);
            else safeEditMessageText(`✅ *AUTH OK*\nLogin valid. (0 nodes aktif di Akun ID ${accountId}).`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        } else safeEditMessageText("❌ *AUTH FAILED*\nCookie expired atau invalid.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        return;
    }
    
    if (action === 'cmd_sync_db') {
        if (activeSessions.size === 0) return safeEditMessageText("⚠️ *AUTH REQUIRED*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        
        await dbRun('DELETE FROM wa_nodes');
        let totalSynced = 0; let processedAccs = 0; const totalAccs = activeSessions.size;
        
        for (const [accId, acc] of activeSessions.entries()) {
            processedAccs++;
            await safeEditMessageText(`⏳ *FETCHING*\nMenarik data dari Akun ID: ${accId} (${processedAccs}/${totalAccs})...`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{});
            
            const myNumbers = await acc.getMyNumbers();
            if(myNumbers.length > 0) {
                await saveNumbersToDB(chatId, myNumbers, msgId, accId);
                totalSynced += myNumbers.length;
            }
        }
        safeEditMessageText(`✅ *SYNC OK*\nTotal Node Lintas Akun: ${totalSynced}`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        return;
    }
    
    if (action.startsWith('cmd_get_wa_numbers_')) {
        const offset = parseInt(action.replace('cmd_get_wa_numbers_', '')) || 0; const limit = 3;
        try {
            const countRow = await dbGet('SELECT COUNT(*) as count FROM wa_nodes'); const total = countRow.count;
            if (total === 0) return safeEditMessageText("❌ *EMPTY*\nDatabase kosong.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });

            const currentOffset = offset >= total ? 0 : offset;
            const numbers = await dbAll('SELECT number, range_name, account_id FROM wa_nodes LIMIT ? OFFSET ?', [limit, currentOffset]);

            let text = `📱 *SAVED NUMBERS*\n${currentOffset + 1} - ${Math.min(currentOffset + limit, total)} of *${total}*\n\n`;
            const inline_keyboard = [];
            numbers.forEach((n, i) => {
                text += `${currentOffset + i + 1}. 🌍 *${n.range_name}* (Akun ${n.account_id})\n   └ 📱 \`+${n.number}\`\n\n`;
                inline_keyboard.push([{ text: `📋 Copy: +${n.number}`, callback_data: 'dummy_btn' }]);
            });

            const navButtons = [];
            if (total > limit) navButtons.push({ text: '🔄 Load More', callback_data: `cmd_get_wa_numbers_${currentOffset + limit}` });
            navButtons.push({ text: '⬅️ Back', callback_data: 'cmd_cancel' });
            
            inline_keyboard.push(navButtons);
            safeEditMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard } });
        } catch (e) { safeEditMessageText(`⚠️ *SYSTEM ERROR*: ${e.message}`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() }); }
        return;
    }
    
    if (action === 'cmd_search_range') {
        if (activeSessions.size === 0) return safeEditMessageText("⚠️ *AUTH REQUIRED*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        userStates[chatId].state = 'WAITING_RANGE';
        safeEditMessageText(`🛒 *BROWSE RANGE*\nInput Range (e.g. \`INDONESIA 232428\`).`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getCancelMarkup() });
        return;
    }
    
    if (action.startsWith('term_detail_')) {
        if (activeSessions.size === 0) return safeEditMessageText("⚠️ *AUTH REQUIRED*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        const parts = action.split('_'); const termId = parts[2]; const accId = parseInt(parts[3]);
        await safeEditMessageText("⏳ *FETCHING DETAILS...*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        
        const acc = activeSessions.get(accId);
        if (!acc) return safeEditMessageText("❌ Akun asal tidak ditemukan.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        
        const details = await acc.getTerminationDetails(termId);
        if (details) {
            let detailText = `📄 *TERMINATION SPECS*\n━━━━━━━━━━━━━━━━━━━━━━\n📌 *Range:* \`${details.rangeName}\`\n💵 *A2P:* ${details.a2pRate}\n🏢 *Via Akun ID:* ${accId}\n\n📊 *Limits:*\n`;
            details.limits.forEach(l => { detailText += `  └ *${l.key}:* ${l.val}\n`; });
            const detailMarkup = { inline_keyboard: [ [{ text: '➕ Beli Sekarang', callback_data: `add_term_${termId}_${accId}` }], [{ text: '⬅️ Back', callback_data: 'cmd_cancel' }] ] };
            safeEditMessageText(detailText, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: detailMarkup });
        } else safeEditMessageText("❌ *API FAULT*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() }); 
        return;
    }
    
    if (action.startsWith('add_term_')) {
        if (activeSessions.size === 0) return safeEditMessageText("⚠️ *AUTH REQUIRED*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        const parts = action.split('_'); const termId = parts[2]; const accId = parseInt(parts[3]);
        await safeEditMessageText("⏳ *PURCHASING...*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        
        const acc = activeSessions.get(accId);
        const result = await acc.addNumber(termId);
        
        if (result) {
            const resStr = JSON.stringify(result).toLowerCase();
            if (resStr.includes('limit') || resStr.includes('insufficient') || resStr.includes('fail') || resStr.includes('error')) {
                safeEditMessageText(`❌ *TRANSAKSI GAGAL*\nBatas limit atau saldo habis.\nLog: ${result.message || 'Error API'}`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
            } else {
                const existingNums = await dbAll('SELECT number FROM wa_nodes WHERE account_id = ?', [accId]);
                const existingSet = new Set(existingNums.map(n => n.number));
                const allMyNumbers = await acc.getMyNumbers();
                const newNumbers = allMyNumbers.filter(n => !existingSet.has(n.number));
                
                if (newNumbers.length > 0) await saveNumbersToDB(chatId, newNumbers, msgId, accId);
                else safeEditMessageText(`✅ *TRANSACTION OK*\nStatus: ${result.message || 'Done'}`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
            }
        } else safeEditMessageText("❌ *TRANSACTION FAILED*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() }); 
        return;
    }
    
    if (action === 'cmd_hunt_wa') {
        if (activeSessions.size === 0) return safeEditMessageText("⚠️ *AUTH REQUIRED*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        const MAX_BUY = 10; const maxRetries = 100;
        await safeEditMessageText(`🎯 *SNIPER ONLINE*\nMaksimum muatan: ${MAX_BUY} Ranges...`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });

        const uniqueRanges = new Set(); const purchasedRanges = [];
        const accountArray = Array.from(activeSessions.entries()); 
        let currentAccIndex = 0; const watcherAcc = accountArray[0][1];

        for (let i = 1; i <= maxRetries; i++) {
            if (i % 5 === 0 || i === 1) await safeEditMessageText(`🎯 *SNIPER RUNNING*\nIterasi: ${i}/${maxRetries}\nDiambil: ${purchasedRanges.length}/${MAX_BUY} Node\n_Scanning feed..._`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{});

            const data = await watcherAcc.fetchLiveTestSMS();
            for (const item of data) {
                let sender = '';
                try {
                    const $orig = cheerio.load(item.originator);
                    sender = $orig('p').text().trim().toLowerCase();
                } catch(e) { sender = String(item.originator).toLowerCase(); }
                const messageData = String(item.messagedata).toLowerCase();
                
                if (sender.includes('whatsapp') || sender.includes('wa') || messageData.includes('whatsapp')) {
                    if (!uniqueRanges.has(item.range)) {
                        uniqueRanges.add(item.range);
                        await safeEditMessageText(`🎯 *TARGET LOCKED*\nRegion: \`${item.range}\`\n_Executing..._`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{});
                        
                        const [buyerId, buyerAcc] = accountArray[currentAccIndex];
                        const availableNums = await buyerAcc.getTestNumbersByRange(item.range);
                        if (availableNums.length > 0) {
                            const buyResult = await buyerAcc.addNumber(availableNums[0].id);
                            if (buyResult) {
                                const resStr = JSON.stringify(buyResult).toLowerCase();
                                if (resStr.includes('limit') || resStr.includes('insufficient') || resStr.includes('fail') || resStr.includes('error')) {
                                    await safeEditMessageText(`❌ *GAGAL MEMBELI*\nWilayah: \`${item.range}\`\nAlasan: Saldo Akun ${buyerId} habis.`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{});
                                    await delay(1500);
                                } else {
                                    purchasedRanges.push({ range: item.range, rate: availableNums[0].rate, accountId: buyerId });
                                    currentAccIndex = (currentAccIndex + 1) % accountArray.length;
                                    await safeEditMessageText(`✅ *NODE SECURED*\nWilayah: \`${item.range}\``, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{});
                                    await delay(1000);
                                }
                            }
                        } else {
                            await safeEditMessageText(`⚠️ *TELAT*\nWilayah: \`${item.range}\` kosong.`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{});
                            await delay(1000);
                        }
                        if (purchasedRanges.length >= MAX_BUY) break; 
                    }
                }
            }
            if (purchasedRanges.length >= MAX_BUY) break;
            if (i < maxRetries) await delay(3000); 
        }

        if (purchasedRanges.length > 0) {
            let reply = `✅ *SNIPER SUCCESS*\nBerhasil mengamankan ${purchasedRanges.length} Node:\n\n`;
            purchasedRanges.forEach((d, i) => { reply += `${i+1}. 🌍 *${d.range}* (Akun ${d.accountId})\n`; });
            await safeEditMessageText(reply + `⏳ _Syncing DB..._`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
            
            const successfulAccIds = [...new Set(purchasedRanges.map(p => p.accountId))];
            for (const accId of successfulAccIds) {
                const acc = activeSessions.get(accId);
                const existingNums = await dbAll('SELECT number FROM wa_nodes WHERE account_id = ?', [accId]);
                const existingSet = new Set(existingNums.map(n => n.number));
                const allMyNumbers = await acc.getMyNumbers();
                const newNumbers = allMyNumbers.filter(n => !existingSet.has(n.number));
                
                if (newNumbers.length > 0) {
                    await delay(1000);
                    await saveNumbersToDB(chatId, newNumbers, msgId, accId);
                }
            }
            safeEditMessageText(reply + `*❖ FIX MERAH WORKSPACE*`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() }).catch(()=>{});
        } else safeEditMessageText(`❌ *SNIPER HALTED*\nDi-override buyer lain atau feed sepi.`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        return;
    }
    
    if (action === 'cmd_search') {
        if (activeSessions.size === 0) return safeEditMessageText("⚠️ *AUTH REQUIRED*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        userStates[chatId].state = 'WAITING_NUMBER';
        const countRow = await dbGet('SELECT COUNT(*) as count FROM wa_nodes');
        safeEditMessageText(`🔍 *GLOBAL INBOX*\nMasukkan nomor (Contoh: \`2250787560321\`)\n\n_DB Lokal: ${countRow.count} nodes_`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getCancelMarkup() });
        return;
    }

    if (action === 'cmd_delete_all') {
        if (activeSessions.size === 0) return safeEditMessageText("⚠️ *AUTH REQUIRED*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        const confirmMarkup = { inline_keyboard: [ [{ text: '⚠️ YA, PURGE', callback_data: 'cmd_confirm_delete_all' }], [{ text: '❌ Batal', callback_data: 'cmd_cancel' }] ] };
        safeEditMessageText("⚠️ *CONFIRM PURGE*\nOperasi ini ireversibel.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: confirmMarkup });
        return;
    }
    
    if (action === 'cmd_confirm_delete_all') {
        if (activeSessions.size === 0) return safeEditMessageText("⚠️ *AUTH REQUIRED*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        await safeEditMessageText("⏳ *PURGING...*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        
        for (const [accId, acc] of activeSessions.entries()) { await acc.returnAllNumbers(); }
        await dbRun('DELETE FROM wa_nodes'); await dbRun('DELETE FROM user_assigned_numbers'); await dbRun('DELETE FROM used_numbers');
            
        safeEditMessageText(`✅ *PURGE OK*\nSeluruh data lintas akun dikembalikan.\n_Tables wiped._`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        return;
    }
    
    if (action === 'cmd_status') {
        const countRow = await dbGet('SELECT COUNT(*) as count FROM wa_nodes');
        const userCountRow = await dbGet('SELECT COUNT(*) as count FROM whitelisted_users');
        const assignedCountRow = await dbGet('SELECT COUNT(*) as count FROM user_assigned_numbers');
        const lockedCountRow = await dbGet('SELECT COUNT(*) as count FROM used_numbers');
        
        let statusMsg = `⚙️ *SYSTEM HEALTH*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
                          `🟢 *IVAS Gateway :* ${activeSessions.size > 0 ? 'ONLINE' : 'OFFLINE'}\n` +
                          `🗃 *Local Nodes  :* ${countRow.count}\n` +
                          `👥 *Public Users  :* ${userCountRow.count}\n` +
                          `📱 *Active Rented :* ${assignedCountRow.count}\n` +
                          `🔐 *Locked Nodes  :* ${lockedCountRow.count}\n\n` +
                          `📊 *DISTRIBUSI AKUN API*\n`;
        
        const accStats = await dbAll('SELECT account_id, COUNT(*) as count FROM wa_nodes GROUP BY account_id');
        if (accStats.length === 0) statusMsg += `_Kosong_\n`;
        else accStats.forEach(stat => { statusMsg += `  └ ID ${stat.account_id}: *${stat.count}*\n`; });
                          
        safeEditMessageText(statusMsg, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        return;
    }
    
    if (action === 'cmd_logout') {
        await dbRun('DELETE FROM ivas_accounts');
        await dbRun('DELETE FROM wa_nodes');
        activeSessions.clear();
        safeEditMessageText("✅ *SESSION TERMINATED*\nCookie & cache dihapus.", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        return;
    }
    
    if (action === 'cmd_cancel') {
        userStates[chatId].state = 'IDLE';
        safeEditMessageText("❖ *FIX MERAH WORKSPACE*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        return;
    }
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id.toString(); const text = msg.text;
    if (!text || text.startsWith('/')) return;
    bot.deleteMessage(chatId, msg.message_id).catch(() => {});
    
    if (!isAdmin(chatId)) return; 
    if (!userStates[chatId]) return;

    const { state: currentState, lastMsgId: menuMsgId } = userStates[chatId];

    if (currentState === 'WAITING_COOKIE') {
        const parts = text.split('=');
        if (parts.length >= 2) {
            const name = parts[0].trim(); const value = parts.slice(1).join('=').trim();
            if (!userStates[chatId].tempCookies) userStates[chatId].tempCookies = {};
            userStates[chatId].tempCookies[name] = value;
            
            const addedKeys = Object.keys(userStates[chatId].tempCookies).map(k => `\`${k}\``).join(', ');
            const markup = { inline_keyboard: [ [{ text: '✅ Execute Auth', callback_data: 'cmd_finish_login' }], [{ text: '❌ Abort', callback_data: 'cmd_cancel' }] ] };
            safeEditMessageText(`🔑 *AUTH GATEWAY*\n✅ Key Loaded!\nKeys: ${addedKeys}\n\nInject lagi atau tekan Execute.`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: markup });
        } else {
            const markup = { inline_keyboard: [ [{ text: '✅ Execute Auth', callback_data: 'cmd_finish_login' }], [{ text: '❌ Abort', callback_data: 'cmd_cancel' }] ] };
            safeEditMessageText(`❌ *MALFORMED*\nGunakan format \`key=value\``, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: markup });
        }
    } 
    else if (currentState === 'WAITING_RANGE') {
        userStates[chatId].state = 'IDLE'; const targetRange = text.trim();
        bot.sendChatAction(chatId, 'typing').catch(()=>{});
        await safeEditMessageText(`🔍 *QUERYING*: \`${targetRange}\`...`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown' });

        try {
            let foundNumbers = [];
            for (const [accId, acc] of activeSessions.entries()) {
                const nums = await acc.getTestNumbersByRange(targetRange);
                if (nums.length > 0) { nums.forEach(n => n.accId = accId); foundNumbers = foundNumbers.concat(nums); }
            }

            if (foundNumbers.length > 0) {
                let reply = `✅ *${targetRange}*\n${foundNumbers.length} nodes ready.\n\n👇 *Pilih Node:*`;
                const inline_keyboard = [];
                foundNumbers.slice(0, 10).forEach((n) => { inline_keyboard.push([{ text: `📱 +${n.number} ($${n.rate}) - Akun ${n.accId}`, callback_data: `term_detail_${n.id}_${n.accId}` }]); });
                inline_keyboard.push([{ text: '❌ Cancel', callback_data: 'cmd_cancel' }]);
                
                safeEditMessageText(reply, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard } });
            } else safeEditMessageText(`❌ *404*\nRange \`${targetRange}\` kosong.`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        } catch (e) { safeEditMessageText(`⚠️ *ERROR*: ${e.message}`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() }); }
    }
    else if (currentState === 'WAITING_NUMBER') {
        userStates[chatId].state = 'IDLE'; const targetNumber = text.trim(); const todayStr = getTodayUTC();
        bot.sendChatAction(chatId, 'typing').catch(()=>{});

        try {
            let foundMsgs = null; 
            const dbRegionRow = await dbGet('SELECT range_name, account_id FROM wa_nodes WHERE number = ?', [targetNumber]);

            if (dbRegionRow) {
                await safeEditMessageText(`⚡ *CACHE HIT*: \`${dbRegionRow.range_name}\``, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown' });
                const acc = activeSessions.get(dbRegionRow.account_id);
                if (acc) foundMsgs = await acc.getMessages(targetNumber, dbRegionRow.range_name, todayStr);
            } else {
                await safeEditMessageText(`🔍 *GLOBAL SCAN*\nCache miss...`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown' });
                for (const [accId, acc] of activeSessions.entries()) {
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
                    const card = formatMessageCard(m, true); 
                    await bot.sendMessage(chatId, card.text, { parse_mode: 'Markdown', reply_markup: card.reply_markup });
                }
                safeEditMessageText(`✅ *OPERATION COMPLETE*\nHistori dikirim.`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
            } else safeEditMessageText(`❌ *NO RECORDS*\nTidak ada pesan untuk \`${targetNumber}\`.`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        } catch (e) { safeEditMessageText(`⚠️ *ERROR*: ${e.message}`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() }); }
    }
});

// ─── BOOTSTRAP ─────────────────────────────────────────────────────────────
(async () => {
    console.log('[SYSTEM] Initializing DB & Sessions...');
    const accounts = await dbAll('SELECT * FROM ivas_accounts');
    for (const accData of accounts) {
        const account = new IVASAccount(accData.id, JSON.parse(accData.cookies));
        if (await account.initSession()) {
            activeSessions.set(accData.id, account);
            console.log(`[IVAS] Akun ID ${accData.id} Aktif.`);
        }
    }
    pollAllAccounts(); 
    console.log('[SYSTEM] Ready.');
})();
