require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar, Cookie } = require('tough-cookie');
const cheerio = require('cheerio');
const sqlite3 = require('sqlite3').verbose();

// ─── CONFIG ────────────────────────────────────────────────────────────────
const token = process.env.TELEGRAM_BOT_TOKEN;
const POLLING_INTERVAL  = parseInt(process.env.POLLING_INTERVAL)  || 5000;
const ADMIN_CHAT_ID     = process.env.ADMIN_CHAT_ID?.trim()        || null;
const REQUIRED_CHANNEL_ID   = process.env.REQUIRED_CHANNEL_ID?.trim()   || null;
const REQUIRED_CHANNEL_LINK = process.env.REQUIRED_CHANNEL_LINK?.trim() || 'https://t.me/yourchannel';

const bot = new TelegramBot(token, { polling: true, request: { family: 4 } });

// ─── STATE ─────────────────────────────────────────────────────────────────
const userStates      = new Map();   // chatId → { state, lastMsgId, … }
const activeSessions  = new Map();   // chatId → IVASAccount
const activeOtpPolling = new Map();  // chatId → timeoutId

// ─── DATABASE ──────────────────────────────────────────────────────────────
const sqlDb = new sqlite3.Database('./pansa_bot.db');

const dbRun = (sql, p = []) => new Promise((res, rej) =>
    sqlDb.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const dbGet = (sql, p = []) => new Promise((res, rej) =>
    sqlDb.get(sql, p, (e, r) => e ? rej(e) : res(r)));
const dbAll = (sql, p = []) => new Promise((res, rej) =>
    sqlDb.all(sql, p, (e, r) => e ? rej(e) : res(r)));

sqlDb.serialize(() => {
    sqlDb.run('PRAGMA journal_mode=WAL');
    sqlDb.run('PRAGMA synchronous=NORMAL');
    dbRun(`CREATE TABLE IF NOT EXISTS sessions (
        chat_id TEXT PRIMARY KEY, cookies TEXT, last_total_sms INTEGER DEFAULT -1)`);
    dbRun(`CREATE TABLE IF NOT EXISTS seen_ids (
        msg_id TEXT PRIMARY KEY, chat_id TEXT)`);
    dbRun(`CREATE TABLE IF NOT EXISTS wa_numbers (
        number TEXT PRIMARY KEY, chat_id TEXT, range_name TEXT)`);
    dbRun(`CREATE TABLE IF NOT EXISTS whitelisted_users (
        chat_id TEXT PRIMARY KEY, username TEXT, added_at TEXT)`);
    dbRun(`CREATE TABLE IF NOT EXISTS user_assigned_numbers (
        user_chat_id TEXT PRIMARY KEY, number TEXT, range_name TEXT, assigned_at TEXT)`);
    dbRun(`CREATE TABLE IF NOT EXISTS used_numbers (
        number TEXT PRIMARY KEY, user_chat_id TEXT)`);
    // indexes
    dbRun(`CREATE INDEX IF NOT EXISTS idx_wa_numbers_chat ON wa_numbers(chat_id)`);
    dbRun(`CREATE INDEX IF NOT EXISTS idx_seen_ids_chat   ON seen_ids(chat_id)`);
});

// ─── HELPERS ───────────────────────────────────────────────────────────────
const delay       = ms => new Promise(r => setTimeout(r, ms));
const getTodayUTC = ()  => new Date().toISOString().split('T')[0];
const isAdmin     = id  => ADMIN_CHAT_ID && id.toString() === ADMIN_CHAT_ID;

function getState(chatId) {
    if (!userStates.has(chatId)) userStates.set(chatId, { state: 'IDLE' });
    return userStates.get(chatId);
}

async function safeEdit(text, options) {
    try { await bot.editMessageText(text, options); }
    catch (e) { if (!e.message?.includes('not modified')) console.error('[safeEdit]', e.message); }
}

// ─── FORCE-SUB ─────────────────────────────────────────────────────────────
async function checkForceSub(chatId) {
    if (!REQUIRED_CHANNEL_ID || isAdmin(chatId)) return true;
    try {
        const m = await bot.getChatMember(REQUIRED_CHANNEL_ID, chatId);
        return ['creator', 'administrator', 'member', 'restricted'].includes(m.status);
    } catch { return false; }
}

async function sendForceSubMessage(chatId, msgId = null) {
    const text = `🚫 *𝗔𝗖𝗖𝗘𝗦𝗦 𝗗𝗘𝗡𝗜𝗘𝗗*\n━━━━━━━━━━━━━━━━━━━━━━\nBot ini publik, namun Anda *wajib join Channel Resmi* kami.\n\n👇 _Join dulu, lalu klik Saya Sudah Join:_`;
    const markup = { inline_keyboard: [
        [{ text: '🔗 Join Channel Resmi', url: REQUIRED_CHANNEL_LINK }],
        [{ text: '✅ Saya Sudah Join',     callback_data: 'check_join'  }]
    ]};
    msgId
        ? await safeEdit(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: markup })
        : await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: markup });
}

// ─── MARKUPS ───────────────────────────────────────────────────────────────
const getMainMenuMarkup = () => ({ inline_keyboard: [
    [{ text: '🔑 Cookies Auth',        callback_data: 'cmd_login'              },
     { text: '🗃 Sync Database',        callback_data: 'cmd_sync_db'            }],
    [{ text: '🔍 Global Inbox',         callback_data: 'cmd_search'             },
     { text: '🛒 Browse Range',          callback_data: 'cmd_search_range'       }],
    [{ text: '📡 Auto-Snipe IVAS',       callback_data: 'cmd_hunt_wa'            },
     { text: '📱 Check Saved Numbers',   callback_data: 'cmd_get_wa_numbers_0'   }],
    [{ text: '🗑 Purge All Data',        callback_data: 'cmd_delete_all'         },
     { text: '🚪 Terminate Session',      callback_data: 'cmd_logout'            }],
    [{ text: '👥 Public Users List',     callback_data: 'cmd_manage_users'       },
     { text: '⚙️ System Health',         callback_data: 'cmd_status'             }]
]});

const getUserMenuMarkup = () => ({ inline_keyboard: [
    [{ text: '📱 Request New Number', callback_data: 'user_get_number' }]
]});

