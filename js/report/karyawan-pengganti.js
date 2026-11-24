// ===================================================
// karyawan-pengganti.js
// PWA - halaman "Karyawan Pengganti": supervisor menugaskan karyawan Reliver
// (Karyawan Bertugas) menggantikan karyawan yang absen (Pengganti) atau sebagai
// tenaga Casual. Mengisi hrd.karyawan_pengganti dan hrd.jadwal_assignments.
// Baca/tulis HANYA lewat fungsi database hrd.pengganti_* (lihat pengganti.sql).
// Semua aturan (siapa boleh, filter karyawan, edit terkunci, penonaktifan data lama)
// ada di database; file ini hanya menampilkan dan mengirim isian.
// WAJIB: jalankan pengganti.sql di Supabase terlebih dulu.
// ===================================================

// ===================================================
// KELOMPOK 1: PENGATURAN (KONFIGURASI)
// ===================================================
let supabaseClient = window.supabaseClient;

const SESSION_KEY = "pwa_mobile_session";   // key sesi login PWA (JSON)
const PAGE_SIZE = 30;                       // jumlah kartu per pemuatan

// ===================================================
// KELOMPOK 2: STATE (DATA SEMENTARA DI MEMORI)
// ===================================================
const S = {
    ctx: null,                  // konteks pengguna dari server (role, departemen, hari ini)
    rows: [], offset: 0, hasMore: false, loading: false, listReq: 0,
    mode: null,                 // "add" | "view" | "edit"
    cur: null,                  // data kartu yang dibuka (dari pengganti_ambil)
    saving: false,
    cache: {},                  // daftar yang dimuat sekali: shift, mitra, karyawan absen/bertugas
    combos: {}                  // id dropdown cari -> { items, loading }
};

// ===================================================
// KELOMPOK 3: FUNGSI BANTU (HELPER)
// ===================================================
const $ = (id) => document.getElementById(id);
const hrd = () => supabaseClient.schema("hrd");

function esc(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const HARI = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
const HARI_SINGKAT = ["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"];   // kalender mulai hari Senin
const BULAN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const BULAN_PANJANG = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

function pad(n) { return String(n).padStart(2, "0"); }
function ymd(y, m, d) { return `${y}-${pad(m + 1)}-${pad(d)}`; }          // m = 0-11
function parseYmd(s) { const [y, m, d] = String(s).slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); }
function fmtTglLengkap(s) { const d = parseYmd(s); return `${pad(d.getDate())} ${BULAN[d.getMonth()]} ${d.getFullYear()}`; }
function fmtTglPanjang(s) { const d = parseYmd(s); return `${HARI[d.getDay()]}, ${pad(d.getDate())} ${BULAN[d.getMonth()]} ${d.getFullYear()}`; }
function todayLocal() { const t = new Date(); return ymd(t.getFullYear(), t.getMonth(), t.getDate()); }

