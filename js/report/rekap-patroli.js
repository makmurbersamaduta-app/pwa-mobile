// ===================================================
// pwa_laporan_patroli.js
// Halaman "Laporan Patroli" untuk PWA (sumber: security.laporan_patroli).
// Data tampil sebagai card, terbaru di atas, maksimal 10 hari terakhir.
// Cakupan data mengikuti jabatan di sesi login:
//   - Anggota Security (11) : hanya patroli miliknya sendiri, di areanya
//   - DANRU (10)            : rekap patroli DANRU dan anggota security, di areanya
//   - Supervisor (5)        : semua rekap patroli di areanya
//   - Jabatan lain          : semua data, dikelompokkan per area (bisa dilipat)
// ===================================================

// ===================================================
// KELOMPOK 1: PENGATURAN (KONFIGURASI)
// Fungsi: nilai tetap yang dipakai di seluruh file.
// ===================================================
const APP_VERSION = "2026-10-22 a";
const supabaseClient = window.supabaseClient;

const SESSION_KEY = "pwa_mobile_session";     // sesi login PWA: username, fullName, branchId, areaId, jabatanId

const SCHEMA_SECURITY = "security";
const SCHEMA_HRD = "hrd";
const TABLE_LAPORAN = "laporan_patroli";
const TABLE_TITIK = "titik_patroli";
const TABLE_AREA = "areas";                   // schema public: kolom id, area_name
const TABLE_EMPLOYEES = "employees";          // hrd.employees: nik_karyawan, nama

// ID jabatan
const JABATAN = { ANGGOTA: 11, DANRU: 10, SUPERVISOR: 5 };

// Pembeda tampilan DANRU dan Supervisor.
// DANRU melihat patroli DANRU + anggota security saja (jabatan 10 dan 11).
// Untuk itu perlu tahu jabatan tiap petugas. Isi dengan NAMA KOLOM jabatan di tabel
// hrd.employees (misalnya "jabatan_id") agar filter aktif. Selama masih null, tampilan
// DANRU sama dengan Supervisor (semua patroli di area).
// Cara mengetahui nama kolomnya: jalankan di Supabase SQL Editor
//   select column_name from information_schema.columns
//   where table_schema = 'hrd' and table_name = 'employees';
const EMPLOYEE_JABATAN_COLUMN = null;
const DANRU_VIEW_JABATAN = [JABATAN.DANRU, JABATAN.ANGGOTA];

const DAYS_BACK = 10;                         // data yang tampil: hari ini dan 10 hari ke belakang
const PAGE_SIZE = 50;                         // jumlah card per muat (daftar biasa)
const PAGE_SIZE_GROUPED = 200;                // jumlah per muat untuk tampilan per area
const FETCH_CHUNK = 1000;                     // batas ambil data Supabase
const LOOKUP_CHUNK = 80;                      // jumlah id per pencarian nama titik / petugas
const STALE_MS = 2 * 60 * 1000;               // data dianggap lama setelah 2 menit (dimuat ulang saat aplikasi dibuka lagi)

// Zona waktu tetap per cabang: jam tampil sesuai cabang datanya, di mana pun dibuka
const BRANCH_TZ = {
    1: { zone: "Asia/Jakarta",  offset: "+07:00" },   // Surabaya (WIB)
    2: { zone: "Asia/Makassar", offset: "+08:00" }    // Makassar (WITA)
};
const DEFAULT_BRANCH = 2;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