const getCancelMarkup = () => ({ inline_keyboard: [
    [{ text: '❌ Batalkan Operasi', callback_data: 'cmd_cancel' }]
]});

// ─── FORMAT OTP CARD ───────────────────────────────────────────────────────
function formatMessageCard(msgData) {
    const otpMatch = msgData.text.match(/\b\d{4,8}\b/);
    const otp = otpMatch?.[0] ?? null;

    let text  = `✦ *𝗦𝗘𝗖𝗨𝗥𝗘 𝗢𝗧𝗣 𝗚𝗔𝗧𝗘𝗪𝗔𝗬* ✦\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `📱 𝗡𝘂𝗺𝗯𝗲𝗿 : \`${msgData.phoneNumber}\`\n`;
    text += `🌍 𝗥𝗲𝗴𝗶𝗼𝗻 : ${msgData.countryRange}\n`;
    text += `📨 𝗦𝗲𝗻𝗱𝗲𝗿 : ${msgData.sender}\n`;
    text += `⏱ 𝗧𝗶𝗺𝗲   : ${msgData.time} (UTC)\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `💬 𝗠𝗲𝘀𝘀𝗮𝗴𝗲 :\n_${msgData.text}_\n`;
    if (otp) text += `\n🔑 *𝗘𝘅𝘁𝗿𝗮𝗰𝘁𝗲𝗱 𝗢𝗧𝗣* : \`${otp}\``;

    const inline_keyboard = [];
    if (otp) inline_keyboard.push([{ text: `📋 Copy OTP: ${otp}`, callback_data: 'dummy_btn' }]);
    inline_keyboard.push([{ text: '🤖 Kembali ke Dashboard', url: `https://t.me/${process.env.BOT_USERNAME || 'bot'}` }]);

    return { text, reply_markup: { inline_keyboard } };
}

