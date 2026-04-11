const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar, Cookie } = require('tough-cookie');
const cheerio = require('cheerio');
require('dotenv').config();

const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });
const POLLING_INTERVAL = process.env.POLLING_INTERVAL || 60000;
const BROADCAST_CHANNEL = process.env.BROADCAST_CHANNEL_ID;

const DB_FILE = './db_sessions.json';
let db = {};
if (fs.existsSync(DB_FILE)) {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveDb() {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function getTodayUTC() {
    return new Date().toISOString().split('T')[0];
}

// State management untuk melacak user sedang melakukan apa (input cookie / search nomor)
const userStates = {};

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
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
            }
        }));
        this.loggedIn = false;
        this.csrfToken = null;
    }

    async initSession() {
        for (const [name, value] of Object.entries(this.cookies)) {
            const cookie = new Cookie({ key: name, value: value, domain: 'www.ivasms.com' });
            await this.jar.setCookie(cookie.toString(), 'https://www.ivasms.com');
        }

        try {
            const response = await this.client.get('/portal/sms/received');
            if (response.status === 200) {
                const $ = cheerio.load(response.data);
                const csrfInput = $('input[name="_token"]');
                if (csrfInput.length) {
                    this.csrfToken = csrfInput.val();
                    this.loggedIn = true;
                    return true;
                }
            }
            return false;
        } catch (error) {
            console.error(`[${this.chatId}] Login error:`, error.message);
            return false;
        }
    }

    async getCountries(dateStr) {
        try {
            const payload = new URLSearchParams({ 'from': dateStr, 'to': dateStr, '_token': this.csrfToken });
            const response = await this.client.post('/portal/sms/received/getsms', payload.toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' }
            });
            if (response.status === 200) {
                const $ = cheerio.load(response.data);
                const countries = [];
                $('div.rng').each((i, el) => { countries.push($(el).find('.rname').text().trim()); });
                return countries;
            }
            return [];
        } catch (error) { return []; }
    }

    async getNumbers(countryRange, dateStr) {
        try {
            const payload = new URLSearchParams({ '_token': this.csrfToken, 'start': dateStr, 'end': dateStr, 'range': countryRange });
            const response = await this.client.post('/portal/sms/received/getsms/number', payload.toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' }
            });
            if (response.status === 200) {
                const $ = cheerio.load(response.data);
                const numbers = [];
                $('div.nrow').each((i, el) => { numbers.push($(el).find('.nnum').text().trim()); });
                return numbers;
            }
            return [];
        } catch (error) { return []; }
    }

    async getMessages(phoneNumber, countryRange, dateStr) {
        try {
            const payload = new URLSearchParams({ '_token': this.csrfToken, 'start': dateStr, 'end': dateStr, 'Number': phoneNumber, 'Range': countryRange });
            const response = await this.client.post('/portal/sms/received/getsms/number/sms', payload.toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' }
            });
            if (response.status === 200) {
                const $ = cheerio.load(response.data);
                const messages = [];
                $('tbody tr').each((i, el) => {
                    const sender = $(el).find('.cli-tag').text().trim();
                    const text = $(el).find('.msg-text').text().trim();
                    const time = $(el).find('.time-cell').text().trim();
                    if (text) messages.push({ sender, text, time, phoneNumber, countryRange });
                });
                return messages;
            }
            return [];
        } catch (error) { return []; }
    }
}

const activeSessions = new Map();

async function startSession(chatId) {
    if (db[chatId] && db[chatId].cookies) {
        const account = new IVASAccount(chatId, db[chatId].cookies);
        const success = await account.initSession();
        if (success) {
            activeSessions.set(chatId, account);
            return true;
        }
    }
    return false;
}

(async () => {
    console.log('Bot is running. Initializing saved sessions...');
    for (const chatId of Object.keys(db)) {
        await startSession(chatId);
    }
    pollAllAccounts();
})();

// --- UI BUTTONS ---
const mainMenuMarkup = {
    inline_keyboard: [
        [{ text: '🔑 Login / Update Cookie', callback_data: 'cmd_login' }],
        [{ text: '🔍 Cari Nomor (Cek OTP)', callback_data: 'cmd_search' }],
        [{ text: '📊 Cek Status', callback_data: 'cmd_status' }, { text: '🚪 Logout', callback_data: 'cmd_logout' }]
    ]
};

const cancelMarkup = {
    inline_keyboard: [[{ text: '❌ Batal', callback_data: 'cmd_cancel' }]]
};

