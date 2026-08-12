const axios = require('axios');
const DigestFetch = require('digest-fetch');

const NVR_IP = "103.136.137.208";
const BASE_URL = `http://${NVR_IP}`;

function stamped(url) {
    const pad = (n) => String(n).padStart(2, '0');
    const d = new Date();
    return `${url}?${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}@${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function run() {
    console.log("Logging in...");
    const client = new DigestFetch('admin', 'admin', { algorithm: 'MD5' });
    
    // NVR Login trick
    try { await axios.post(stamped(`${BASE_URL}/API/Login/Range`), {}, { timeout: 5000 }); } catch(e){}
    try { await axios.post(stamped(`${BASE_URL}/API/AccountRules/Get`), {}, { timeout: 5000 }); } catch(e){}

    const fetchPromise = client.fetch(stamped(`${BASE_URL}/API/Web/Login`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: '1.0', data: {} })
    });
    
    const res = await fetchPromise;
    const headers = {};
    res.headers.forEach((v, k) => headers[k.toLowerCase()] = v);
    
    const sessionCookie = (headers['set-cookie'] || '').split(';')[0];
    const csrfToken = headers['x-csrftoken'] || '';

    const hdrs = {
        "Content-Type": "application/json",
        "X-CSRFToken": csrfToken,
        "Cookie": sessionCookie
    };

    console.log("Logged in. Cookie:", sessionCookie, "CSRF:", csrfToken);
    
    const payload = {
        version: '1.0',
        data: {
            StartTime: "2026-08-05 00:00:00",
            EndTime: "2026-08-05 23:59:59",
            Chn: [0],
            Engine: 1
        }
    };
    
    console.log("Searching with payload:", JSON.stringify(payload));
    
    const searchRes = await axios.post(stamped(`${BASE_URL}/API/AI/SnapedObjects/SearchPlate`), payload, {
        headers: hdrs,
        timeout: 10000
    });
    
    console.log("Search Result:", JSON.stringify(searchRes.data, null, 2));
}

run().catch(console.error);
