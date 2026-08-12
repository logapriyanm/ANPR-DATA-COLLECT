const axios = require('axios');
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const DigestFetch = require('digest-fetch');

// --- CONFIGURATION ---
const NVR_IP = "103.136.137.208";
const NVR_USER = "admin";
const NVR_PASS = "admin";
const START_DATE = "2026-08-04"; // Fetch data from 3 days ago
const END_DATE = "2026-08-08"; // Until today
const TARGET_CHANNELS = [0, 1, 2, 3, 4, 5, 6, 7]; // Add more if needed

const BASE_URL = `http://${NVR_IP}`;
const CAPTURES_DIR = path.join(__dirname, 'Captures');
const PROGRESS_FILE = path.join(__dirname, 'progress.json');

// --- HEADERS STATE ---
let sessionCookie = '';
let csrfToken = '';

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function stamped(url) {
    const pad = (n) => String(n).padStart(2, '0');
    const d = new Date();
    return `${url}?${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}@${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function hdrs() {
    return {
        "Content-Type": "application/json",
        "X-CSRFToken": csrfToken,
        "Cookie": sessionCookie
    };
}

async function login() {
    console.log(`🔐 Logging in to NVR at ${BASE_URL}...`);
    const client = new DigestFetch(NVR_USER, NVR_PASS, { algorithm: 'MD5' });

    try {
        await axios.post(stamped(`${BASE_URL}/API/Login/Range`), {}, { headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
        await axios.post(stamped(`${BASE_URL}/API/AccountRules/Get`), {}, { headers: { 'Content-Type': 'application/json' }, timeout: 10000 });

        const fetchPromise = client.fetch(stamped(`${BASE_URL}/API/Web/Login`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ version: '1.0', data: {} })
        });

        const res = await fetchPromise;
        const headers = {};
        res.headers.forEach((v, k) => headers[k.toLowerCase()] = v);

        if (res.status !== 200) {
            throw new Error(`Login HTTP ${res.status}`);
        }

        sessionCookie = (headers['set-cookie'] || '').split(';')[0];
        csrfToken = headers['x-csrftoken'] || '';

        console.log(`✅ Login successful.`);
        return true;
    } catch (err) {
        console.error(`❌ Login failed:`, err.message);
        return false;
    }
}

async function keepAlive() {
    setInterval(async () => {
        if (!sessionCookie) return;
        try {
            await axios.post(stamped(`${BASE_URL}/API/Login/Heartbeat`), { version: '1.0', data: { keep_alive: true } }, { headers: hdrs() });
        } catch (err) {
            console.warn(`⚠️ Heartbeat failed`);
        }
    }, 15000); // 15 sec heartbeat
}

function loadProgress() {
    if (fs.existsSync(PROGRESS_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
        } catch (e) {}
    }
    return { lastDateProcessed: null };
}

function saveProgress(dateStr) {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ lastDateProcessed: dateStr }, null, 2));
}

async function processSlot(startStr, endStr) {
    console.log(`\n📋 Searching slot: ${startStr} to ${endStr}`);

    let total = 0;
    try {
        const searchRes = await axios.post(stamped(`${BASE_URL}/API/AI/SnapedObjects/SearchPlate`), {
            version: '1.0',
            data: { StartTime: startStr, EndTime: endStr, Chn: TARGET_CHANNELS, Engine: 1 }
        }, { headers: hdrs(), timeout: 15000 });

        if (searchRes.data?.data?.result === 'failed') {
            console.warn(`⚠️ SearchPlate failed: ${searchRes.data?.data?.reason}`);
            return;
        }

        total = searchRes.data?.data?.Count || 0;
        console.log(`Found ${total} captures in slot.`);
    } catch (err) {
        console.error(`❌ SearchPlate error:`, err.message);
        return;
    }

    if (total === 0) return;

    let fetched = 0;
    const batchSize = 10;
    let batchNumber = 0;

    while (fetched < total) {
        const countToFetch = Math.min(batchSize, total - fetched);
        console.log(`Fetching batch ${++batchNumber}, startIndex: ${fetched}, count: ${countToFetch}...`);
        
        try {
            const getRes = await axios.post(stamped(`${BASE_URL}/API/AI/SnapedObjects/GetByIndex`), {
                version: '1.0',
                data: {
                    Engine: 1,
                    StartIndex: fetched,
                    Count: countToFetch,
                    WithObjectImage: 1,
                    WithBackgroud: 1
                }
            }, { headers: hdrs(), timeout: 20000 });

            const batch = getRes.data?.data?.SnapedObjInfo || [];
            if (batch.length === 0) {
                console.warn("⚠️ API returned 0 results for batch, breaking to avoid infinite loop.");
                break; // Safety break
            }
            
            for (const item of batch) {
                saveCaptureToDisk(item);
            }
            
            fetched += batch.length;
            await sleep(1500); // Prevent overwhelming NVR
        } catch (err) {
             console.error(`❌ GetByIndex error:`, err.message);
             console.log(`Retrying batch in 5 seconds...`);
             await sleep(5000);
             // don't increment fetched, it will retry the same startIndex
        }
    }
}

function saveCaptureToDisk(item) {
    const snapId = item.SnapId !== undefined && item.SnapId !== null ? String(item.SnapId) : (item.UUId || 'NOID');
    let plateText = item.Plate || 'unknown';
    
    const timestamp = item.StartTime ? item.StartTime * 1000 : Date.now();
    const dateStr = item.StartTime ? new Date(item.StartTime * 1000).toISOString().replace(/[: ]/g, '-') : Date.now();

    const safeBaseName = `${snapId}_${plateText}_${timestamp}`.replace(/[^a-zA-Z0-9_\-]/g, '_');

    const channelLabel = item.StrChn || item.Chn || 'UNKNOWN_CH';
    const channelDir = path.join(CAPTURES_DIR, String(channelLabel));
    
    if (!fs.existsSync(channelDir)) {
        fs.mkdirSync(channelDir, { recursive: true });
    }

    // Save JSON metadata
    const jsonPath = path.join(channelDir, `${safeBaseName}.json`);
    try { fs.writeFileSync(jsonPath, JSON.stringify(item, null, 2)); } catch (e) {}

    // Save ObjectImage
    const objImg = item.PlateImg || item.ObjectImage;
    if (objImg) {
        const imgData = objImg.replace(/^data:image\/jpeg;base64,/, '');
        const imgPath = path.join(channelDir, `${safeBaseName}_plate.jpg`);
        try { fs.writeFileSync(imgPath, Buffer.from(imgData, 'base64')); } catch (e) {}
    }

    // Save Background
    const bgImg = item.BgImg || item.Background;
    if (bgImg) {
        const bgData = bgImg.replace(/^data:image\/jpeg;base64,/, '');
        const bgPath = path.join(channelDir, `${safeBaseName}_background.jpg`);
        try { fs.writeFileSync(bgPath, Buffer.from(bgData, 'base64')); } catch (e) {}
    }
}

async function main() {
    if (!fs.existsSync(CAPTURES_DIR)) {
        fs.mkdirSync(CAPTURES_DIR, { recursive: true });
    }

    const success = await login();
    if (!success) {
        console.error("Exiting due to login failure.");
        process.exit(1);
    }

    keepAlive();

    const progress = loadProgress();
    
    let currentDay = moment(START_DATE);
    if (progress.lastDateProcessed) {
        const lastDate = moment(progress.lastDateProcessed);
        if (lastDate.isValid()) {
            currentDay = lastDate.add(1, 'days');
            console.log(`Found progress. Resuming from ${currentDay.format('YYYY-MM-DD')}`);
        }
    }

    const endDay = moment(END_DATE);

    while (currentDay.isSameOrBefore(endDay)) {
        // Run full day in chunks of 1 hour to avoid overloading NVR search results limit
        for (let h = 0; h < 24; h++) {
            const slotStart = currentDay.clone().hour(h).minute(0).second(0);
            const slotEnd = currentDay.clone().hour(h).minute(59).second(59);
            
            const startStr = slotStart.format('YYYY-MM-DD HH:mm:ss');
            const endStr = slotEnd.format('YYYY-MM-DD HH:mm:ss');
            
            await processSlot(startStr, endStr);
            await sleep(1000); // 1 sec delay between slots
        }

        saveProgress(currentDay.format('YYYY-MM-DD'));
        currentDay.add(1, 'days');
    }

    console.log("🎉 Data collection completed successfully up to", END_DATE);
    process.exit(0);
}

main();
