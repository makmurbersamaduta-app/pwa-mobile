// ===================================================
// patroli.js
// Halaman scan patroli untuk PWA (tabel: security.laporan_patroli).
// Alur: kamera terbuka -> QR terbaca -> data diisi otomatis & disimpan ->
// notifikasi -> kamera siap scan lagi. Jika offline, scan masuk antrean di HP
// dan dikirim otomatis saat ada sinyal.
// ===================================================

// ===================================================
// KELOMPOK 1: PENGATURAN (KONFIGURASI)
// Fungsi: nilai tetap yang dipakai di seluruh file.
// ===================================================
const SESSION_KEY = "pwa_mobile_session";   // sesi login PWA: username, branchId, areaId
// PERLU DICEK: halaman login PWA, dipakai tombol di layar "Sesi tidak ditemukan".
const LOGIN_URL = "index.html";

const SCHEMA_SECURITY = "security";
const TABLE_LAPORAN = "laporan_patroli";
const TABLE_TITIK = "titik_patroli";

const COOLDOWN_MS = 5 * 60 * 1000;          // jeda scan titik yang sama: 5 menit
const RESUME_DELAY_MS = 1800;               // lama notifikasi sebelum kamera siap lagi
const SAME_MSG_SUPPRESS_MS = 4000;          // QR yang sama tidak memunculkan peringatan berulang
const LOCATION_MAX_AGE_MS = 30 * 1000;      // lokasi yang dianggap masih segar
const LOCATION_TIMEOUT_MS = 8000;           // batas waktu menunggu lokasi saat scan
const AUTO_SYNC_MS = 30 * 1000;             // cek antrean tiap 30 detik
const TITIK_CACHE_MAX_AGE_MS = 30 * 60 * 1000;
const SYNC_WAIT_MS = 4000;                  // lama menunggu kirim ke server sebelum notifikasi ditampilkan
const MAX_RETRY = 10;                       // gagal sementara lebih dari ini -> dianggap ditolak
const KEEP_SYNCED = 30;                     // riwayat terkirim yang disimpan di HP
const KEEP_REJECTED = 50;
const MAX_SCAN_FPS = 10;
const FETCH_CHUNK = 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HINT_DEFAULT = "Arahkan kamera ke QR Code titik patroli";

// ===================================================
// KELOMPOK 2: STATE (DATA SEMENTARA DI MEMORI)
// Fungsi: menyimpan kondisi halaman saat ini.
// ===================================================
const state = {
    session: null,          // { username, branchId, areaId }
    queue: [],              // antrean + riwayat scan (disimpan di localStorage)
    lastScan: {},           // id titik -> waktu scan terakhir (ms), untuk jeda 5 menit
    titikMap: new Map(),    // id titik -> data titik (cache dari server, untuk validasi & nama)
    titikLoaded: false,     // true jika daftar titik sudah pernah berhasil diambil
    titikCacheAt: 0,
    lastPos: null,          // { lat, lng, acc, at }
    stream: null,
    detector: null,         // BarcodeDetector bawaan browser (jika ada)
    cameraOn: false,
    raf: null,
    lastFrameAt: 0,
    decoding: false,
    busy: false,            // true saat memproses scan / notifikasi tampil
    sheetOpen: false,
    lastIgnored: { text: "", at: 0 },
    syncing: false,
    authOk: null,           // null = belum dicek, true/false = ada/tidak sesi login Supabase
    refreshingTitik: false
};

// ===================================================
// KELOMPOK 3: FUNGSI BANTU (HELPER)
// ===================================================
const $ = (id) => document.getElementById(id);

