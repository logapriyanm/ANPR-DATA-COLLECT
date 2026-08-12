const axios = require('axios');
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const DigestFetch = require('digest-fetch');

// --- CONFIGURATION ---
const NVR_IP = process.env.NVR_IP || "112.133.197.154";
const NVR_USER = process.env.NVR_USER || "admin";
const NVR_PASS = process.env.NVR_PASS || "admin";

// Target Date & Hour Configuration (Default: 2026-08-11 starting after 14:59:59 -> 15:00:00)
const START_DATE = process.env.START_DATE || "2026-08-11";
const START_HOUR = process.env.START_HOUR ? parseInt(process.env.START_HOUR, 10) : 15; // Default hour 15
const END_DATE = process.env.END_DATE || moment().format('YYYY-MM-DD');
const TARGET_CHANNELS = [0, 1, 2, 3, 4, 5, 6, 7];

const BASE_URL = `http://${NVR_IP}`;
const OUTPUT_DIR = path.join(__dirname, 'NVR154DATAS');
const PROGRESS_FILE = path.join(__dirname, 'progress_154.json');

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
    console.log(`🔐 Logging in to NVR at ${BASE_URL} (User: ${NVR_USER})...`);
    const client = new DigestFetch(NVR_USER, NVR_PASS, { algorithm: 'MD5' });

    try {
        await axios.post(stamped(`${BASE_URL}/API/Login/Range`), {}, { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }).catch(() => {});
        await axios.post(stamped(`${BASE_URL}/API/AccountRules/Get`), {}, { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }).catch(() => {});

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

function keepAlive() {
    setInterval(async () => {
        if (!sessionCookie) return;
        try {
            await axios.post(stamped(`${BASE_URL}/API/Login/Heartbeat`), { version: '1.0', data: { keep_alive: true } }, { headers: hdrs() });
        } catch (err) {
            console.warn(`⚠️ Heartbeat failed`);
        }
    }, 15000);
}

function loadProgress() {
    if (fs.existsSync(PROGRESS_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
        } catch (e) {}
    }
    return { lastDateProcessed: null, lastHourProcessed: null };
}

function saveProgress(dateStr, hour) {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ lastDateProcessed: dateStr, lastHourProcessed: hour }, null, 2));
}

function savePlateImageOnly(item) {
    const snapId = item.SnapId !== undefined && item.SnapId !== null ? String(item.SnapId) : (item.UUId || 'NOID');
    let plateText = item.Plate || 'unknown';
    
    const timestamp = item.StartTime ? item.StartTime * 1000 : Date.now();
    const safeBaseName = `${snapId}_${plateText}_${timestamp}`.replace(/[^a-zA-Z0-9_\-]/g, '_');

    const channelLabel = item.StrChn || item.Chn || 'UNKNOWN_CH';
    const channelDir = path.join(OUTPUT_DIR, String(channelLabel));
    
    if (!fs.existsSync(channelDir)) {
        fs.mkdirSync(channelDir, { recursive: true });
    }

    // Save ONLY Plate Image (ObjectImage / PlateImg)
    const objImg = item.PlateImg || item.ObjectImage;
    if (objImg) {
        const imgData = objImg.replace(/^data:image\/jpeg;base64,/, '');
        const imgPath = path.join(channelDir, `${safeBaseName}_plate.jpg`);
        try { 
            fs.writeFileSync(imgPath, Buffer.from(imgData, 'base64')); 
        } catch (e) {
            console.error(`Error saving image ${imgPath}:`, e.message);
        }
    }
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
            return 0;
        }

        total = searchRes.data?.data?.Count || 0;
        console.log(`Found ${total} captures in slot.`);
    } catch (err) {
        console.error(`❌ SearchPlate error:`, err.message);
        return 0;
    }

    if (total === 0) return 0;

    let fetched = 0;
    const batchSize = 10;
    let batchNumber = 0;
    let retryCount = 0;

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
                    WithBackgroud: 0 // Only object image, omit background
                }
            }, { headers: hdrs(), timeout: 20000 });

            const batch = getRes.data?.data?.SnapedObjInfo || [];
            if (batch.length === 0) {
                console.warn("⚠️ API returned 0 results for batch, breaking to avoid infinite loop.");
                break;
            }
            
            for (const item of batch) {
                savePlateImageOnly(item);
            }
            
            fetched += batch.length;
            retryCount = 0; // Reset retry counter on success
            await sleep(1000);
        } catch (err) {
            retryCount++;
            console.error(`❌ GetByIndex error (attempt ${retryCount}/5):`, err.message);
            
            // Re-authenticate if error occurs (ECONNRESET, 400 Bad Request, session timeout, etc.)
            console.log("🔄 Refreshing session & re-logging in...");
            await sleep(2000);
            await login();

            if (retryCount >= 5) {
                console.warn(`⚠️ Max retries reached for startIndex ${fetched}. Skipping batch to prevent infinite loop.`);
                fetched += countToFetch;
                retryCount = 0;
            } else {
                console.log(`Retrying batch in 3 seconds...`);
                await sleep(3000);
            }
        }
    }
    return fetched;
}

async function main() {
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    const progress = loadProgress();
    let currentDay = moment(START_DATE);
    const endDay = moment(END_DATE);
    let totalSaved = 0;

    console.log(`🚀 ANPR Plate Data Harvester starting for NVR IP: ${NVR_IP}`);
    console.log(`📁 Saving plate images to: ${OUTPUT_DIR}`);
    console.log(`📅 Date Range: ${START_DATE} to ${END_DATE}`);

    const success = await login();
    if (!success) {
        console.error("Exiting due to login failure.");
        process.exit(1);
    }

    keepAlive();

    while (currentDay.isSameOrBefore(endDay)) {
        const isStartDay = currentDay.isSame(moment(START_DATE), 'day');
        let startH = isStartDay ? START_HOUR : 0;

        if (progress.lastDateProcessed && currentDay.isSame(moment(progress.lastDateProcessed), 'day')) {
            if (progress.lastHourProcessed !== null && progress.lastHourProcessed !== undefined) {
                startH = Math.max(startH, progress.lastHourProcessed + 1);
            }
        } else if (progress.lastDateProcessed && currentDay.isBefore(moment(progress.lastDateProcessed), 'day')) {
            currentDay.add(1, 'days');
            continue;
        }

        console.log(`\n========================================`);
        console.log(`📅 Processing Date: ${currentDay.format('YYYY-MM-DD')} (Starting Hour: ${startH}:00:00)`);
        console.log(`========================================`);

        for (let h = startH; h < 24; h++) {
            const slotStart = currentDay.clone().hour(h).minute(0).second(0);
            const slotEnd = currentDay.clone().hour(h).minute(59).second(59);
            
            const startStr = slotStart.format('YYYY-MM-DD HH:mm:ss');
            const endStr = slotEnd.format('YYYY-MM-DD HH:mm:ss');
            
            const count = await processSlot(startStr, endStr);
            totalSaved += count;
            saveProgress(currentDay.format('YYYY-MM-DD'), h);
            await sleep(500);
        }

        currentDay.add(1, 'days');
    }

    console.log(`\n🎉 Data collection completed successfully up to ${END_DATE}`);
    console.log(`📸 Total plate images processed/saved: ${totalSaved}`);
    process.exit(0);
}

main();