// ─── IVAS ACCOUNT CLASS ────────────────────────────────────────────────────
class IVASAccount {
    constructor(chatId, cookies) {
        this.chatId    = chatId;
        this.cookies   = cookies;
        this.jar       = new CookieJar();
        this.loggedIn  = false;
        this.csrfToken = null;
        this.client    = wrapper(axios.create({
            jar: this.jar,
            baseURL: 'https://www.ivasms.com',
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36',
                'Accept':     'application/json, text/javascript, */*; q=0.01',
            }
        }));
    }

    async initSession() {
        for (const [k, v] of Object.entries(this.cookies)) {
            await this.jar.setCookie(
                new Cookie({ key: k, value: v, domain: 'www.ivasms.com' }).toString(),
                'https://www.ivasms.com'
            );
        }
        try {
            const res = await this.client.get('/portal/sms/received', { headers: { Accept: 'text/html' } });
            if (res.status === 200) {
                const $     = cheerio.load(res.data);
                const token = $('input[name="_token"]').val();
                if (token) { this.csrfToken = token; this.loggedIn = true; return true; }
            }
        } catch { /* ignore */ }
        return false;
    }

    async getMyNumbers() {
        try {
            const p   = new URLSearchParams({ draw: 1, start: 0, length: 2000, 'search[value]': '' });
            const res = await this.client.get(`/portal/numbers?${p}`, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
            return res.data?.data?.map(i => ({ number: i.Number.toString(), range: i.range })) ?? [];
        } catch { return []; }
    }

    async fetchLiveTestSMS() {
        try {
            const p = new URLSearchParams({
                draw: 1, 'columns[0][data]': 'range', 'columns[1][data]': 'termination.test_number',
                'columns[2][data]': 'originator', 'columns[3][data]': 'messagedata', 'columns[4][data]': 'senttime',
                'order[0][column]': 4, 'order[0][dir]': 'desc', start: 0, length: 50, 'search[value]': '', _: Date.now()
            });
            const res = await this.client.get(`/portal/sms/test/sms?${p}`, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
            return res.data?.data ?? [];
        } catch { return []; }
    }

    async getTestNumbersByRange(rangeName) {
        try {
            const p = new URLSearchParams({
                draw: 3, 'columns[0][data]': 'range', 'columns[0][name]': 'terminations.range',
                'columns[0][search][value]': rangeName, 'columns[0][search][regex]': 'false',
                'columns[1][data]': 'test_number', 'columns[1][name]': 'terminations.test_number',
                start: 0, length: 25, 'search[value]': '', _: Date.now()
            });
            const res = await this.client.get(`/portal/numbers/test?${p}`, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
            return res.data?.data?.map(i => ({ id: i.id, number: i.test_number, rate: i.A2P })) ?? [];
        } catch { return []; }
    }

    async getTerminationDetails(id) {
        try {
            const payload = new URLSearchParams({ id, '_token': this.csrfToken });
            const res     = await this.client.post('/portal/numbers/termination/details', payload.toString(), {
                headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded' }
            });
            if (res.status !== 200 || !res.data) return null;
            const $         = cheerio.load(res.data);
            const rangeName = $('h5.mb-2').first().text().trim();
            let a2pRate     = 'N/A';
            $('td').each((_, el) => { if ($(el).text().includes('USD')) a2pRate = $(el).text().trim(); });
            const limits = [];
            $('tr').each((_, el) => {
                const tds = $(el).find('td');
                if (tds.length === 2) {
                    const key = $(tds[0]).text().replace(/You Can Send.*/g, '').replace(/\s+/g, ' ').trim();
                    const val = $(tds[1]).text().trim();
                    if (key && val && !['A2P','P2P'].includes(key)) limits.push({ key, val });
                }
            });
            return { rangeName, a2pRate, limits, id };
        } catch { return null; }
    }

    async addNumber(id) {
        try {
            const payload = new URLSearchParams({ '_token': this.csrfToken, id });
            const res     = await this.client.post('/portal/numbers/termination/number/add', payload.toString(), {
                headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded' }
            });
            return res.data ?? null;
        } catch { return null; }
    }

    async returnAllNumbers() {
        try {
            const payload = new URLSearchParams({ '_token': this.csrfToken });
            const res     = await this.client.post('/portal/numbers/return/allnumber/bluck', payload.toString(), {
                headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded' }
            });
            return res.data ?? null;
        } catch { return null; }
    }

    async getCountries(dateStr) {
        try {
            const payload = new URLSearchParams({ from: dateStr, to: dateStr, '_token': this.csrfToken });
            const res     = await this.client.post('/portal/sms/received/getsms', payload.toString(), {
                headers: { 'X-Requested-With': 'XMLHttpRequest' }
            });
            if (res.status !== 200) return [];
            const $ = cheerio.load(res.data);
            const countries = [];
            $('div.rng').each((_, el) => countries.push($(el).find('.rname').text().trim()));
            return countries;
        } catch { return []; }
    }

    async getNumbers(countryRange, dateStr) {
        try {
            const payload = new URLSearchParams({ '_token': this.csrfToken, start: dateStr, end: dateStr, range: countryRange });
            const res     = await this.client.post('/portal/sms/received/getsms/number', payload.toString(), {
                headers: { 'X-Requested-With': 'XMLHttpRequest' }
            });
            if (res.status !== 200) return [];
            const $ = cheerio.load(res.data);
            const numbers = [];
            $('div.nrow').each((_, el) => numbers.push($(el).find('.nnum').text().trim()));
            return numbers;
        } catch { return []; }
    }

    async getMessages(phoneNumber, countryRange, dateStr) {
        try {
            const payload = new URLSearchParams({
                '_token': this.csrfToken, start: dateStr, end: dateStr, Number: phoneNumber, Range: countryRange
            });
            const res = await this.client.post('/portal/sms/received/getsms/number/sms', payload.toString(), {
                headers: { 'X-Requested-With': 'XMLHttpRequest' }
            });
            if (res.status !== 200) return [];
            const $ = cheerio.load(res.data);
            const msgs = [];
            $('tbody tr').each((_, el) => {
                const text = $(el).find('.msg-text').text().trim();
                if (text) msgs.push({
                    sender: $(el).find('.cli-tag').text().trim(),
                    text,
                    time:   $(el).find('.time-cell').text().trim(),
                    phoneNumber,
                    countryRange
                });
            });
            return msgs;
        } catch { return []; }
    }
}

// ─── SESSION HELPERS ───────────────────────────────────────────────────────
async function startIvasSession(chatId) {
    try {
        const row = await dbGet('SELECT cookies FROM sessions WHERE chat_id = ?', [chatId]);
        if (!row?.cookies) return false;
        const acc = new IVASAccount(chatId, JSON.parse(row.cookies));
        if (await acc.initSession()) { activeSessions.set(chatId, acc); return true; }
    } catch (e) { console.error('[startIvasSession]', e.message); }
    return false;
}

const getAdminSession = () => activeSessions.get(ADMIN_CHAT_ID) ?? null;

// ─── SAVE NUMBERS TO DB ────────────────────────────────────────────────────
async function saveNumbersToDB(chatId, numbersObjArray, msgId) {
    if (!numbersObjArray?.length) {
        return safeEdit(`✅ *𝗔𝗖𝗧𝗜𝗢𝗡 𝗖𝗢𝗠𝗣𝗟𝗘𝗧𝗘*\nData kosong.`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
    }

    await safeEdit(`⚡ *𝗦𝗔𝗩𝗜𝗡𝗚 𝗗𝗔𝗧𝗔𝗦𝗘𝗧*\nMenyimpan *${numbersObjArray.length}* nomor ke database...`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });

    // Batch insert in chunks of 500 to avoid SQLite variable limit
    const CHUNK = 500;
    for (let i = 0; i < numbersObjArray.length; i += CHUNK) {
        const slice = numbersObjArray.slice(i, i + CHUNK);
        const ph    = slice.map(() => '(?,?,?)').join(',');
        await dbRun(`INSERT OR IGNORE INTO wa_numbers (number, chat_id, range_name) VALUES ${ph}`,
            slice.flatMap(n => [n.number, chatId, n.range]));
    }

    await safeEdit(`✅ *𝗦𝗬𝗡𝗖 𝗖𝗢𝗠𝗣𝗟𝗘𝗧𝗘*\n*${numbersObjArray.length}* data tersimpan ke database lokal.`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
}

// ─── NUMBER ASSIGNMENT ─────────────────────────────────────────────────────
async function assignRandomNumber(userChatId) {
    const existing = await dbGet('SELECT number, range_name FROM user_assigned_numbers WHERE user_chat_id = ?', [userChatId]);
    if (existing) return existing;

    const row = await dbGet(`
        SELECT number, range_name FROM wa_numbers
        WHERE number NOT IN (SELECT number FROM user_assigned_numbers)
          AND number NOT IN (SELECT number FROM used_numbers WHERE user_chat_id != ?)
        ORDER BY RANDOM() LIMIT 1`, [userChatId]);
    if (!row) return null;

    await dbRun(`INSERT OR REPLACE INTO user_assigned_numbers (user_chat_id, number, range_name, assigned_at)
                 VALUES (?, ?, ?, ?)`, [userChatId, row.number, row.range_name, new Date().toISOString()]);
    return { number: row.number, range_name: row.range_name };
}

async function releaseNumber(userChatId) {
    await dbRun('DELETE FROM user_assigned_numbers WHERE user_chat_id = ?', [userChatId]);
}

// ─── OTP POLLING ───────────────────────────────────────────────────────────
function stopOtpPolling(chatId) {
    const t = activeOtpPolling.get(chatId);
    if (t) { clearTimeout(t); activeOtpPolling.delete(chatId); }
}

function startOtpPolling(chatId, number, rangeName, msgId) {
    stopOtpPolling(chatId);
    let attempts = 0;
    const MAX    = 24;
    const state  = getState(chatId);

    const poll = async () => {
        attempts++;
        await safeEdit(
            `🔄 *𝗟𝗜𝗩𝗘 𝗣𝗢𝗟𝗟𝗜𝗡𝗚*\n━━━━━━━━━━━━━━━━━━━━━━\n📱 \`${number}\`\n🌍 ${rangeName}\n\n⏳ Iterasi ke-${attempts} (${attempts*5}s)...\n_Selesaikan permintaan OTP di aplikasi target._`,
            { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
              reply_markup: { inline_keyboard: [[{ text: '❌ Batalkan', callback_data: 'user_cancel_otp' }]] } }
        ).catch(() => {});

        const acc = getAdminSession();
        if (acc?.loggedIn) {
            const msgs = await acc.getMessages(number, rangeName, getTodayUTC());
            const msg  = msgs?.at(-1);
            const uid  = msg ? `${msg.time}_${msg.text}` : null;

            if (msg && uid !== state.lastSeenMsgId) {
                stopOtpPolling(chatId);
                state.lastSeenMsgId = uid;
                await dbRun(`INSERT OR REPLACE INTO used_numbers (number, user_chat_id) VALUES (?, ?)`, [number, chatId]);

                const otp = msg.text.match(/\b\d{4,8}\b/)?.[0] ?? null;
                let txt   = `✦ *𝗢𝗧𝗣 𝗥𝗘𝗖𝗘𝗜𝗩𝗘𝗗* ✦\n━━━━━━━━━━━━━━━━━━━━━━\n📱 \`${number}\`\n📨 ${msg.sender}\n⏱ ${msg.time} (UTC)\n\n💬 _${msg.text}_\n`;
                if (otp) txt += `━━━━━━━━━━━━━━━━━━━━━━\n🔑 *OTP : \`${otp}\`*`;

                await safeEdit(txt, {
                    chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [
                        ...(otp ? [[{ text: `📋 Copy OTP: ${otp}`, callback_data: 'dummy_btn' }]] : []),
                        [{ text: '🔄 Nomor Baru', callback_data: 'user_new_number' },
                         { text: '🔁 Listen Lagi',  callback_data: 'user_get_otp'   }]
                    ]}
                }).catch(() => {});
                return;
            }
        }

        if (attempts >= MAX) {
            stopOtpPolling(chatId);
            await safeEdit(
                `⏰ *𝗣𝗢𝗟𝗟𝗜𝗡𝗚 𝗧𝗜𝗠𝗘𝗢𝗨𝗧*\nTidak ada OTP selama 2 menit.\nTarget: \`${number}\``,
                { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                  reply_markup: { inline_keyboard: [[{ text: '🔄 Ganti Nomor', callback_data: 'user_new_number' },
                                                     { text: '🔁 Ulangi',       callback_data: 'user_get_otp'   }]] }}
            ).catch(() => {});
            return;
        }

        activeOtpPolling.set(chatId, setTimeout(poll, 5000));
    };

    activeOtpPolling.set(chatId, setTimeout(poll, 5000));
}

// ─── BACKGROUND POLL (lightweight — only checks message count) ─────────────
async function pollAllAccounts() {
    const today    = getTodayUTC();
    const sessions = await dbAll('SELECT * FROM sessions');

    for (const session of sessions) {
        const acc = activeSessions.get(session.chat_id);
        if (!acc?.loggedIn) continue;
        try {
            const countries = await acc.getCountries(today);
            for (const country of countries) {
                const numbers = await acc.getNumbers(country, today);
                for (const number of numbers) {
                    const msgs = await acc.getMessages(number, country, today);
                    for (const m of msgs) {
                        const id   = `${m.phoneNumber}_${m.time}_${m.sender}`;
                        const seen = await dbGet('SELECT 1 FROM seen_ids WHERE msg_id = ? AND chat_id = ?', [id, session.chat_id]);
                        if (!seen) {
                            await dbRun('INSERT OR IGNORE INTO seen_ids (msg_id, chat_id) VALUES (?, ?)', [id, session.chat_id]);
                        }
                    }
                }
            }
            // Trim old seen_ids (keep last 1000 per account)
            await dbRun(`DELETE FROM seen_ids WHERE rowid NOT IN (
                SELECT rowid FROM seen_ids WHERE chat_id = ? ORDER BY rowid DESC LIMIT 1000)`, [session.chat_id]);
        } catch (e) {
            if ([401, 403].includes(e.response?.status)) {
                acc.loggedIn = false;
                activeSessions.delete(session.chat_id);
            }
        }
    }

    setTimeout(pollAllAccounts, POLLING_INTERVAL);
}

// ─── /start /menu ──────────────────────────────────────────────────────────
bot.onText(/\/(start|menu)/, async (msg) => {
    const chatId = msg.chat.id.toString();
    bot.deleteMessage(chatId, msg.message_id).catch(() => {});

    if (!isAdmin(chatId)) {
        await dbRun(
            'INSERT OR IGNORE INTO whitelisted_users (chat_id, username, added_at) VALUES (?,?,?)',
            [chatId, msg.from.username || msg.from.first_name || 'User', new Date().toISOString()]
        );
        if (!(await checkForceSub(chatId))) return sendForceSubMessage(chatId);
    }

    const text   = isAdmin(chatId)
        ? `❖ *𝗣𝗔𝗡𝗦𝗔 𝗔𝗜 𝗪𝗢𝗥𝗞𝗦𝗣𝗔𝗖𝗘* ❖\n━━━━━━━━━━━━━━━━━━━━━━\nSelamat datang di Control Panel.`
        : `❖ *𝗣𝗔𝗡𝗦𝗔 𝗖𝗟𝗜𝗘𝗡𝗧 𝗣𝗢𝗥𝗧𝗔𝗟* ❖\n━━━━━━━━━━━━━━━━━━━━━━\nAkses diverifikasi. Gunakan modul di bawah untuk memulai:`;
    const markup = isAdmin(chatId) ? getMainMenuMarkup() : getUserMenuMarkup();

    const sentMsg = await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: markup });
    userStates.set(chatId, { state: 'IDLE', lastMsgId: sentMsg.message_id });
});