function esc(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function newLocalId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "l" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function hasDb() { return !!window.supabaseClient; }

function pad2(n) { return String(n).padStart(2, "0"); }

function formatMmSs(ms) {
    const total = Math.ceil(ms / 1000);
    return `${Math.floor(total / 60)}:${pad2(total % 60)}`;
}

function formatDateTime(iso) {
    const d = new Date(iso);
    return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function loadJson(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch (err) {
        console.error("Gagal membaca penyimpanan:", key, err);
        return fallback;
    }
}

function saveJson(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
    } catch (err) {
        console.error("Gagal menyimpan:", key, err);
        return false;
    }
}

// Kunci penyimpanan dipisah per username, supaya HP yang dipakai bergantian tidak tercampur
function storeKey(name) { return `patroli_${name}_v1_${state.session.username}`; }

// ===================================================
// KELOMPOK 4: SESI LOGIN
// Fungsi: membaca pwa_mobile_session. Dipakai: username (-> petugas),
// branchId (-> branch_id), areaId (-> area_id).
// ===================================================
function readSession() {
    const s = loadJson(SESSION_KEY, null);
    if (!s) return null;
    const username = String(s.username || "").trim();
    const branchId = parseInt(s.branchId, 10);
    const areaId = parseInt(s.areaId, 10);
    if (!username) return null;
    return { username, branchId, areaId };
}

// ===================================================
// KELOMPOK 5: PENYIMPANAN LOKAL (ANTREAN, JEDA SCAN)
// Fungsi: antrean scan dan waktu scan terakhir disimpan di localStorage HP,
// jadi tetap ada saat aplikasi ditutup atau HP restart.
// ===================================================
function saveQueue() { return saveJson(storeKey("queue"), state.queue); }
function saveLastScan() { return saveJson(storeKey("lastscan"), state.lastScan); }

function loadLocalData() {
    state.queue = loadJson(storeKey("queue"), []);
    if (!Array.isArray(state.queue)) state.queue = [];
    const last = loadJson(storeKey("lastscan"), {});
    const now = Date.now();
    state.lastScan = {};
    Object.keys(last).forEach(id => { if (now - last[id] < COOLDOWN_MS) state.lastScan[id] = last[id]; });
    loadTitikCache();
}

// Menyisakan semua yang belum terkirim, ditambah riwayat terbaru saja
function pruneQueue() {
    const byTimeDesc = (a, b) => (a.createdAt < b.createdAt ? 1 : -1);
    const pending = state.queue.filter(q => q.status === "pending");
    const rejected = state.queue.filter(q => q.status === "rejected").sort(byTimeDesc).slice(0, KEEP_REJECTED);
    const synced = state.queue.filter(q => q.status === "synced").sort(byTimeDesc).slice(0, KEEP_SYNCED);
    state.queue = [...pending, ...rejected, ...synced];
}

function pendingItems() {
    return state.queue.filter(q => q.status === "pending")
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

// ===================================================
// KELOMPOK 6: TAMPILAN (NOTIFIKASI, STATUS, LAYAR PESAN, RIWAYAT)
// ===================================================
let toastTimer = null;
function showToast(kind, title, sub, ms) {
    const el = $("toast");
    el.className = "pt-toast" + (kind === "warning" ? " warning" : kind === "error" ? " error" : "");
    $("toastIcon").textContent = kind === "success" ? "✓" : kind === "warning" ? "!" : "×";
    $("toastTitle").textContent = title;
    $("toastSub").textContent = sub || "";
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms || 2200);
    if (navigator.vibrate) navigator.vibrate(kind === "success" ? [120] : [60, 60, 60]);
}

function setHint(text) { $("hint").textContent = text || HINT_DEFAULT; }

function showBlock(title, text, btnText, onClick) {
    $("blockTitle").textContent = title;
    $("blockText").textContent = text;
    const btn = $("blockBtn");
    btn.textContent = btnText || "Coba Lagi";
    btn.onclick = onClick || null;
    btn.hidden = !onClick;
    $("block").hidden = false;
}

function hideBlock() { $("block").hidden = true; }

function statusLine() {
    const n = pendingItems().length;
    if (n === 0) return "Semua scan sudah terkirim.";
    if (!navigator.onLine) return `Offline. ${n} scan menunggu sinyal.`;
    if (state.authOk === false) return `Belum login ke server. ${n} scan belum bisa dikirim. Login ulang saat ada sinyal.`;
    return `${n} scan menunggu dikirim.`;
}

function updateStatusUi() {
    const online = navigator.onLine;
    $("netDot").classList.toggle("off", !online);
    $("netText").textContent = online ? "Online" : "Offline";
    const n = pendingItems().length;
    $("pendingBadge").hidden = n === 0;
    $("pendingBadge").textContent = n;
    if (state.sheetOpen) renderSheet();
}

function itemLabel(item) {
    return item.label || String(item.titikId).slice(0, 8);
}

function renderSheet() {
    $("sheetStatus").textContent = statusLine();
    $("btnSyncNow").disabled = state.syncing || pendingItems().length === 0;
    $("btnSyncNow").textContent = state.syncing ? "Mengirim..." : "Kirim Sekarang";

    const items = [...state.queue].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    if (items.length === 0) {
        $("sheetList").innerHTML = `<div class="pt-empty">Belum ada scan.</div>`;
        return;
    }
    $("sheetList").innerHTML = items.map(it => {
        const stateText = it.status === "synced" ? "Terkirim"
            : it.status === "rejected" ? `Ditolak: ${esc(it.error || "ditolak server")}`
            : (it.error ? `Menunggu (${esc(it.error)})` : "Menunggu dikirim");
        return `
            <div class="pt-item">
                <div class="pt-item-top"><span>${esc(itemLabel(it))}</span><span class="pt-item-time">${esc(formatDateTime(it.createdAt))}</span></div>
                <div class="pt-item-state ${esc(it.status)}">${stateText}</div>
            </div>`;
    }).join("");
}

function openSheet() { state.sheetOpen = true; $("sheet").hidden = false; renderSheet(); }
function closeSheet() { state.sheetOpen = false; $("sheet").hidden = true; }

// ===================================================
// KELOMPOK 7: DAFTAR TITIK (CACHE DI HP)
// Fungsi: mengambil titik patroli aktif milik cabang + area petugas dan
// menyimpannya di HP. Dipakai untuk (1) menolak QR yang bukan titik di area
// ini langsung di HP, tanpa sinyal, dan (2) menampilkan nama titik di
// notifikasi. Diperbarui saat online (maksimal tiap 30 menit).
// ===================================================
function loadTitikCache() {
    const c = loadJson(storeKey("titik"), null);
    if (c && Array.isArray(c.list)) {
        state.titikMap = new Map(c.list.map(t => [String(t.id).toLowerCase(), t]));
        state.titikCacheAt = c.at || 0;
        state.titikLoaded = true;
    }
}

async function getAuthSession() {
    if (!hasDb()) return null;
    try {
        const { data } = await supabaseClient.auth.getSession();
        return data ? data.session : null;
    } catch (err) {
        console.error("Gagal membaca sesi Supabase:", err);
        return null;
    }
}

async function refreshTitikCache(force) {
    if (!hasDb() || !navigator.onLine || state.refreshingTitik) return false;
    if (!force && state.titikLoaded && Date.now() - state.titikCacheAt < TITIK_CACHE_MAX_AGE_MS) return true;
    if (isNaN(state.session.branchId) || isNaN(state.session.areaId)) return false;
    if (!(await getAuthSession())) return false;

    state.refreshingTitik = true;
    try {
        const rows = [];
        for (let from = 0; ; from += FETCH_CHUNK) {
            const { data, error } = await supabaseClient
                .schema(SCHEMA_SECURITY).from(TABLE_TITIK)
                .select("id, kode_titik, titik_patroli, area_id")
                .eq("branch_id", state.session.branchId)
                .eq("area_id", state.session.areaId)
                .or("is_active.is.null,is_active.eq.true")
                .order("id", { ascending: true })
                .range(from, from + FETCH_CHUNK - 1);
            if (error) throw error;
            rows.push(...(data || []));
            if (!data || data.length < FETCH_CHUNK) break;
        }
        state.titikMap = new Map(rows.map(t => [String(t.id).toLowerCase(), t]));
        state.titikLoaded = true;
        state.titikCacheAt = Date.now();
        saveJson(storeKey("titik"), { at: state.titikCacheAt, list: rows });
        return true;
    } catch (err) {
        console.error("Gagal memperbarui daftar titik:", err);
        return false;
    } finally {
        state.refreshingTitik = false;
    }
}

// ===================================================
// KELOMPOK 8: LOKASI (GPS)
// Fungsi: lokasi dipantau terus selama halaman terbuka, sehingga saat scan
// lokasinya sudah siap. Hasilnya ditulis ke kolom titik_map sebagai
// "latitude,longitude" (6 desimal). GPS tetap bekerja tanpa sinyal internet.
// ===================================================
function startLocationWatch() {
    if (!navigator.geolocation) return;
    navigator.geolocation.watchPosition(
        (p) => { state.lastPos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, at: Date.now() }; },
        (err) => { console.warn("Lokasi belum tersedia:", err.message); },
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
    );
}