// --- HANDLERS ---
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, `*🤖 Ivasms Auto-Bot Panel*\nSilakan pilih menu di bawah ini:`, { 
        parse_mode: 'Markdown',
        reply_markup: mainMenuMarkup 
    });
});

// Menangkap klik tombol
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id.toString();
    const action = query.data;

    bot.answerCallbackQuery(query.id); // Hilangkan loading di tombol

    if (action === 'cmd_login') {
        userStates[chatId] = 'WAITING_COOKIE';
        bot.sendMessage(chatId, "Kirimkan *JSON Object* cookie kamu di sini.\n\n_Pesanmu akan otomatis dihapus bot demi keamanan._", { parse_mode: 'Markdown', reply_markup: cancelMarkup });
    } 
    else if (action === 'cmd_search') {
        if (!activeSessions.has(chatId)) return bot.sendMessage(chatId, "⚠️ Kamu harus login terlebih dahulu!");
        userStates[chatId] = 'WAITING_NUMBER';
        bot.sendMessage(chatId, "Masukkan nomor telepon yang ingin dicari (contoh: `2250103540220`):", { parse_mode: 'Markdown', reply_markup: cancelMarkup });
    }
    else if (action === 'cmd_status') {
        if (activeSessions.has(chatId)) {
            bot.sendMessage(chatId, "🟢 *Status:* AKTIF\nBot memantau OTP secara realtime.", { parse_mode: 'Markdown', reply_markup: mainMenuMarkup });
        } else {
            bot.sendMessage(chatId, "🔴 *Status:* OFFLINE\nSesi tidak aktif. Silakan login.", { parse_mode: 'Markdown', reply_markup: mainMenuMarkup });
        }
    }
    else if (action === 'cmd_logout') {
        if (db[chatId]) {
            delete db[chatId];
            saveDb();
            activeSessions.delete(chatId);
            bot.sendMessage(chatId, "✅ Berhasil logout dan data dihapus.", { reply_markup: mainMenuMarkup });
        }
    }
    else if (action === 'cmd_cancel') {
        delete userStates[chatId];
        bot.deleteMessage(chatId, query.message.message_id).catch(()=>{}); // Hapus dialog input
        bot.sendMessage(chatId, "Operasi dibatalkan.", { reply_markup: mainMenuMarkup });
    }
});

// Menangkap pesan teks biasa (digunakan untuk input form Cookie / Nomor)
bot.on('message', async (msg) => {
    const chatId = msg.chat.id.toString();
    const text = msg.text;

    // Abaikan jika pesan adalah command (diawali '/')
    if (!text || text.startsWith('/')) return;

    // Selalu hapus pesan pengguna untuk kebersihan & privasi
    bot.deleteMessage(chatId, msg.message_id).catch(() => console.error("Tidak bisa hapus pesan (mungkin bukan admin grup)"));

    const state = userStates[chatId];

    if (state === 'WAITING_COOKIE') {
        delete userStates[chatId]; // Reset state
        try {
            const cookiesRaw = JSON.parse(text);
            let cookiesObj = {};
            
            if (Array.isArray(cookiesRaw)) {
                cookiesRaw.forEach(c => { if (c.name && c.value) cookiesObj[c.name] = c.value; });
            } else {
                cookiesObj = cookiesRaw;
            }

            if (!cookiesObj['ivas_sms_session'] || !cookiesObj['XSRF-TOKEN']) {
                return bot.sendMessage(chatId, "❌ Cookie tidak valid. Coba lagi.", { reply_markup: mainMenuMarkup });
            }

            if (!db[chatId]) db[chatId] = { seenIds: [] };
            db[chatId].cookies = cookiesObj;
            saveDb();

            const loadingMsg = await bot.sendMessage(chatId, "⏳ Sedang mencoba login...");
            const success = await startSession(chatId);
            
            bot.deleteMessage(chatId, loadingMsg.message_id);

            if (success) {
                bot.sendMessage(chatId, "✅ *Login Berhasil!*\nBot mulai memantau OTP secara otomatis.", { parse_mode: 'Markdown', reply_markup: mainMenuMarkup });
            } else {
                bot.sendMessage(chatId, "❌ *Login Gagal!*\nCookie mungkin sudah kedaluwarsa.", { parse_mode: 'Markdown', reply_markup: mainMenuMarkup });
            }
        } catch (error) {
            bot.sendMessage(chatId, "❌ *Format JSON salah!*", { parse_mode: 'Markdown', reply_markup: mainMenuMarkup });
        }
    } 
    else if (state === 'WAITING_NUMBER') {
        delete userStates[chatId];
        const targetNumber = text.trim();
        const account = activeSessions.get(chatId);
        const todayStr = getTodayUTC();
        
        const loadingMsg = await bot.sendMessage(chatId, `🔍 Mencari histori untuk nomor \`${targetNumber}\`...`, { parse_mode: 'Markdown' });

        try {
            const countries = await account.getCountries(todayStr);
            let foundMessages = null;
            let foundCountry = '';

            for (const c of countries) {
                const numbers = await account.getNumbers(c, todayStr);
                if (numbers.includes(targetNumber)) {
                    foundMessages = await account.getMessages(targetNumber, c, todayStr);
                    foundCountry = c;
                    break;
                }
            }

            bot.deleteMessage(chatId, loadingMsg.message_id);

            if (foundMessages && foundMessages.length > 0) {
                let reply = `✅ *Ditemukan (${foundCountry})*\nNomor: \`${targetNumber}\`\n\n`;
                foundMessages.forEach(msg => {
                    reply += `📨 *${msg.sender}* (${msg.time})\n\`${msg.text}\`\n\n`;
                });
                bot.sendMessage(chatId, reply, { parse_mode: 'Markdown', reply_markup: mainMenuMarkup });
            } else {
                bot.sendMessage(chatId, `❌ Nomor \`${targetNumber}\` tidak ditemukan atau tidak ada SMS masuk hari ini.`, { parse_mode: 'Markdown', reply_markup: mainMenuMarkup });
            }
        } catch (error) {
            bot.deleteMessage(chatId, loadingMsg.message_id);
            bot.sendMessage(chatId, "⚠️ Terjadi kesalahan saat mencari nomor.");
        }
    }
});