let toastTimer = null;
function showToast(text) {
    const t = $("kpToast");
    t.textContent = text;
    t.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.style.display = "none"; }, 3500);
}
function setMsg(text, type) {
    const el = $("kpMsg");
    if (!text) { el.hidden = true; el.textContent = ""; return; }
    el.className = `kp-msg ${type || "danger"}`;
    el.textContent = text;
    el.hidden = false;
    $("kpBody").scrollTop = 0;
}
function setNote(text) {
    const el = $("kpNote");
    el.textContent = text || "";
    el.hidden = !text;
}
function setBusy(btn, busy, busyText) {
    if (busy) {
        if (!btn.dataset.origHtml) btn.dataset.origHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${busyText}`;
    } else {
        btn.disabled = false;
        if (btn.dataset.origHtml) { btn.innerHTML = btn.dataset.origHtml; delete btn.dataset.origHtml; }
    }
}

function openModal(id) { $(id).classList.add("open"); document.body.style.overflow = "hidden"; }
function closeModal(id) { $(id).classList.remove("open"); if (!document.querySelector(".kp-modal.open")) document.body.style.overflow = ""; }

// Kolom ketuk (tanggal, dropdown cari): nilai sebenarnya di data-value, teks tampil di value
function setTap(id, value, text) { const el = $(id); el.dataset.value = value || ""; el.value = value ? text : ""; }
function tapValue(id) { return $(id).dataset.value || ""; }

// Memuat daftar dari database sekali saja
async function cached(key, rpcName, args) {
    if (S.cache[key]) return S.cache[key];
    const { data, error } = await hrd().rpc(rpcName, args || {});
    if (error) throw error;
    S.cache[key] = data;
    return data;
}

// ===================================================
// KELOMPOK 4: INISIALISASI
// Fungsi: memeriksa koneksi dan login, memuat konteks pengguna (database menolak role
// selain Maintenance, Superadmin, Supervisor), memasang tombol, lalu memuat daftar.
// ===================================================
function failPage(message) {
    $("btnBuat").disabled = true;
    $("kpList").innerHTML = `<div class="kp-empty">${esc(message)}</div>`;
}

document.addEventListener("DOMContentLoaded", async () => {
    supabaseClient = window.supabaseClient || supabaseClient;
    setupEvents();

    const sessionRaw = localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY);
    if (!sessionRaw) { window.location.replace("../../login.html"); return; }
    if (!supabaseClient) { failPage("Koneksi database tidak tersedia (supabase.js tidak termuat). Periksa path <script> di karyawan-pengganti.html."); return; }

    try {
        const { data: sess } = await supabaseClient.auth.getSession();
        if (!sess || !sess.session) { failPage("Sesi login belum terhubung ke server. Keluar lalu masuk kembali."); return; }
        const { data, error } = await hrd().rpc("pengganti_konteks");
        if (error) throw error;
        S.ctx = data;
    } catch (err) {
        console.error("Gagal memuat data pengguna:", err);
        failPage(err.message);
        return;
    }
    loadList(true);
});

function setupEvents() {
    $("btnBuat").addEventListener("click", openAdd);
    $("kpBtnX").addEventListener("click", closeForm);
    $("kpBtnTutup").addEventListener("click", closeForm);
    $("kpBtnBatal").addEventListener("click", () => { if (S.mode === "edit" && S.cur) backToView(); else closeForm(); });
    $("kpBtnEdit").addEventListener("click", enterEdit);
    $("kpBtnSimpan").addEventListener("click", save);
    $("fTipe").addEventListener("change", onTipeChange);

    // Satu pendengar untuk semua isian di dalam form
    const body = $("kpBody");
    body.addEventListener("click", (e) => {
        const item = e.target.closest(".kp-combo-item");
        if (item) { pickComboItem(item); return; }
        if (!e.target.closest(".kp-combo")) closeCombos();
        const tap = e.target.closest(".kp-tap");
        if (!tap) return;
        if (tap.id === "tapTgl") pickTanggal();
        else if (tap.dataset.combo) toggleCombo(tap.dataset.combo);
    });
    body.addEventListener("input", (e) => {
        if (e.target.classList.contains("kp-combo-search")) renderComboList(e.target.dataset.combo);
    });

    // Daftar: kartu dan "muat lebih banyak"
    document.addEventListener("click", (e) => {
        if (e.target.closest(".kp-more")) { loadList(false); return; }
        const card = e.target.closest(".kp-card");
        if (card) openDetail(card.dataset.id);
    });

    // Pemilih tanggal
    $("kpDateOk").addEventListener("click", () => finishDate(dp.sel));
    $("kpDateX").addEventListener("click", () => finishDate(null));
    $("kpDate").addEventListener("click", (e) => { if (e.target === $("kpDate")) finishDate(null); });
    $("kpDateCal").addEventListener("click", (e) => {
        const nav = e.target.closest("[data-nav]");
        if (nav) {
            const d = new Date(dp.y, dp.m + Number(nav.dataset.nav), 1);
            dp.y = d.getFullYear(); dp.m = d.getMonth();
            renderDateCal();
            return;
        }
        const btn = e.target.closest(".kp-day");
        if (btn && !btn.disabled) { dp.sel = btn.dataset.d; renderDateCal(); }
    });
}

// ===================================================
// KELOMPOK 5: DAFTAR KARTU
// Fungsi: kartu dikelompokkan per tanggal tugas, tanggal terbaru di atas (urutan dari
// database). Isi kartu: NIK dan nama karyawan bertugas, Area, kode shift, jam absen
// (hanya bila sudah ada), serta penanda asal data: "Dari Pengganti" (dibuat di halaman
// ini) atau "Dari Lembur" (dari Pengajuan Lembur).
// Dimuat bertahap, 30 per kali.
// ===================================================
async function loadList(reset) {
    if (S.loading) return;
    const my = ++S.listReq;
    S.loading = true;
    if (reset) {
        S.rows = []; S.offset = 0;
        $("kpList").innerHTML = `<div class="kp-loading"><i class="fa-solid fa-spinner fa-spin"></i> Memuat data...</div>`;
    } else {
        const b = $("kpList").querySelector(".kp-more");
        if (b) { b.disabled = true; b.textContent = "Memuat..."; }
    }
    try {
        const { data, error } = await hrd().rpc("pengganti_list", { p_limit: PAGE_SIZE, p_offset: S.offset });
        if (my !== S.listReq) return;
        if (error) throw error;
        const rows = data || [];
        S.rows.push(...rows);
        S.offset += rows.length;
        S.hasMore = rows.length === PAGE_SIZE;
        renderList();
    } catch (err) {
        if (my !== S.listReq) return;
        console.error("Gagal memuat data:", err);
        if (reset) $("kpList").innerHTML = `<div class="kp-empty">Gagal memuat data: ${esc(err.message)}</div>`;
        else showToast("Gagal memuat data: " + err.message);
    } finally {
        if (my === S.listReq) S.loading = false;
    }
}

function cardHtml(r) {
    const asalTag = r.asal === "lembur"
        ? `<span class="kp-tag lembur">Dari Lembur</span>`
        : `<span class="kp-tag">Dari Pengganti</span>`;
    const jam = (r.jam_masuk || r.jam_pulang)
        ? `<div class="kp-card-meta"><i class="fa-regular fa-clock"></i> Absen: ${esc(r.jam_masuk || "-")} - ${esc(r.jam_pulang || "-")}</div>` : "";
    const menggantikan = r.tipe === "Pengganti" && r.absen_nama
        ? `<div class="kp-card-meta"><i class="fa-solid fa-user-minus"></i> Menggantikan: ${esc((r.absen_nik ? r.absen_nik + " - " : "") + r.absen_nama)}</div>` : "";
    return `
        <div class="kp-card" data-id="${esc(r.id)}">
            <div class="kp-card-top">
                <div class="kp-card-title">${esc((r.bertugas_nik ? r.bertugas_nik + " - " : "") + (r.bertugas_nama || "-"))}</div>
                ${asalTag}
            </div>
            <div class="kp-card-meta"><i class="fa-solid fa-location-dot"></i> ${esc(r.area_nama || "-")}</div>
            <div class="kp-card-meta"><i class="fa-solid fa-business-time"></i> Shift ${esc(r.kode_shift || "-")} &bull; ${esc(r.tipe || "")}</div>
            ${menggantikan}
            ${jam}
        </div>`;
}

function renderList() {
    const box = $("kpList");
    if (S.rows.length === 0) {
        box.innerHTML = `<div class="kp-empty">Belum ada data karyawan pengganti. Ketuk <b>+ Pengganti</b> untuk menambah.</div>`;
        return;
    }
    let html = "", last = null;
    S.rows.forEach((r) => {
        if (r.tanggal !== last) { html += `<div class="kp-group">${esc(fmtTglPanjang(r.tanggal))}</div>`; last = r.tanggal; }
        html += cardHtml(r);
    });
    if (S.hasMore) html += `<button type="button" class="kp-more">Muat lebih banyak</button>`;
    box.innerHTML = html;
}

// ===================================================
// KELOMPOK 6: MODAL - MODE & ISIAN
// Fungsi: satu modal untuk tiga mode.
//   add  : form kosong (Tanggal hari ini atau sesudahnya)
//   view : isi kartu, hanya baca; tombol Edit muncul jika milik pengguna (atau role 1 / 2),
//          dibuat di halaman ini, dan masih aktif
//   edit : isian terbuka. Jika karyawan bertugas SUDAH punya absensi pada tanggal itu,
//          hanya Shift Kerja yang bisa diubah (sisanya terkunci).
// Data dari Lembur hanya bisa dilihat; diubah lewat Pengajuan Lembur.
// ===================================================
function setEnabled(ids, on) {
    ids.forEach((id) => {
        const el = $(id);
        if (el.classList.contains("kp-tap")) el.classList.toggle("kp-off", !on);
        else el.disabled = !on;
    });
}

function applyMode() {
    const add = S.mode === "add", view = S.mode === "view", edit = S.mode === "edit";
    const locked = !!(S.cur && S.cur.ada_absen);
    const fromLembur = !!(S.cur && S.cur.asal === "lembur");
    $("kpTitle").textContent = add ? "Tambah Pengganti" : view ? "Detail Pengganti" : "Edit Pengganti";

    const allOn = add || (edit && !locked);
    setEnabled(["tapTgl", "fTipe", "tapAbsen", "fMitra", "fArea", "tapBertugas"], allOn);
    setEnabled(["fShift"], add || edit);

    $("kpBtnTutup").hidden = !view;
    $("kpBtnEdit").hidden = !(view && S.cur && S.cur.bisa_edit);
    $("kpBtnBatal").hidden = view;
    $("kpBtnSimpan").hidden = view;

    if (fromLembur) setNote("Data ini berasal dari Pengajuan Lembur dan hanya bisa dilihat di sini.");
    else if (locked && !add) setNote("Karyawan bertugas sudah memiliki absensi pada tanggal ini. Hanya Shift Kerja yang dapat diubah.");
    else setNote("");
}

function onTipeChange() {
    const tipe = $("fTipe").value;
    $("wrapAbsen").hidden = tipe !== "Pengganti";
    $("wrapCasual").hidden = tipe !== "Casual";
}

function resetForm() {
    setMsg("");
    closeCombos();
    setTap("fTgl", S.ctx.hari_ini, fmtTglLengkap(S.ctx.hari_ini));
    $("fTipe").value = "Pengganti";
    setTap("fAbsen", "", "");
    setTap("fBertugas", "", "");
    $("fShift").value = "";
    $("fMitra").value = "";
    $("fArea").value = "";
    onTipeChange();
}

// Shift kerja dan daftar Mitra / Area (Mitra dan Area difilter cabang pengguna oleh database)
async function ensureLookups() {
    try {
        const [shift, mitra] = await Promise.all([
            cached("shift", "pengganti_daftar_shift"),
            cached("mitra", "pengajuan_daftar_mitra")
        ]);
        const cur = $("fShift").value;
        $("fShift").innerHTML = `<option value="">Pilih Shift Kerja</option>` + shift.map(s => {
            const jam = s.jam_masuk ? ` (${s.jam_masuk} - ${s.jam_pulang})` : "";
            return `<option value="${esc(s.kode)}">${esc(s.nama + jam)}</option>`;
        }).join("");
        $("fMitra").innerHTML = `<option value="">Pilih Mitra</option>` + (mitra.costcenter || []).map(c => `<option value="${esc(c.id)}">${esc(c.nama)}</option>`).join("");
        $("fArea").innerHTML = `<option value="">Pilih Area</option>` + (mitra.area || []).map(a => `<option value="${esc(a.id)}">${esc(a.nama)}</option>`).join("");
        if (cur) $("fShift").value = cur;
    } catch (err) {
        setMsg("Gagal memuat daftar shift / mitra: " + err.message, "danger");
    }
}

function openAdd() {
    if (!S.ctx) return;
    S.mode = "add"; S.cur = null;
    resetForm();
    applyMode();
    openModal("kpModal");
    $("kpBody").scrollTop = 0;
    ensureLookups();
}

async function openDetail(id) {
    if (S.saving) return;
    try {
        const { data, error } = await hrd().rpc("pengganti_ambil", { p_id: Number(id) });
        if (error) throw error;
        S.mode = "view"; S.cur = data;
        resetForm();
        applyMode();
        openModal("kpModal");
        $("kpBody").scrollTop = 0;
        await fillForm(data);
    } catch (err) {
        console.error("Gagal membuka data:", err);
        showToast("Gagal membuka data: " + err.message);
    }
}

// Mengisi form dari data kartu
async function fillForm(d) {
    setTap("fTgl", d.tanggal, fmtTglLengkap(d.tanggal));
    $("fTipe").value = d.tipe;
    onTipeChange();
    setTap("fAbsen", d.absen_id || "", d.absen_label || "");
    setTap("fBertugas", d.bertugas_id || "", d.bertugas_label || "");
    await ensureLookups();
    // Shift yang sudah tidak aktif di daftar tetap ditampilkan agar nilai lama tidak hilang
    if (d.kode_shift && ![...$("fShift").options].some(o => o.value === d.kode_shift)) {
        $("fShift").insertAdjacentHTML("beforeend", `<option value="${esc(d.kode_shift)}">${esc(d.kode_shift)}</option>`);
    }
    $("fShift").value = d.kode_shift || "";
    $("fMitra").value = d.tipe === "Casual" && d.costcenter_id ? String(d.costcenter_id) : "";
    $("fArea").value = d.tipe === "Casual" && d.area_id ? String(d.area_id) : "";
}

function enterEdit() {
    if (!S.cur || !S.cur.bisa_edit) return;
    S.mode = "edit";
    setMsg("");
    applyMode();
}

async function backToView() {
    S.mode = "view";
    resetForm();
    applyMode();
    await fillForm(S.cur);
}

function closeForm() {
    if (S.saving) return;
    closeCombos();
    closeModal("kpModal");
    S.mode = null; S.cur = null;
    setMsg("");
}

// ===================================================
// KELOMPOK 7: PEMILIH TANGGAL
// Fungsi: kalender di atas modal. Tanggal baru: hari ini atau sesudahnya. Saat edit,
// tanggal asli tetap boleh dipilih walau sudah lewat. Database memeriksa ulang.
// ===================================================
const dp = { resolve: null, sel: null, y: 0, m: 0, isEnabled: () => true };

function pickDate(opt) {
    return new Promise((resolve) => {
        dp.resolve = resolve;
        dp.isEnabled = opt.isEnabled || (() => true);
        dp.sel = opt.value || null;
        const base = parseYmd(opt.value || S.ctx.hari_ini);
        dp.y = base.getFullYear(); dp.m = base.getMonth();
        renderDateCal();
        openModal("kpDate");
    });
}

function finishDate(v) {
    if (!dp.resolve) return;
    const r = dp.resolve; dp.resolve = null;
    closeModal("kpDate");
    r(v);
}

function renderDateCal() {
    const today = todayLocal();
    const offset = (new Date(dp.y, dp.m, 1).getDay() + 6) % 7;
    const days = new Date(dp.y, dp.m + 1, 0).getDate();
    let body = "";
    for (let r = 0; r < Math.ceil((offset + days) / 7); r++) {
        body += "<tr>";
        for (let c = 0; c < 7; c++) {
            const day = r * 7 + c - offset + 1;
            if (day < 1 || day > days) { body += "<td></td>"; continue; }
            const d = ymd(dp.y, dp.m, day);
            const cls = `kp-day${d === today ? " today" : ""}${d === dp.sel ? " sel" : ""}`;
            body += `<td><button type="button" class="${cls}" data-d="${d}" ${dp.isEnabled(d) ? "" : "disabled"}>${day}</button></td>`;
        }
        body += "</tr>";
    }
    $("kpDateCal").innerHTML = `
        <div class="kp-cal-head">
            <button type="button" class="kp-cal-nav" data-nav="-1" aria-label="Bulan sebelumnya"><i class="fa-solid fa-chevron-left"></i></button>
            <div class="kp-cal-title">${BULAN_PANJANG[dp.m]} ${dp.y}</div>
            <button type="button" class="kp-cal-nav" data-nav="1" aria-label="Bulan berikutnya"><i class="fa-solid fa-chevron-right"></i></button>
        </div>
        <table><thead><tr>${HARI_SINGKAT.map(h => `<th>${h}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table>`;
    $("kpDateOk").disabled = !dp.sel;
}

async function pickTanggal() {
    const asli = S.mode === "edit" && S.cur ? S.cur.tanggal : null;
    const v = await pickDate({
        value: tapValue("fTgl"),
        isEnabled: d => d >= S.ctx.hari_ini || d === asli
    });
    if (v) setTap("fTgl", v, fmtTglLengkap(v));
}

// ===================================================
// KELOMPOK 8: DROPDOWN DENGAN KOLOM CARI (Karyawan Absen, Karyawan Bertugas)
// Fungsi: diketuk membuka panel berisi kolom cari (NIK atau nama) dan daftar; memilih
// satu baris menutup panel. Daftar dimuat dari database saat pertama dibuka:
//   Karyawan Absen    : PKWT / PKWTT, departemen sama dengan pengguna
//   Karyawan Bertugas : Reliver, departemen sama dengan pengguna
// ===================================================
const COMBO_JENIS = { fAbsen: "absen", fBertugas: "bertugas" };

async function ensureCombo(id) {
    if (S.combos[id] && !S.combos[id].loading) return;
    S.combos[id] = { items: [], loading: true };
    renderComboList(id);
    try {
        const list = await cached("kar_" + COMBO_JENIS[id], "pengganti_daftar_karyawan", { p_jenis: COMBO_JENIS[id] });
        S.combos[id] = { items: list.map(k => ({ value: k.id, text: `${k.nik} - ${k.nama}` })), loading: false };
    } catch (err) {
        S.combos[id] = { items: [], loading: false };
        setMsg("Gagal memuat daftar karyawan: " + err.message, "danger");
    }
    renderComboList(id);
}

function renderComboList(id) {
    const c = S.combos[id];
    const box = $(id + "List");
    if (!c || !box) return;
    const q = ($(id + "Search").value || "").trim().toLowerCase();
    const found = c.items.filter(i => !q || i.text.toLowerCase().includes(q)).slice(0, 100);
    box.innerHTML = found.length
        ? found.map(i => `<div class="kp-combo-item${i.value === tapValue(id) ? " sel" : ""}" data-combo="${id}" data-v="${esc(i.value)}">${esc(i.text)}</div>`).join("")
        : `<div class="kp-combo-empty">${c.loading ? "Memuat..." : "Tidak ada hasil"}</div>`;
}

function closeCombos() { document.querySelectorAll(".kp-combo-panel").forEach(p => { p.hidden = true; }); }

function toggleCombo(id) {
    const panel = $(id + "Panel");
    const willOpen = panel.hidden;
    closeCombos();
    if (!willOpen) return;
    panel.hidden = false;
    $(id + "Search").value = "";
    ensureCombo(id);
    renderComboList(id);
    $(id + "Search").focus();
    panel.scrollIntoView({ block: "nearest" });
}

function pickComboItem(el) {
    const id = el.dataset.combo;
    const it = S.combos[id] && S.combos[id].items.find(x => x.value === el.dataset.v);
    if (it) setTap(id, it.value, it.text);
    closeCombos();
}

// ===================================================
// KELOMPOK 9: VALIDASI & SIMPAN
// Fungsi: memeriksa isian di layar lalu memanggil hrd.pengganti_simpan (satu transaksi).
// Di belakang layar (diisi database): supervisor_id, departemen / cost center / area,
// is_active, source "delegasi", status "approved", petugas_id, dan penonaktifan data lama.
// Pesan error dari database ditampilkan apa adanya.
// ===================================================
function collect() {
    const tipe = $("fTipe").value;
    const tgl = tapValue("fTgl");
    const shift = $("fShift").value;
    const bertugas = tapValue("fBertugas");
    const errs = [];
    if (!tgl) errs.push("Pilih Tanggal.");
    if (tipe === "Pengganti" && !tapValue("fAbsen")) errs.push("Pilih Karyawan Absen.");
    if (tipe === "Casual") {
        if (!$("fMitra").value) errs.push("Pilih Mitra.");
        if (!$("fArea").value) errs.push("Pilih Area.");
    }
    if (!shift) errs.push("Pilih Shift Kerja.");
    if (!bertugas) errs.push("Pilih Karyawan Bertugas.");
    if (errs.length) throw new Error(`Belum bisa disimpan. Perbaiki dulu:\n${errs.join("\n")}`);

    const payload = { tipe, tanggal: tgl, kode_shift: shift, bertugas_id: bertugas };
    if (tipe === "Pengganti") payload.absen_id = tapValue("fAbsen");
    else { payload.costcenter_id = Number($("fMitra").value); payload.area_id = Number($("fArea").value); }
    if (S.mode === "edit" && S.cur) payload.id = S.cur.id;
    return payload;
}

async function save() {
    if (S.saving || (S.mode !== "add" && S.mode !== "edit")) return;
    setMsg("");
    let payload;
    try { payload = collect(); }
    catch (err) { setMsg(err.message, "danger"); return; }

    const btn = $("kpBtnSimpan");
    const edited = S.mode === "edit";
    S.saving = true;
    setBusy(btn, true, "Menyimpan...");
    try {
        const { error } = await hrd().rpc("pengganti_simpan", { p: payload });
        if (error) throw error;
        S.saving = false;
        closeForm();
        showToast(edited ? "Perubahan tersimpan." : "Data pengganti tersimpan.");
        loadList(true);
    } catch (err) {
        console.error("Gagal menyimpan:", err);
        setMsg(`Tidak ada data yang tersimpan.\n${err.message}`, "danger");
    } finally {
        S.saving = false;
        setBusy(btn, false);
    }
}