function getPosition() {
    const p = state.lastPos;
    if (p && Date.now() - p.at <= LOCATION_MAX_AGE_MS) return Promise.resolve(p);
    if (!navigator.geolocation) return Promise.resolve(null);
    return new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
            (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy, at: Date.now() }),
            () => resolve(null),
            { enableHighAccuracy: true, timeout: LOCATION_TIMEOUT_MS, maximumAge: 0 }
        );
    });
}

// ===================================================
// KELOMPOK 9: KAMERA & PEMBACA QR
// Fungsi: membuka kamera belakang dan membaca QR terus-menerus (maksimal
// 10 kali per detik). Memakai BarcodeDetector bawaan browser jika ada
// (Chrome Android), jika tidak memakai jsQR (iPhone dan lainnya).
// Kamera dimatikan saat aplikasi di latar belakang untuk hemat baterai.
// ===================================================
async function initDetector() {
    try {
        if ("BarcodeDetector" in window) {
            const formats = await BarcodeDetector.getSupportedFormats();
            if (formats.includes("qr_code")) state.detector = new BarcodeDetector({ formats: ["qr_code"] });
        }
    } catch (err) {
        console.warn("BarcodeDetector tidak dipakai:", err);
    }
}

async function startCamera() {
    if (state.cameraOn) return;
    hideBlock();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showBlock("Kamera tidak tersedia",
            "Browser tidak mendukung kamera, atau halaman tidak dibuka lewat HTTPS. Buka aplikasi lewat alamat HTTPS.", "Coba Lagi", startCamera);
        return;
    }
    try {
        state.stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false
        });
        const video = $("cam");
        video.srcObject = state.stream;
        await video.play();
        state.cameraOn = true;
        state.raf = requestAnimationFrame(tick);
    } catch (err) {
        console.error("Kamera gagal dibuka:", err);
        const msg = err && err.name === "NotAllowedError"
            ? "Izin kamera ditolak. Aktifkan izin kamera untuk aplikasi ini di pengaturan HP, lalu tekan Coba Lagi."
            : err && err.name === "NotFoundError"
            ? "Kamera tidak ditemukan di perangkat ini."
            : `Kamera tidak bisa dibuka: ${err && err.message ? err.message : "kesalahan tidak dikenal"}`;
        showBlock("Kamera tidak bisa dibuka", msg, "Coba Lagi", startCamera);
    }
}

