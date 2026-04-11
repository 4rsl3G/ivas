const fs = require('fs');
const path = require('path');

const COOKIE_FILE = path.join(__dirname, 'cookies.json');

// ─── LOKAL HELPERS ────────────────────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  console.log(`[Cookie][${ts}] ${msg}`);
}

// ─── FUNGSI UTAMA ─────────────────────────────────────────────────────────────
function loadCookie() {
  try {
    if (!fs.existsSync(COOKIE_FILE)) {
      return null;
    }

    const rawData = fs.readFileSync(COOKIE_FILE, 'utf-8');
    
    // Cegah error jika file ada tapi isinya kosong (blank)
    if (!rawData.trim()) return null;

    const data = JSON.parse(rawData);

    // Validasi struktur data cookie
    if (!data.raw || !data.XSRF_TOKEN || !data.session) {
      log('Format cookies.json tidak valid atau session hilang.');
      return null;
    }

    return data;
  } catch (e) {
    log(`Error memuat cookie: ${e.message}`);
    return null;
  }
}

function saveCookie(cookieObj, rawString) {
  try {
    const data = {
      raw: rawString,
      XSRF_TOKEN: cookieObj['XSRF-TOKEN'] || '',
      session: cookieObj['ivas_sms_session'] || '',
      saved_at: new Date().toISOString()
    };

    // Simpan dengan mode 0o600 (Read/Write khusus Owner) demi keamanan data sesi
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
    log('Cookie berhasil diperbarui dan disimpan.');
    
    return data;
  } catch (e) {
    log(`Error menyimpan cookie: ${e.message}`);
    throw e;
  }
}

function getCsrfToken(cookie) {
  if (!cookie || !cookie.XSRF_TOKEN) return '';
  
  // CSRF token = XSRF-TOKEN cookie value (harus di-URL decode)
  try {
    return decodeURIComponent(cookie.XSRF_TOKEN);
  } catch {
    return cookie.XSRF_TOKEN;
  }
}

function buildCookieHeader(cookie) {
  if (!cookie) return '';
  return `XSRF-TOKEN=${cookie.XSRF_TOKEN}; ivas_sms_session=${cookie.session}`;
}

module.exports = { loadCookie, saveCookie, getCsrfToken, buildCookieHeader };