// ===================================================
// KELOMPOK 2: STATE (DATA SEMENTARA DI MEMORI)
// ===================================================
const state = {
    session: null,          // { username, fullName, branchId, areaId, jabatanId }
    scope: null,            // hasil resolveScope(): aturan data yang boleh dilihat
    rows: [],               // baris yang sudah dimuat dan lolos saringan (terbaru di atas)
    seen: new Set(),        // id baris yang sudah dimuat (mencegah card ganda)
    offset: 0,              // jumlah baris mentah yang sudah diambil dari server
    total: 0,               // jumlah seluruh baris sesuai syarat di server
    loading: false,
    error: "",              // pesan gagal muat terakhir
    reqId: 0,
    loadedAt: 0,
    titikMap: new Map(),    // id titik -> { titik_patroli, kode_titik }
    areaMap: new Map(),     // id area -> area_name
    areasLoaded: false,
    nameMap: new Map(),     // nik -> { nama, jabatan }
    collapsed: new Set()    // id area yang sedang dilipat (tampilan per area)
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

function hasDb() { return !!window.supabaseClient; }

function branchTz(branchId) {
    return BRANCH_TZ[branchId] || BRANCH_TZ[state.session && BRANCH_TZ[state.session.branchId] ? state.session.branchId : DEFAULT_BRANCH];
}

// Format tampilan waktu: "22 Okt 26 | 14:05" (zona waktu cabang pemilik data)
function formatStamp(iso, branchId) {
    if (!iso) return "";
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: branchTz(branchId).zone,
        year: "numeric", month: "numeric", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(new Date(iso));
    const p = {};
    parts.forEach(x => { p[x.type] = x.value; });
    const yy = String(p.year).slice(-2);
    return `${p.day} ${MONTHS[parseInt(p.month, 10) - 1]} ${yy} | ${p.hour}:${p.minute}`;
}

// Batas awal data: pukul 00.00 pada hari (hari ini - 10 hari), menurut zona waktu cabang petugas
function cutoffIso() {
    const tz = branchTz(state.session.branchId);
    const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: tz.zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const d = new Date(`${ymd}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - DAYS_BACK);
    return new Date(`${d.toISOString().slice(0, 10)}T00:00:00.000${tz.offset}`).toISOString();
}

function areaLabel(id) {
    if (id === null || id === undefined || id === "" || id === "none") return "Tanpa area";
    return state.areaMap.get(String(id)) || `Area ${id}`;
}

let errTimer = null;
// Pesan kesalahan kecil di layar, supaya masalah terlihat tanpa perlu membuka Console
function showErrorBar(message) {
    const el = $("errBar");
    if (!el) return;
    el.textContent = `${message} (ketuk untuk menutup)`;
    el.hidden = false;
    el.onclick = () => { el.hidden = true; };
    clearTimeout(errTimer);
    errTimer = setTimeout(() => { el.hidden = true; }, 12000);
}
window.addEventListener("error", (e) => {
    if (/ResizeObserver/i.test(e.message || "")) return;
    showErrorBar(`Error: ${e.message || "tidak diketahui"}${e.lineno ? ` (baris ${e.lineno})` : ""}`);
});
window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    showErrorBar(`Error: ${r && r.message ? r.message : String(r)}`);
});

// ===================================================
// KELOMPOK 4: SESI LOGIN
// Fungsi: membaca pwa_mobile_session (localStorage lalu sessionStorage).
// Dipakai: username (NIK), fullName, branchId, areaId, jabatanId.
// Jika gagal dibaca, alasannya disimpan di sessionProblem dan ditampilkan di layar.
// ===================================================
let sessionProblem = "";

function readSession() {
    sessionProblem = "";
    let raw = null, where = "";
    for (const name of ["localStorage", "sessionStorage"]) {
        try {
            const v = window[name].getItem(SESSION_KEY);
            if (v) { raw = v; where = name; break; }
        } catch (err) {
            console.warn("Tidak bisa membaca", name, err);
        }
    }
    if (!raw) {
        sessionProblem = `Kunci "${SESSION_KEY}" tidak ada di localStorage maupun sessionStorage pada alamat ${window.location.origin}.`;
        return null;
    }
    let s;
    try {
        s = JSON.parse(raw);
    } catch (err) {
        sessionProblem = `Isi "${SESSION_KEY}" di ${where} bukan JSON yang valid.`;
        return null;
    }
    const username = String((s && s.username) || "").trim();
    if (!username) {
        sessionProblem = `Field "username" tidak ada di sesi. Field yang ada: ${s && typeof s === "object" ? Object.keys(s).join(", ") : "(bukan objek)"}.`;
        return null;
    }
    const jabatanRaw = s.jabatanId ?? s.jabatanID ?? s.jabatan_id;
    return {
        username,
        fullName: String(s.fullName || "").trim(),
        branchId: parseInt(s.branchId, 10),
        areaId: parseInt(s.areaId, 10),
        jabatanId: parseInt(jabatanRaw, 10),
        _keys: Object.keys(s).join(", ")
    };
}

// ===================================================
// KELOMPOK 5: ATURAN DATA PER JABATAN
// Fungsi: menentukan data apa yang boleh tampil berdasarkan jabatanId.
//   mode        : anggota | danru | supervisor | all
//   areaId      : jika terisi, hanya data area ini
//   petugas     : jika terisi, hanya data petugas (NIK) ini
//   showPetugas : card menampilkan nama petugas (tidak untuk Anggota Security)
//   group       : dikelompokkan per area dengan sub header yang bisa dilipat
// Jika jabatan atau area akun tidak terbaca, halaman DIKUNCI (tidak menampilkan
// data) agar tidak sampai memperlihatkan data yang bukan hak pengguna.
// ===================================================
function resolveScope(session) {
    const j = session.jabatanId;
    if (isNaN(j)) {
        return { error: `Jabatan akun tidak terbaca di sesi login (field jabatanId). Field yang ada: ${session._keys}.` };
    }
    const needsArea = [JABATAN.ANGGOTA, JABATAN.DANRU, JABATAN.SUPERVISOR].includes(j);
    if (needsArea && isNaN(session.areaId)) {
        return { error: "Area patroli akun Anda belum diatur (areaId kosong). Hubungi admin." };
    }
    if (j === JABATAN.ANGGOTA) {
        return { mode: "anggota", areaId: session.areaId, petugas: session.username, showPetugas: false, group: false, label: "Data patroli saya" };
    }
    if (j === JABATAN.DANRU) {
        return { mode: "danru", areaId: session.areaId, petugas: null, showPetugas: true, group: false, label: "Rekap DANRU & anggota" };
    }
    if (j === JABATAN.SUPERVISOR) {
        return { mode: "supervisor", areaId: session.areaId, petugas: null, showPetugas: true, group: false, label: "Rekap semua patroli area" };
    }
    return { mode: "all", areaId: null, petugas: null, showPetugas: true, group: true, label: "Semua area" };
}

// ===================================================
// KELOMPOK 6: MEMUAT DATA
// Fungsi: mengambil data laporan per halaman dari server, urut created_at
// terbaru di atas, hanya 10 hari terakhir dan sesuai aturan jabatan.
// Lalu mencari nama titik patroli dan nama petugas untuk kartu.
// ===================================================
async function ensureAuth() {
    if (!hasDb()) throw new Error("Library Supabase tidak termuat. Periksa path supabase.js.");
    const { data } = await supabaseClient.auth.getSession();
    if (!data || !data.session) {
        throw new Error("Belum login ke server. Login ulang saat ada sinyal.");
    }
}

async function ensureAreas() {
    if (state.areasLoaded) return;
    try {
        const rows = [];
        for (let from = 0; ; from += FETCH_CHUNK) {
            const { data, error } = await supabaseClient.from(TABLE_AREA).select("id, area_name").range(from, from + FETCH_CHUNK - 1);
            if (error) throw error;
            rows.push(...(data || []));
            if (!data || data.length < FETCH_CHUNK) break;
        }
        state.areaMap = new Map(rows.map(a => [String(a.id), a.area_name]));
        state.areasLoaded = true;
    } catch (err) {
        console.warn("Nama area tidak bisa dimuat (nama tampil sebagai 'Area <id>'):", err);
    }
}

async function lookupTitik(ids) {
    const need = [...new Set(ids.filter(id => id && !state.titikMap.has(id)))];
    for (let i = 0; i < need.length; i += LOOKUP_CHUNK) {
        const chunk = need.slice(i, i + LOOKUP_CHUNK);
        const { data, error } = await supabaseClient
            .schema(SCHEMA_SECURITY).from(TABLE_TITIK)
            .select("id, titik_patroli, kode_titik")
            .in("id", chunk);
        if (error) throw error;
        (data || []).forEach(t => state.titikMap.set(t.id, t));
        chunk.forEach(id => { if (!state.titikMap.has(id)) state.titikMap.set(id, null); });
    }
}

async function lookupPetugas(niks) {
    const need = [...new Set(niks.filter(n => n && !state.nameMap.has(String(n))).map(String))];
    const columns = "nik_karyawan, nama" + (EMPLOYEE_JABATAN_COLUMN ? `, ${EMPLOYEE_JABATAN_COLUMN}` : "");
    for (let i = 0; i < need.length; i += LOOKUP_CHUNK) {
        const chunk = need.slice(i, i + LOOKUP_CHUNK);
        const { data, error } = await supabaseClient
            .schema(SCHEMA_HRD).from(TABLE_EMPLOYEES)
            .select(columns)
            .in("nik_karyawan", chunk);
        if (error) throw error;
        (data || []).forEach(e => state.nameMap.set(String(e.nik_karyawan), {
            nama: e.nama,
            jabatan: EMPLOYEE_JABATAN_COLUMN ? e[EMPLOYEE_JABATAN_COLUMN] : null
        }));
        chunk.forEach(n => { if (!state.nameMap.has(n)) state.nameMap.set(n, null); });
    }
}

async function loadPage(reset) {
    if (!state.scope || state.scope.error) return;
    if (state.loading) return;
    state.loading = true;
    const myReq = ++state.reqId;

    if (reset) {
        state.rows = [];
        state.seen = new Set();
        state.offset = 0;
        state.total = 0;
    }
    state.error = "";
    render();

    try {
        await ensureAuth();
        await ensureAreas();

        const scope = state.scope;
        const size = scope.group ? PAGE_SIZE_GROUPED : PAGE_SIZE;
        let q = supabaseClient
            .schema(SCHEMA_SECURITY).from(TABLE_LAPORAN)
            .select("id, created_at, branch_id, area_id, titik_patroli_id, petugas", { count: "exact" })
            .gte("created_at", cutoffIso());
        if (scope.areaId !== null && scope.areaId !== undefined) q = q.eq("area_id", scope.areaId);
        if (scope.petugas) q = q.eq("petugas", scope.petugas);
        q = q.order("created_at", { ascending: false })
             .order("id", { ascending: false })
             .range(state.offset, state.offset + size - 1);

        const { data, error, count } = await q;
        if (error) throw error;
        if (myReq !== state.reqId) return;

        const raw = data || [];
        await lookupTitik(raw.map(r => r.titik_patroli_id));
        const needNames = scope.showPetugas || (scope.mode === "danru" && EMPLOYEE_JABATAN_COLUMN);
        if (needNames) await lookupPetugas(raw.map(r => r.petugas));
        if (myReq !== state.reqId) return;

        // DANRU: hanya patroli DANRU dan anggota security (jika kolom jabatan sudah diatur)
        let accepted = raw;
        if (scope.mode === "danru" && EMPLOYEE_JABATAN_COLUMN) {
            accepted = raw.filter(r => {
                const info = state.nameMap.get(String(r.petugas));
                return info && DANRU_VIEW_JABATAN.includes(parseInt(info.jabatan, 10));
            });
        }

        accepted.forEach(r => {
            if (!state.seen.has(r.id)) { state.seen.add(r.id); state.rows.push(r); }
        });
        state.offset += raw.length;
        state.total = count || 0;
        state.loadedAt = Date.now();
    } catch (err) {
        if (myReq !== state.reqId) return;
        console.error("Gagal memuat laporan patroli:", err);
        state.error = err && err.message ? err.message : "Gagal memuat data.";
    } finally {
        if (myReq === state.reqId) {
            state.loading = false;
            render();
        }
    }
}

// ===================================================
// KELOMPOK 7: TAMPILAN CARD
// Fungsi: membuat card (titik patroli tebal, waktu "dd mmm yy | hh:mm", dan
// kartu nama petugas di sisi kanan jika bukan Anggota Security). Untuk
// jabatan di luar Anggota/DANRU/Supervisor, card dikelompokkan per area
// dengan sub header yang bisa dilipat.
// ===================================================
function cardHtml(row) {
    const t = state.titikMap.get(row.titik_patroli_id);
    const titikName = t ? (t.titik_patroli || t.kode_titik) : "Titik tidak dikenal";
    let side = "";
    if (state.scope.showPetugas) {
        const info = state.nameMap.get(String(row.petugas));
        side = `<div class="lr-card-side">${esc((info && info.nama) || row.petugas || "-")}</div>`;
    }
    return `
        <div class="lr-card">
            <div class="lr-card-main">
                <div class="lr-card-title">${esc(titikName)}</div>
                <div class="lr-card-time">${esc(formatStamp(row.created_at, row.branch_id))}</div>
            </div>
            ${side}
        </div>`;
}

function groupedHtml(rows) {
    const groups = new Map();
    rows.forEach(r => {
        const k = (r.area_id === null || r.area_id === undefined) ? "none" : String(r.area_id);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
    });
    const keys = [...groups.keys()].sort((a, b) => areaLabel(a).localeCompare(areaLabel(b), "id", { numeric: true }));
    return keys.map(k => `
        <details class="lr-group" data-area="${esc(k)}" ${state.collapsed.has(k) ? "" : "open"}>
            <summary>
                <span>${esc(areaLabel(k))}</span>
                <span class="lr-group-right"><span class="lr-group-count">${groups.get(k).length}</span></span>
            </summary>
            ${groups.get(k).map(cardHtml).join("")}
        </details>`).join("");
}

function render() {
    const list = $("list");
    const footer = $("footer");
    const rows = state.rows;

    if (state.loading && rows.length === 0) {
        list.innerHTML = `<div class="lr-state">Memuat data...</div>`;
        footer.innerHTML = "";
        $("btnRefresh").disabled = true;
        return;
    }
    $("btnRefresh").disabled = state.loading;

    if (state.error && rows.length === 0) {
        list.innerHTML = `<div class="lr-state error">${esc(state.error)}</div>`;
        footer.innerHTML = `<button type="button" class="lr-btn" id="btnRetry">Coba Lagi</button>`;
        return;
    }

    if (rows.length === 0) {
        list.innerHTML = `<div class="lr-state">${state.offset < state.total ? "Belum ada data yang cocok pada halaman ini." : `Tidak ada data patroli dalam ${DAYS_BACK} hari terakhir.`}</div>`;
    } else {
        list.innerHTML = state.scope.group ? groupedHtml(rows) : rows.map(cardHtml).join("");
    }

    const more = state.offset < state.total;
    let html = "";
    if (state.error) html += `<div class="lr-state error" style="padding:8px 16px">${esc(state.error)}</div>`;
    if (rows.length > 0) html += `<div>Menampilkan ${rows.length} data${state.total && !EMPLOYEE_JABATAN_COLUMN || state.scope.mode !== "danru" ? ` dari ${state.total}` : ""}</div>`;
    if (more) html += `<button type="button" class="lr-btn plain" id="btnMore" ${state.loading ? "disabled" : ""}>${state.loading ? "Memuat..." : "Muat lebih banyak"}</button>`;
    else if (state.error) html += `<button type="button" class="lr-btn" id="btnRetry">Coba Lagi</button>`;
    footer.innerHTML = html;
}

function updateSubtitle() {
    const s = state.scope;
    if (!s || s.error) { $("subtitle").textContent = "-"; return; }
    const area = s.areaId !== null && s.areaId !== undefined ? ` · ${areaLabel(s.areaId)}` : "";
    $("subtitle").textContent = `${s.label}${area} · ${DAYS_BACK} hari terakhir`;
}

// ===================================================
// KELOMPOK 8: INISIALISASI
// Fungsi: dijalankan saat halaman dibuka: cek sesi dan jabatan, tentukan
// aturan data, muat data, lalu pasang tombol (Segarkan, Muat lebih banyak,
// Coba Lagi), lipat/buka kelompok area, dan muat ulang saat data sudah lama
// atau koneksi kembali.
// ===================================================
function showBlockedMessage(text) {
    $("subtitle").textContent = "-";
    $("list").innerHTML = `<div class="lr-state error">${esc(text)}</div>`;
    $("footer").innerHTML = "";
    $("btnRefresh").disabled = true;
}

document.addEventListener("DOMContentLoaded", () => {
    $("appVersion").textContent = `Versi skrip: ${APP_VERSION}`;
    console.info("[Laporan Patroli PWA] versi skrip:", APP_VERSION);

    state.session = readSession();
    if (!state.session) {
        showBlockedMessage(`Sesi tidak ditemukan. Silakan login terlebih dahulu.\n\n${sessionProblem}`);
        return;
    }

    state.scope = resolveScope(state.session);
    if (state.scope.error) {
        showBlockedMessage(state.scope.error);
        return;
    }
    updateSubtitle();

    $("btnRefresh").addEventListener("click", () => loadPage(true));
    $("footer").addEventListener("click", (e) => {
        if (e.target.closest("#btnMore")) loadPage(false);
        else if (e.target.closest("#btnRetry")) loadPage(state.rows.length === 0);
    });

    // Melipat / membuka kelompok area (event "toggle" tidak menggelembung, jadi memakai capture)
    $("list").addEventListener("toggle", (e) => {
        const d = e.target;
        if (!d.matches || !d.matches("details.lr-group")) return;
        if (d.open) state.collapsed.delete(d.dataset.area);
        else state.collapsed.add(d.dataset.area);
    }, true);

    window.addEventListener("online", () => { if (state.error) loadPage(true); });
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden && !state.loading && Date.now() - state.loadedAt > STALE_MS) loadPage(true);
    });

    loadPage(true).then(updateSubtitle);
});