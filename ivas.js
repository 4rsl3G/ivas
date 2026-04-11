const axios = require('axios');
const { buildCookieHeader, getCsrfToken } = require('./cookie');

const BASE_URL = 'https://www.ivasms.com';

// ─── AXIOS INSTANCE & INTERCEPTORS (CANGGIH) ──────────────────────────────────
function createClient(cookie) {
  const client = axios.create({
    baseURL: BASE_URL,
    timeout: 30000,
    headers: {
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Cookie': buildCookieHeader(cookie),
      'X-CSRF-TOKEN': getCsrfToken(cookie),
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      'Referer': BASE_URL + '/portal',
      'Origin': BASE_URL,
    }
  });

  // Global Interceptor: Otomatis memantau semua response untuk mendeteksi session expired
  client.interceptors.response.use(
    (response) => {
      const data = response.data;
      // Cek apakah di-redirect ke halaman login
      if (typeof data === 'string' && (data.includes('/auth/login') || data.includes('Login'))) {
        return Promise.reject({ expired: true, message: 'Session expired (redirect)' });
      }
      return response;
    },
    (error) => {
      if (error.response) {
        const status = error.response.status;
        if ([401, 403, 419].includes(status)) {
          return Promise.reject({ expired: true, message: 'Session expired' });
        }
      }
      return Promise.reject(error);
    }
  );

  return client;
}

// ─── ERROR HANDLER ────────────────────────────────────────────────────────────
function handleError(err) {
  // Jika error berasal dari interceptor (sudah diformat)
  if (err.expired !== undefined) return err;
  
  return { expired: false, error: true, message: err.message || 'Unknown error occurred' };
}

// ─── 1. RETURN ALL NUMBERS ────────────────────────────────────────────────────
async function returnAllNumbers(cookie) {
  try {
    const client = createClient(cookie);
    const params = new URLSearchParams({ _token: getCsrfToken(cookie) });

    const res = await client.post('/portal/numbers/return/allnumber/bluck', params, {
      headers: { 'Referer': BASE_URL + '/portal/numbers' }
    });

    return {
      expired: false,
      message: res.data?.message || 'Berhasil return semua numbers',
      data: res.data
    };
  } catch (err) {
    return handleError(err);
  }
}

// ─── 2. AMBIL SID WHATSAPP TERBARU ───────────────────────────────────────────
async function getLatestWhatsappSID(cookie, keyword = 'whatsapp', limit = 10) {
  try {
    const client = createClient(cookie);
    const params = new URLSearchParams({
      'draw': '1',
      'columns[0][data]': 'range',
      'columns[1][data]': 'termination.test_number',
      'columns[2][data]': 'originator',
      'columns[3][data]': 'messagedata',
      'columns[4][data]': 'senttime',
      'order[0][column]': '4',
      'order[0][dir]': 'desc',
      'start': '0',
      'length': String(limit),
      'search[value]': keyword,
      '_': String(Date.now())
    });

    const res = await client.get(`/portal/sms/test/sms?${params.toString()}`, {
      headers: { 'Referer': BASE_URL + '/portal/sms/test/sms' }
    });

    return { expired: false, data: res.data?.data || [], total: res.data?.recordsTotal || 0 };
  } catch (err) {
    return handleError(err);
  }
}

// ─── 3. AMBIL TEST NUMBERS ────────────────────────────────────────────────────
async function getTestNumbers(cookie, searchQuery = '', limit = 50) {
  try {
    const client = createClient(cookie);
    const params = new URLSearchParams({
      'draw': '1',
      'columns[0][data]': 'range',
      'columns[1][data]': 'test_number',
      'columns[8][data]': 'action',
      'order[0][column]': '8',
      'order[0][dir]': 'desc',
      'start': '0',
      'length': String(limit),
      'search[value]': searchQuery,
      '_': String(Date.now())
    });

    const res = await client.get(`/portal/numbers/test?${params.toString()}`, {
      headers: { 'Referer': BASE_URL + '/portal/numbers/test' }
    });

    return { expired: false, data: res.data?.data || [], total: res.data?.recordsTotal || 0 };
  } catch (err) {
    return handleError(err);
  }
}