function stopCamera() {
    state.cameraOn = false;
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = null;
    if (state.stream) state.stream.getTracks().forEach(t => t.stop());
    state.stream = null;
    $("cam").srcObject = null;
}

function tick(ts) {
    if (!state.cameraOn) return;
    state.raf = requestAnimationFrame(tick);
    if (state.busy || state.sheetOpen || state.decoding) return;
    if (ts - state.lastFrameAt < 1000 / MAX_SCAN_FPS) return;
    state.lastFrameAt = ts;
    if ($("cam").readyState < 2) return;

    state.decoding = true;
    decodeFrame()
        .then(text => { if (text) handleScan(text); })
        .catch(err => console.warn("Gagal membaca frame:", err))
        .finally(() => { state.decoding = false; });
}

async function decodeFrame() {
    const video = $("cam");
    if (state.detector) {
        const codes = await state.detector.detect(video);
        return codes.length ? codes[0].rawValue : null;
    }
    if (typeof jsQR === "undefined") return null;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const scale = Math.min(1, 640 / Math.max(vw, vh));
    const w = Math.round(vw * scale), h = Math.round(vh * scale);
    const canvas = $("frameCanvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const code = jsQR(img.data, w, h, { inversionAttempts: "dontInvert" });
    return code ? code.data : null;
}

// ===================================================
// KELOMPOK 10: PROSES SCAN
// Fungsi: dijalankan setiap kali QR terbaca:
//   1. QR harus berupa id titik (uuid), dan (jika daftar titik ada) harus titik
//      di area petugas. 2. Titik yang sama tidak bisa discan lagi selama 5 menit.
//   3. Lokasi diambil. 4. Data disimpan ke antrean HP (autosave), lalu langsung
//      dikirim ke server jika online. 5. Notifikasi, lalu kamera siap lagi.
// Data yang disimpan: branch_id, area_id (dari sesi), titik_patroli_id (isi QR),
// titik_map (lokasi), petugas (username sesi), created_at (waktu scan di HP).
// ===================================================
async function handleScan(rawText) {
    if (state.busy) return;
    const text = String(rawText || "").trim();
    const now = Date.now();
    if (state.lastIgnored.text === text && now - state.lastIgnored.at < SAME_MSG_SUPPRESS_MS) return;

    const ignore = (kind, title, sub) => {
        state.lastIgnored = { text, at: Date.now() };
        showToast(kind, title, sub, 2400);
    };

    if (!UUID_RE.test(text)) { ignore("error", "QR tidak dikenal", "Ini bukan QR Code titik patroli."); return; }
    if (isNaN(state.session.branchId) || isNaN(state.session.areaId)) {
        ignore("error", "Akun belum siap", "Cabang atau area patroli akun Anda belum diatur. Hubungi admin."); return;
    }

    const titikId = text.toLowerCase();
    state.busy = true;
    let resumeDelay = 0;

    try {
        // 1. Validasi titik terhadap daftar titik di HP
        let titik = state.titikMap.get(titikId);
        if (!titik && state.titikLoaded && navigator.onLine) {
            await refreshTitikCache(true);              // mungkin titik baru ditambahkan
            titik = state.titikMap.get(titikId);
        }
        if (state.titikLoaded && !titik) {
            ignore("error", "Titik tidak terdaftar",
                state.titikMap.size === 0
                    ? "Daftar titik untuk area Anda kosong atau tidak bisa dibaca. Hubungi admin."
                    : "Titik ini bukan titik patroli di area Anda.");
            return;
        }
        const label = titik ? (titik.titik_patroli || titik.kode_titik) : "Titik patroli";

        // 2. Jeda 5 menit untuk titik yang sama
        const last = state.lastScan[titikId];
        if (last && now - last < COOLDOWN_MS) {
            ignore("warning", `${label} sudah discan`, `Bisa discan lagi dalam ${formatMmSs(COOLDOWN_MS - (now - last))}.`);
            return;
        }

        // 3. Lokasi
        setHint("Mengambil lokasi...");
        const pos = await getPosition();
        const titikMap = pos ? `${pos.lat.toFixed(6)},${pos.lng.toFixed(6)}` : null;

        // 4. Simpan ke antrean HP (autosave)
        const item = {
            localId: newLocalId(),
            titikId,
            label,
            branchId: state.session.branchId,
            areaId: state.session.areaId,
            titikMap,
            petugas: state.session.username,
            createdAt: new Date().toISOString(),
            status: "pending",
            attempts: 0,
            inflight: false,
            error: null
        };
        state.queue.push(item);
        state.lastScan[titikId] = now;
        if (!saveQueue()) {
            state.queue.pop();
            delete state.lastScan[titikId];
            ignore("error", "Gagal menyimpan", "Penyimpanan HP penuh atau tidak bisa diakses. Scan tidak tersimpan.");
            return;
        }
        saveLastScan();
        updateStatusUi();

        // 5. Kirim sekarang jika online (menunggu paling lama beberapa detik), lalu notifikasi
        if (navigator.onLine) {
            await Promise.race([syncQueue(), new Promise(r => setTimeout(r, SYNC_WAIT_MS))]);
        }
        const warnLoc = pos ? "" : " Lokasi tidak terbaca.";
        if (item.status === "synced") {
            showToast(pos ? "success" : "warning", "Scan berhasil", `${label}${warnLoc}`);
        } else if (item.status === "rejected") {
            delete state.lastScan[titikId];             // scan ditolak: boleh dicoba lagi
            saveLastScan();
            showToast("error", "Scan ditolak server", item.error || "Hubungi admin.", 3500);
        } else {
            showToast("warning", "Scan tersimpan", `${label}. Akan dikirim saat ada sinyal.${warnLoc}`);
        }
        state.lastIgnored = { text, at: Date.now() + RESUME_DELAY_MS };
        resumeDelay = RESUME_DELAY_MS;
    } catch (err) {
        console.error("Gagal memproses scan:", err);
        showToast("error", "Terjadi kesalahan", err && err.message ? err.message : "Coba scan lagi.", 3000);
        resumeDelay = RESUME_DELAY_MS;
    } finally {
        setTimeout(() => { state.busy = false; setHint(); }, resumeDelay);
    }
}

// ===================================================
// KELOMPOK 11: KIRIM KE SERVER (SINKRONISASI)
// Fungsi: mengirim antrean ke security.laporan_patroli, satu per satu dari yang
// paling lama. Hasil tiap kiriman:
//   - berhasil / data kembar -> ditandai terkirim,
//   - ditolak server (hak akses, data tidak valid) -> ditandai ditolak, tidak diulang,
//   - tidak ada sinyal / gangguan sementara / sesi login server berakhir ->
//     tetap menunggu dan dicoba lagi nanti.
// Jika kiriman pernah terputus di tengah jalan, sebelum dikirim ulang dicek
// dulu apakah datanya sudah masuk, supaya tidak terjadi data ganda.
// ===================================================
function classifyError(error) {
    const code = String(error.code || "");
    const msg = String(error.message || "");
    if (code === "23505") return { kind: "dup" };
    if (!code && /fetch|network|load failed|failed to|timeout|abort/i.test(msg)) return { kind: "network" };
    if (code === "PGRST301" || /jwt/i.test(msg)) return { kind: "auth" };
    if (code === "42501") {
        return { kind: "rejected", message: "Hak akses ditolak (akun, cabang, area, atau titik tidak cocok dengan data server)." };
    }
    if (/^(22|23|42)/.test(code)) return { kind: "rejected", message: msg };
    return { kind: "retry", message: msg };
}

async function existsOnServer(item) {
    const { data, error } = await supabaseClient
        .schema(SCHEMA_SECURITY).from(TABLE_LAPORAN)
        .select("id")
        .eq("petugas", item.petugas)
        .eq("titik_patroli_id", item.titikId)
        .eq("created_at", item.createdAt)
        .limit(1);
    if (error) throw error;
    return (data || []).length > 0;
}

async function sendItem(item) {
    try {
        if (item.inflight && await existsOnServer(item)) return { kind: "ok" };

        item.inflight = true;
        item.attempts += 1;
        saveQueue();

        const { error } = await supabaseClient
            .schema(SCHEMA_SECURITY).from(TABLE_LAPORAN)
            .insert({
                branch_id: item.branchId,
                area_id: item.areaId,
                titik_patroli_id: item.titikId,
                titik_map: item.titikMap,
                petugas: item.petugas,
                created_at: item.createdAt
            });
        if (!error) return { kind: "ok" };
        return classifyError(error);
    } catch (err) {
        return classifyError(err && typeof err === "object" ? err : { message: String(err) });
    }
}

async function syncQueue() {
    if (state.syncing || !hasDb()) return;
    const pending = pendingItems();
    if (pending.length === 0) { updateStatusUi(); return; }

    state.syncing = true;
    updateStatusUi();
    try {
        if (!(await getAuthSession())) { state.authOk = false; return; }
        state.authOk = true;

        for (const item of pending) {
            const r = await sendItem(item);
            if (r.kind === "ok" || r.kind === "dup") {
                item.status = "synced";
                item.inflight = false;
                item.error = null;
            } else if (r.kind === "rejected") {
                item.status = "rejected";
                item.inflight = false;
                item.error = r.message;
            } else {
                // network / auth / retry: berhenti, urutan antrean dijaga
                if (r.kind === "retry" && item.attempts >= MAX_RETRY) {
                    item.status = "rejected";
                    item.inflight = false;
                    item.error = `Gagal berulang: ${r.message}`;
                } else {
                    item.error = r.kind === "network" ? null : (r.kind === "auth" ? "sesi login server berakhir" : r.message);
                }
                saveQueue();
                break;
            }
            saveQueue();
        }
    } catch (err) {
        console.error("Sinkronisasi gagal:", err);
    } finally {
        state.syncing = false;
        pruneQueue();
        saveQueue();
        updateStatusUi();
    }
}

// ===================================================
// KELOMPOK 12: INISIALISASI
// Fungsi: dijalankan saat halaman dibuka: cek sesi, muat data lokal,
// nyalakan kamera dan GPS, kirim antrean yang tertunda, lalu pasang
// pemicu kirim otomatis (kembali online, aplikasi dibuka lagi, tiap 30 detik).
// ===================================================
document.addEventListener("DOMContentLoaded", async () => {
    state.session = readSession();
    if (!state.session) {
        showBlock("Sesi tidak ditemukan", "Silakan login terlebih dahulu.", "Ke Halaman Login",
            () => { window.location.href = LOGIN_URL; });
        return;
    }
    $("userLabel").textContent = state.session.username;

    loadLocalData();
    updateStatusUi();

    $("btnStatus").addEventListener("click", openSheet);
    $("btnSheetClose").addEventListener("click", closeSheet);
    $("sheet").addEventListener("click", (e) => { if (e.target === $("sheet")) closeSheet(); });
    $("btnSyncNow").addEventListener("click", () => { refreshTitikCache(false); syncQueue(); });

    window.addEventListener("online", () => { updateStatusUi(); syncQueue(); refreshTitikCache(false); });
    window.addEventListener("offline", updateStatusUi);

    // Kamera dimatikan saat aplikasi ke latar belakang, dinyalakan lagi saat kembali
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            stopCamera();
        } else {
            if (!$("block").hidden && $("blockTitle").textContent === "Sesi tidak ditemukan") return;
            startCamera();
            syncQueue();
        }
    });

    setInterval(() => {
        if (navigator.onLine && pendingItems().length > 0) syncQueue();
        if (navigator.onLine) refreshTitikCache(false);
    }, AUTO_SYNC_MS);

    await initDetector();
    startLocationWatch();
    startCamera();
    refreshTitikCache(false).then(() => syncQueue());
});