// --- HELPER: FORMAT ALERT ---
function formatAlert(msgData) {
    // Mencari 6 digit angka berturut-turut untuk format "Copy OTP"
    const otpMatch = msgData.text.match(/\b\d{6}\b/);
    const otpHighlight = otpMatch ? `\n\n🔑 *COPY OTP:* \`${otpMatch[0]}\` (Tap)` : '';

    return `🔔 *NEW OTP RECEIVED*\n\n` +
           `📱 *Number:* \`${msgData.phoneNumber}\`\n` +
           `🌍 *Region:* ${msgData.countryRange}\n` +
           `📨 *Sender:* ${msgData.sender}\n` +
           `⏱ *Time:* ${msgData.time} (UTC)\n\n` +
           `💬 *Message:*\n\`${msgData.text}\`` + 
           otpHighlight;
}

// --- REALTIME POLLING ---
async function pollAllAccounts() {
    const todayStr = getTodayUTC();

    for (const [chatId, account] of activeSessions.entries()) {
        try {
            if (!account.loggedIn) await account.initSession();
            if (!account.loggedIn) continue;

            if (!db[chatId].seenIds) db[chatId].seenIds = [];
            let hasNewMessage = false;

            const countries = await account.getCountries(todayStr);
            for (const country of countries) {
                const numbers = await account.getNumbers(country, todayStr);
                for (const number of numbers) {
                    const messages = await account.getMessages(number, country, todayStr);
                    
                    for (const msg of messages) {
                        const msgId = `${msg.phoneNumber}_${msg.time}_${msg.sender}`;

                        if (!db[chatId].seenIds.includes(msgId)) {
                            db[chatId].seenIds.push(msgId);
                            hasNewMessage = true;

                            const textAlert = formatAlert(msg);
                            const options = { parse_mode: 'Markdown' };

                            // 1. Kirim ke User Private
                            bot.sendMessage(chatId, textAlert, options).catch(()=>{});

                            // 2. Kirim ke Broadcast Channel (Jika disetel di .env)
                            if (BROADCAST_CHANNEL) {
                                bot.sendMessage(BROADCAST_CHANNEL, textAlert, options).catch(err => {
                                    console.error("Gagal broadcast ke channel:", err.message);
                                });
                            }
                        }
                    }
                }
            }

            if (hasNewMessage) {
                if (db[chatId].seenIds.length > 500) {
                    db[chatId].seenIds = db[chatId].seenIds.slice(-500);
                }
                saveDb();
            }

        } catch (error) {
            if (error.response && (error.response.status === 401 || error.response.status === 403)) {
                account.loggedIn = false; 
                bot.sendMessage(chatId, "⚠️ *Peringatan:* Cookie sepertinya kedaluwarsa. Silakan login ulang via menu.", { parse_mode: 'Markdown', reply_markup: mainMenuMarkup });
                activeSessions.delete(chatId);
            }
        }
    }
    setTimeout(pollAllAccounts, POLLING_INTERVAL);
}