// ─── 4. ADD NUMBER ────────────────────────────────────────────────────────────
async function addNumber(cookie, terminationId) {
  try {
    const client = createClient(cookie);
    const params = new URLSearchParams({
      '_token': getCsrfToken(cookie),
      'id': String(terminationId)
    });

    const res = await client.post('/portal/numbers/termination/number/add', params, {
      headers: { 'Referer': BASE_URL + '/portal/numbers/test' }
    });

    return {
      expired: false,
      message: res.data?.message || 'Number berhasil ditambahkan',
      data: res.data
    };
  } catch (err) {
    // Handling khusus Rate Limit
    if (err.response?.status === 429) {
      return { expired: false, message: 'Rate limited - number mungkin sudah ada', data: null };
    }
    return handleError(err);
  }
}

// ─── 5. GET SMS STATISTICS (RANGE LEVEL) ─────────────────────────────────────
async function getSMSStats(cookie, fromDate, toDate) {
  try {
    const client = createClient(cookie);
    const params = new URLSearchParams({
      '_token': getCsrfToken(cookie),
      'from': fromDate,
      'to': toDate
    });

    const res = await client.post('/portal/sms/received/getsms', params, {
      headers: { 'Accept': 'text/html, */*; q=0.01', 'Referer': BASE_URL + '/portal/sms/received' }
    });

    return { expired: false, data: parseStatsHTML(res.data) };
  } catch (err) {
    return handleError(err);
  }
}

// ─── 6. GET SMS DETAIL PER NUMBER ─────────────────────────────────────────────
async function getSMSDetail(cookie, fromDate, toDate, number, range) {
  try {
    const client = createClient(cookie);
    const params = new URLSearchParams({
      '_token': getCsrfToken(cookie),
      'start': fromDate,
      'end': toDate,
      'Number': number,
      'Range': range
    });

    const res = await client.post('/portal/sms/received/getsms/number/sms', params, {
      headers: { 'Accept': 'text/html, */*; q=0.01', 'Referer': BASE_URL + '/portal/sms/received' }
    });

    return { expired: false, data: parseSMSDetailHTML(res.data), rawHtml: res.data };
  } catch (err) {
    return handleError(err);
  }
}

// ─── HTML PARSERS (MODERN JS) ─────────────────────────────────────────────────
function parseStatsHTML(html) {
  if (!html || typeof html !== 'string') return [];

  // Helper untuk mengekstrak menggunakan matchAll ES2020
  const extract = (regex) => [...html.matchAll(regex)].map(m => m[1].trim());

  const ranges = extract(/class="rname"[^>]*>([^<]+)<\/span>/g);
  const counts = extract(/class="c-val v-count"[^>]*>(\d+)<\/div>/g);
  const paids = extract(/class="c-val v-paid"[^>]*>(\d+)<\/div>/g);
  const unpaids = extract(/class="c-val v-unpaid"[^>]*>(\d+)<\/div>/g);
  const revenues = extract(/class="c-val v-rev"[^>]*>\$?([\d.]+)/g);

  const results = ranges.map((range, i) => ({
    range_name: range,
    count: counts[i] || '0',
    paid: paids[i] || '0',
    unpaid: unpaids[i] || '0',
    revenue: revenues[i] || '0'
  }));

  if (results.length === 0 && html.length > 0) {
    return [{ raw: html.substring(0, 500), parse_failed: true }];
  }

  return results;
}

function parseSMSDetailHTML(html) {
  if (!html || typeof html !== 'string') return [];
  
  const rows = [];
  const trMatches = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)];
  
  for (const m of trMatches) {
    const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
      .map(td => td[1].replace(/<[^>]+>/g, '').trim());
    
    if (tds.length >= 3) rows.push(tds);
  }
  
  return rows;
}

module.exports = {
  returnAllNumbers,
  getLatestWhatsappSID,
  getTestNumbers,
  addNumber,
  getSMSStats,
  getSMSDetail
};