// ─── CALLBACK QUERY ────────────────────────────────────────────────────────
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id.toString();
    const msgId  = query.message.message_id;
    const action = query.data;

    bot.answerCallbackQuery(query.id);

    if (action === 'dummy_btn') return;

    // Force-sub check
    if (action === 'check_join') {
        if (await checkForceSub(chatId)) {
            bot.answerCallbackQuery(query.id, { text: '✅ Verifikasi berhasil!' });
            const markup = isAdmin(chatId) ? getMainMenuMarkup() : getUserMenuMarkup();
            return safeEdit(`❖ *𝗣𝗔𝗡𝗦𝗔 𝗖𝗟𝗜𝗘𝗡𝗧 𝗣𝗢𝗥𝗧𝗔𝗟* ❖\n━━━━━━━━━━━━━━━━━━━━━━\nAkses diverifikasi.`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: markup });
        }
        return bot.answerCallbackQuery(query.id, { text: '❌ Belum join channel!', show_alert: true });
    }

    if (!isAdmin(chatId)) {
        if (!(await checkForceSub(chatId))) {
            bot.answerCallbackQuery(query.id, { text: '⚠️ Anda keluar dari channel!', show_alert: true });
            return sendForceSubMessage(chatId, msgId);
        }
    }

    const state = getState(chatId);

    // ── PUBLIC USER ACTIONS ──────────────────────────────────────────────
    if (action === 'user_get_number' || action === 'user_new_number') {
        if (action === 'user_new_number') { stopOtpPolling(chatId); await releaseNumber(chatId); }

        const acc = getAdminSession();
        if (!acc?.loggedIn) {
            return safeEdit('⚠️ *𝗦𝗬𝗦𝗧𝗘𝗠 𝗢𝗙𝗙𝗟𝗜𝗡𝗘*\nInfrastruktur belum diinisialisasi.', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getUserMenuMarkup() });
        }

        await safeEdit('🔄 *𝗔𝗟𝗟𝗢𝗖𝗔𝗧𝗜𝗡𝗚 𝗟𝗜𝗡𝗘...*', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        const assigned = await assignRandomNumber(chatId);

        if (!assigned) {
            return safeEdit('❌ *𝗡𝗢 𝗥𝗘𝗦𝗢𝗨𝗥𝗖𝗘𝗦*\nSemua node sedang dipakai.', {
                chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '🔄 Coba Lagi', callback_data: 'user_get_number' }]] }
            });
        }

        Object.assign(state, { assignedNumber: assigned.number, assignedRange: assigned.range_name, lastSeenMsgId: null });

        return safeEdit(
            `✅ *𝗥𝗘𝗦𝗢𝗨𝗥𝗖𝗘 𝗔𝗟𝗟𝗢𝗖𝗔𝗧𝗘𝗗*\n━━━━━━━━━━━━━━━━━━━━━━\n📱 \`${assigned.number}\`\n🌍 ${assigned.range_name}\n\n💡 _Input nomor di platform target, lalu Start Listening._`,
            {
                chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [
                    [{ text: `📋 Copy: ${assigned.number}`,       callback_data: 'dummy_btn'      }],
                    [{ text: '📨 Start Listening (Get OTP)', callback_data: 'user_get_otp'   }],
                    [{ text: '🔄 Regenerate Line',           callback_data: 'user_new_number' }]
                ]}
            }
        );
    }

    if (action === 'user_get_otp') {
        let { assignedNumber: number, assignedRange: range } = state;
        if (!number || !range) {
            const row = await dbGet('SELECT number, range_name FROM user_assigned_numbers WHERE user_chat_id = ?', [chatId]);
            if (!row) return safeEdit('❌ Tidak ada sesi aktif. Tekan Request New Number.', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getUserMenuMarkup() });
            state.assignedNumber = row.number; state.assignedRange = row.range_name;
            number = row.number; range = row.range_name;
        }
        await safeEdit(`🔍 *𝗜𝗡𝗜𝗧𝗜𝗔𝗟𝗜𝗭𝗜𝗡𝗚 𝗟𝗜𝗦𝗧𝗘𝗡𝗘𝗥*\n📱 \`${number}\`\n🌍 ${range}\n\nSinkronisasi setiap 5 detik...`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        startOtpPolling(chatId, number, range, msgId);
        return;
    }

    if (action === 'user_cancel_otp') {
        stopOtpPolling(chatId);
        return safeEdit(
            `✋ *𝗟𝗜𝗦𝗧𝗘𝗡𝗘𝗥 𝗧𝗘𝗥𝗠𝗜𝗡𝗔𝗧𝗘𝗗*\nNomor masih terkunci: \`${state.assignedNumber || '-'}\``,
            { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
              reply_markup: { inline_keyboard: [
                  [{ text: '📨 Resume Listening',  callback_data: 'user_get_otp'   }],
                  [{ text: '🔄 Release & Ganti',   callback_data: 'user_new_number' }]
              ]}}
        );
    }

    // ── ADMIN-ONLY ────────────────────────────────────────────────────────
    if (!isAdmin(chatId)) return;

    if (action === 'cmd_cancel') {
        state.state = 'IDLE';
        return safeEdit('❖ *𝗣𝗔𝗡𝗦𝗔 𝗔𝗜 𝗪𝗢𝗥𝗞𝗦𝗣𝗔𝗖𝗘*', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
    }

    if (action === 'cmd_manage_users') {
        const users    = await dbAll('SELECT chat_id, username FROM whitelisted_users ORDER BY added_at DESC LIMIT 50');
        const { count } = await dbGet('SELECT COUNT(*) as count FROM whitelisted_users');
        let text = `👥 *𝗣𝗨𝗕𝗟𝗜𝗖 𝗨𝗦𝗘𝗥𝗦*\nTotal: ${count}\n\n`;
        users.forEach((u, i) => { text += `${i+1}. ${u.username} (\`${u.chat_id}\`)\n`; });
        return safeEdit(text || '_Kosong._', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'cmd_cancel' }]] } });
    }

    if (action === 'cmd_login') {
        state.state = 'WAITING_COOKIE'; state.tempCookies = {};
        return safeEdit(
            `🔑 *𝗔𝗨𝗧𝗛𝗘𝗡𝗧𝗜𝗖𝗔𝗧𝗜𝗢𝗡 𝗚𝗔𝗧𝗘𝗪𝗔𝗬*\nInject cookie: \`nama=nilai\`\nContoh: \`ivas_sms_session=eyJp...\``,
            { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
              reply_markup: { inline_keyboard: [
                  [{ text: '✅ Execute Auth', callback_data: 'cmd_finish_login' }],
                  [{ text: '❌ Abort',         callback_data: 'cmd_cancel'       }]
              ]}}
        );
    }

    if (action === 'cmd_finish_login') {
        if (!state.tempCookies?.['ivas_sms_session']) {
            return safeEdit('❌ *𝗙𝗔𝗧𝗔𝗟*\nParameter `ivas_sms_session` wajib ada.', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getCancelMarkup() });
        }
        state.state = 'IDLE';
        await safeEdit('⏳ *𝗦𝗬𝗡𝗖𝗜𝗡𝗚...*', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        await dbRun('INSERT OR REPLACE INTO sessions (chat_id, cookies) VALUES (?,?)', [chatId, JSON.stringify(state.tempCookies)]);

        if (await startIvasSession(chatId)) {
            const acc   = activeSessions.get(chatId);
            const nums  = await acc.getMyNumbers();
            await dbRun('DELETE FROM wa_numbers WHERE chat_id = ?', [chatId]);
            if (nums.length > 0) return saveNumbersToDB(chatId, nums, msgId);
            return safeEdit('✅ *𝗔𝗨𝗧𝗛 𝗢𝗞*\nLogin valid. Dataset kosong (0 nodes).', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        }
        return safeEdit('❌ *𝗔𝗨𝗧𝗛 𝗙𝗔𝗜𝗟𝗘𝗗*\nCookie expired atau invalid.', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
    }

    if (action === 'cmd_sync_db') {
        const acc = activeSessions.get(chatId);
        if (!acc?.loggedIn) return safeEdit('⚠️ *𝗔𝗨𝗧𝗛 𝗥𝗘𝗤𝗨𝗜𝗥𝗘𝗗*', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        await safeEdit('⏳ *𝗙𝗘𝗧𝗖𝗛𝗜𝗡𝗚...*', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        const nums = await acc.getMyNumbers();
        await dbRun('DELETE FROM wa_numbers WHERE chat_id = ?', [chatId]);
        return nums.length ? saveNumbersToDB(chatId, nums, msgId)
            : safeEdit('✅ *𝗦𝗬𝗡𝗖 𝗢𝗞*\nNodes: 0.', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
    }

    if (action.startsWith('cmd_get_wa_numbers_')) {
        const LIMIT  = 3;
        const offset = Math.max(0, parseInt(action.split('_').pop()) || 0);
        const { count: total } = await dbGet('SELECT COUNT(*) as count FROM wa_numbers WHERE chat_id = ?', [chatId]);

        if (!total) return safeEdit('❌ *𝗘𝗠𝗣𝗧𝗬*\nDatabase kosong.', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });

        const cur  = offset >= total ? 0 : offset;
        const rows = await dbAll('SELECT number, range_name FROM wa_numbers WHERE chat_id = ? LIMIT ? OFFSET ?', [chatId, LIMIT, cur]);

        let text = `📱 *𝗦𝗔𝗩𝗘𝗗 𝗡𝗨𝗠𝗕𝗘𝗥𝗦*\n${cur+1}–${Math.min(cur+LIMIT,total)} of *${total}*\n\n`;
        const kb  = [];
        rows.forEach((n, i) => {
            text += `${cur+i+1}. 🌍 *${n.range_name}*\n   └ \`${n.number}\`\n\n`;
            kb.push([{ text: `📋 ${n.number}`, callback_data: 'dummy_btn' }]);
        });
        const nav = [];
        if (total > LIMIT) nav.push({ text: '🔄 Load More', callback_data: `cmd_get_wa_numbers_${cur+LIMIT}` });
        nav.push({ text: '⬅️ Back', callback_data: 'cmd_cancel' });
        kb.push(nav);
        return safeEdit(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
    }

    if (action === 'cmd_search_range') {
        const acc = activeSessions.get(chatId);
        if (!acc?.loggedIn) return safeEdit('⚠️ *𝗔𝗨𝗧𝗛 𝗥𝗘𝗤𝗨𝗜𝗥𝗘𝗗*', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        state.state = 'WAITING_RANGE';
        return safeEdit('🛒 *𝗕𝗥𝗢𝗪𝗦𝗘 𝗥𝗔𝗡𝗚𝗘*\nInput Range (e.g. `INDONESIA 232428`):', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getCancelMarkup() });
    }

    if (action.startsWith('term_detail_')) {
        const acc = activeSessions.get(chatId);
        if (!acc?.loggedIn) return safeEdit('⚠️ *𝗔𝗨𝗧𝗛 𝗥𝗘𝗤𝗨𝗜𝗥𝗘𝗗*', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        const id = action.replace('term_detail_', '');
        await safeEdit('⏳ *𝗙𝗘𝗧𝗖𝗛𝗜𝗡𝗚 𝗗𝗘𝗧𝗔𝗜𝗟𝗦...*', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        const d = await acc.getTerminationDetails(id);
        if (!d) return safeEdit('❌ *𝗔𝗣𝗜 𝗙𝗔𝗨𝗟𝗧*', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        let txt = `📄 *𝗧𝗘𝗥𝗠𝗜𝗡𝗔𝗧𝗜𝗢𝗡 𝗦𝗣𝗘𝗖𝗦*\n━━━━━━━━━━━━━━━━━━━━━━\n📌 \`${d.rangeName}\`\n💵 A2P: ${d.a2pRate}\n\n`;
        d.limits.forEach(l => { txt += `  └ *${l.key}:* ${l.val}\n`; });
        return safeEdit(txt, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '➕ Beli', callback_data: `add_term_${id}` }],
                                               [{ text: '⬅️ Back', callback_data: 'cmd_cancel'    }]] } });
    }

    if (action.startsWith('add_term_')) {
        const acc = activeSessions.get(chatId);
        if (!acc?.loggedIn) return safeEdit('⚠️ *𝗔𝗨𝗧𝗛 𝗥𝗘𝗤𝗨𝗜𝗥𝗘𝗗*', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        const id = action.replace('add_term_', '');
        await safeEdit('⏳ *𝗣𝗨𝗥𝗖𝗛𝗔𝗦𝗜𝗡𝗚...*', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        const result = await acc.addNumber(id);
        if (result?.message) {
            const existing = new Set((await dbAll('SELECT number FROM wa_numbers WHERE chat_id = ?', [chatId])).map(n => n.number));
            const newNums  = (await acc.getMyNumbers()).filter(n => !existing.has(n.number));
            if (newNums.length) return saveNumbersToDB(chatId, newNums, msgId);
            return safeEdit(`✅ *𝗧𝗥𝗔𝗡𝗦𝗔𝗖𝗧𝗜𝗢𝗡 𝗢𝗞*\n${result.message}`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        }
        return safeEdit('❌ *𝗧𝗥𝗔𝗡𝗦𝗔𝗖𝗧𝗜𝗢𝗡 𝗙𝗔𝗜𝗟𝗘𝗗*', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
    }

    if (action === 'cmd_hunt_wa') {
        const acc = activeSessions.get(chatId);
        if (!acc?.loggedIn) return safeEdit('⚠️ *𝗔𝗨𝗧𝗛 𝗥𝗘𝗤𝗨𝗜𝗥𝗘𝗗*', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        const MAX_BUY    = 10;
        const uniqueRanges   = new Set();
        const purchasedRanges = [];

        await safeEdit(`🎯 *𝗦𝗡𝗜𝗣𝗘𝗥 𝗢𝗡𝗟𝗜𝗡𝗘*\nMaks: ${MAX_BUY} Ranges...`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });

        for (let i = 0; i < 100 && purchasedRanges.length < MAX_BUY; i++) {
            const data = await acc.fetchLiveTestSMS();
            for (const item of data) {
                if (purchasedRanges.length >= MAX_BUY) break;
                const $o = cheerio.load(item.originator);
                const sender = $o('p').text().trim().toLowerCase();
                if ((sender.includes('whatsapp') || sender.includes('wa')) && !uniqueRanges.has(item.range)) {
                    uniqueRanges.add(item.range);
                    await safeEdit(`🎯 *𝗟𝗢𝗖𝗞𝗘𝗗*: \`${item.range}\`\n_Executing..._`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
                    const nums = await acc.getTestNumbersByRange(item.range);
                    if (nums.length) {
                        const res = await acc.addNumber(nums[0].id);
                        if (res?.message?.toLowerCase().includes('done'))
                            purchasedRanges.push({ range: item.range, rate: nums[0].rate });
                    }
                }
            }
            if (purchasedRanges.length < MAX_BUY && i < 99) await delay(3000);
        }

        if (!purchasedRanges.length) {
            return safeEdit(`❌ *𝗦𝗡𝗜𝗣𝗘𝗥 𝗛𝗔𝗟𝗧𝗘𝗗*\n${uniqueRanges.size ? 'Di-override buyer lain.' : 'Feed sepi.'}`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        }

        let reply = `✅ *𝗦𝗡𝗜𝗣𝗘𝗥 𝗦𝗨𝗖𝗖𝗘𝗦𝗦*\n${purchasedRanges.length} Node secured:\n\n`;
        purchasedRanges.forEach((d, i) => { reply += `${i+1}. *${d.range}* — $${d.rate}\n`; });

        const existing = new Set((await dbAll('SELECT number FROM wa_numbers WHERE chat_id = ?', [chatId])).map(n => n.number));
        const newNums  = (await acc.getMyNumbers()).filter(n => !existing.has(n.number));
        if (newNums.length) {
            await safeEdit(reply + '\n⏳ _Syncing DB..._', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
            await delay(2000);
            return saveNumbersToDB(chatId, newNums, msgId);
        }
        return safeEdit(reply, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
    }

    if (action === 'cmd_search') {
        const acc = activeSessions.get(chatId);
        if (!acc?.loggedIn) return safeEdit('⚠️ *𝗔𝗨𝗧𝗛 𝗥𝗘𝗤𝗨𝗜𝗥𝗘𝗗*', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        state.state = 'WAITING_NUMBER';
        const { count } = await dbGet('SELECT COUNT(*) as count FROM wa_numbers WHERE chat_id = ?', [chatId]);
        return safeEdit(`🔍 *𝗚𝗟𝗢𝗕𝗔𝗟 𝗜𝗡𝗕𝗢𝗫*\nMasukkan nomor (e.g. \`2250787560321\`)\n\n_DB: ${count} nodes_`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getCancelMarkup() });
    }

    if (action === 'cmd_delete_all') {
        return safeEdit('⚠️ *𝗖𝗢𝗡𝗙𝗜𝗥𝗠 𝗣𝗨𝗥𝗚𝗘*\nOperasi ini ireversibel.', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [
                [{ text: '⚠️ YA, PURGE', callback_data: 'cmd_confirm_delete_all' }],
                [{ text: '❌ Batal',      callback_data: 'cmd_cancel'             }]
            ]}});
    }

    if (action === 'cmd_confirm_delete_all') {
        const acc = activeSessions.get(chatId);
        if (!acc?.loggedIn) return safeEdit('⚠️ *𝗔𝗨𝗧𝗛 𝗥𝗘𝗤𝗨𝗜𝗥𝗘𝗗*', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        await safeEdit('⏳ *𝗣𝗨𝗥𝗚𝗜𝗡𝗚...*', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        const result = await acc.returnAllNumbers();
        if (result) {
            await Promise.all([
                dbRun('DELETE FROM wa_numbers WHERE chat_id = ?', [chatId]),
                dbRun('DELETE FROM user_assigned_numbers'),
                dbRun('DELETE FROM used_numbers')
            ]);
            return safeEdit(`✅ *𝗣𝗨𝗥𝗚𝗘 𝗢𝗞*\n${result.message || 'Done.'}\n_Tables wiped._`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        }
        return safeEdit('❌ *𝗣𝗨𝗥𝗚𝗘 𝗙𝗔𝗜𝗟𝗘𝗗*\nAPI timeout.', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
    }

    if (action === 'cmd_status') {
        const [{ count: nodes }, { count: users }, { count: rented }, { count: locked }] = await Promise.all([
            dbGet('SELECT COUNT(*) as count FROM wa_numbers WHERE chat_id = ?', [chatId]),
            dbGet('SELECT COUNT(*) as count FROM whitelisted_users'),
            dbGet('SELECT COUNT(*) as count FROM user_assigned_numbers'),
            dbGet('SELECT COUNT(*) as count FROM used_numbers')
        ]);
        return safeEdit(
            `⚙️ *𝗦𝗬𝗦𝗧𝗘𝗠 𝗛𝗘𝗔𝗟𝗧𝗛*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🟢 *IVAS Gateway :* ${activeSessions.has(chatId) ? 'ONLINE' : 'OFFLINE'}\n` +
            `🗃 *Local Nodes   :* ${nodes}\n` +
            `👥 *Public Users  :* ${users}\n` +
            `📱 *Active Rented :* ${rented}\n` +
            `🔐 *Locked Nodes  :* ${locked}`,
            { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() }
        );
    }

    if (action === 'cmd_logout') {
        await Promise.all([
            dbRun('DELETE FROM sessions WHERE chat_id = ?', [chatId]),
            dbRun('DELETE FROM wa_numbers WHERE chat_id = ?', [chatId])
        ]);
        activeSessions.delete(chatId);
        return safeEdit('✅ *𝗦𝗘𝗦𝗦𝗜𝗢𝗡 𝗧𝗘𝗥𝗠𝗜𝗡𝗔𝗧𝗘𝗗*\nCookie & cache dihapus.', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
    }
});

// ─── TEXT INPUT HANDLER ────────────────────────────────────────────────────
bot.on('message', async (msg) => {
    const chatId = msg.chat.id.toString();
    const text   = msg.text;
    if (!text || text.startsWith('/')) return;
    bot.deleteMessage(chatId, msg.message_id).catch(() => {});
    if (!isAdmin(chatId)) return;

    const state    = getState(chatId);
    const menuMsgId = state.lastMsgId;

    if (state.state === 'WAITING_COOKIE') {
        const eqIdx = text.indexOf('=');
        if (eqIdx > 0) {
            const name  = text.slice(0, eqIdx).trim();
            const value = text.slice(eqIdx + 1).trim();
            if (!state.tempCookies) state.tempCookies = {};
            state.tempCookies[name] = value;
            const keys = Object.keys(state.tempCookies).map(k => `\`${k}\``).join(', ');
            return safeEdit(
                `🔑 *𝗔𝗨𝗧𝗛 𝗚𝗔𝗧𝗘𝗪𝗔𝗬*\n✅ Key Loaded!\nKeys: ${keys}\n\nInject lagi atau tekan Execute.`,
                { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown',
                  reply_markup: { inline_keyboard: [
                      [{ text: '✅ Execute Auth', callback_data: 'cmd_finish_login' }],
                      [{ text: '❌ Abort',         callback_data: 'cmd_cancel'       }]
                  ]}}
            );
        }
        return safeEdit('❌ *𝗠𝗔𝗟𝗙𝗢𝗥𝗠𝗘𝗗*\nGunakan format `key=value`.', { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getCancelMarkup() });
    }

    if (state.state === 'WAITING_RANGE') {
        state.state = 'IDLE';
        const acc = activeSessions.get(chatId);
        if (!acc?.loggedIn) return safeEdit('⚠️ *𝗦𝗘𝗦𝗦𝗜𝗢𝗡 𝗘𝗫𝗣𝗜𝗥𝗘𝗗*', { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        const range = text.trim();
        await safeEdit(`🔍 *𝗤𝗨𝗘𝗥𝗬𝗜𝗡𝗚*: \`${range}\`...`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown' });
        const nums = await acc.getTestNumbersByRange(range);
        if (!nums.length) return safeEdit(`❌ *𝟰𝟬𝟰*\nRange \`${range}\` kosong.`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        let reply = `✅ *${range}*\n${nums.length} nodes ready.\n\n`;
        const kb  = nums.slice(0, 10).map(n => [{ text: `📱 ${n.number} — $${n.rate}`, callback_data: `term_detail_${n.id}` }]);
        kb.push([{ text: '❌ Cancel', callback_data: 'cmd_cancel' }]);
        return safeEdit(reply, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
    }

    if (state.state === 'WAITING_NUMBER') {
        state.state = 'IDLE';
        const acc    = activeSessions.get(chatId);
        if (!acc?.loggedIn) return safeEdit('⚠️ *𝗦𝗘𝗦𝗦𝗜𝗢𝗡 𝗘𝗫𝗣𝗜𝗥𝗘𝗗*', { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        const target = text.trim();
        const today  = getTodayUTC();
        bot.sendChatAction(chatId, 'typing').catch(() => {});

        let msgs = null;
        const dbRow = await dbGet('SELECT range_name FROM wa_numbers WHERE number = ? AND chat_id = ?', [target, chatId]);
        if (dbRow) {
            await safeEdit(`⚡ *𝗖𝗔𝗖𝗛𝗘 𝗛𝗜𝗧*: \`${dbRow.range_name}\``, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown' });
            msgs = await acc.getMessages(target, dbRow.range_name, today);
        } else {
            await safeEdit('🔍 *𝗚𝗟𝗢𝗕𝗔𝗟 𝗦𝗖𝗔𝗡*\nCache miss...', { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown' });
            const countries = await acc.getCountries(today);
            for (const c of countries) {
                const numbers = await acc.getNumbers(c, today);
                if (numbers.includes(target)) {
                    msgs = await acc.getMessages(target, c, today);
                    break;
                }
            }
        }

        if (msgs?.length) {
            for (const m of msgs) {
                const card = formatMessageCard(m);
                await bot.sendMessage(chatId, card.text, { parse_mode: 'Markdown', reply_markup: card.reply_markup });
            }
            return safeEdit(`✅ *𝗢𝗣𝗘𝗥𝗔𝗧𝗜𝗢𝗡 𝗖𝗢𝗠𝗣𝗟𝗘𝗧𝗘*\nHistori untuk \`${target}\` dikirim.`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
        }
        return safeEdit(`❌ *𝗡𝗢 𝗥𝗘𝗖𝗢𝗥𝗗𝗦*\nTidak ada pesan untuk \`${target}\`.`, { chat_id: chatId, message_id: menuMsgId, parse_mode: 'Markdown', reply_markup: getMainMenuMarkup() });
    }
});

// ─── BOOTSTRAP ─────────────────────────────────────────────────────────────
(async () => {
    console.log('[SYSTEM] Initializing DB & Sessions...');
    const sessions = await dbAll('SELECT * FROM sessions');
    await Promise.all(sessions.map(async s => {
        const acc = new IVASAccount(s.chat_id, JSON.parse(s.cookies));
        if (await acc.initSession()) activeSessions.set(s.chat_id, acc);
    }));
    pollAllAccounts();
    console.log(`[SYSTEM] Ready — ${activeSessions.size} session(s) loaded.`);
})();
