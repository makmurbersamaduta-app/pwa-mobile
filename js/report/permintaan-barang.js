// ===================================================
// request.js
// PWA - halaman "Permintaan Barang"
// Baca : ga.v_request_card (daftar), ga.v_request_item (isi barang), ga.data_barang (cari barang)
// Tulis: lewat fungsi database ga.simpan_request / ga.ubah_request
//        (satu transaksi: semua tersimpan atau tidak sama sekali)
// WAJIB: jalankan request.sql di Supabase terlebih dulu.
// ===================================================

// ===================================================
// KELOMPOK 1: PENGATURAN (KONFIGURASI)
// Fungsi: nilai tetap yang dipakai di seluruh file.
// ===================================================
// PERLU DICEK: samakan dengan cara memo.js mengambil koneksi Supabase.
const supabaseClient = window.supabaseClient;

const DB_SCHEMA = "ga";
const SESSION_KEY = "pwa_mobile_session";   // key sesi login PWA (JSON)

// PERLU DICEK: nama field di sesi. Skrip mencari field pertama yang ada (juga di dalam objek bersarang).
// Jika nama di sesi Anda berbeda, tambahkan di daftar yang sesuai.
const SESSION_FIELDS = {
    nik: ["nik", "nik_karyawan", "username"],
    branch: ["branchId", "branch_id"],
    department: ["depId", "department_id", "departemenId", "departemen_id"],
    area: ["areaId", "area_id"]
};

const PAGE_SIZE = 30;                    // jumlah kartu per pemuatan
const MAX_ROWS = 50;                     // batas jumlah barang per permintaan
const SUGGEST_LIMIT = 15;                // jumlah saran Kode Barang
const FILTER_PEMOHON_SENDIRI = true;     // true = hanya permintaan milik user ini; false = semua permintaan di cabang+departemen+area yang sama
const EDITABLE_STATUS = ["Diajukan", "Disetujui"];   // status yang boleh diedit (selama belum ada pengiriman)

// Barang yang bernilai false di kolom cabangnya disembunyikan dari pencarian
const BATASI_BARANG_PER_CABANG = true;
const BRANCH_FLAG_COLUMN = { 2: "is_makassar", 1: "is_surabaya" };

// ===================================================
// KELOMPOK 2: STATE (DATA SEMENTARA DI MEMORI)
// ===================================================
const L = { cards: [], offset: 0, total: 0, loading: false, lastStatus: null, reqId: 0 };

// Modal. mode: "add" | "view" | "edit". rows[i] = { item, text, qty }
let R = freshModal();
function freshModal() {
    return { mode: null, card: null, rows: [], origRows: [], info: null, saving: false };
}
const suggest = { items: [], active: -1, rowIdx: -1, timer: null, reqId: 0, box: null };

// ===================================================
// KELOMPOK 3: FUNGSI BANTU (HELPER)
// ===================================================
const $ = (id) => document.getElementById(id);
const ga = () => supabaseClient.schema(DB_SCHEMA);

// Mengamankan teks sebelum dimasukkan ke HTML
function esc(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function formatInt(n) { return new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 }).format(Number(n) || 0); }
function formatQty(n) { return new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 }).format(Number(n) || 0); }

const HARI = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
const BULAN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const BULAN_PANJANG = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

function parseIsoDate(s) {
    const [y, m, d] = String(s).slice(0, 10).split("-").map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
}
// "2026-10-05" -> "Senin, 05 Okt 2026"
function formatTanggal(s) {
    if (!s) return "-";
    const d = parseIsoDate(s);
    if (isNaN(d)) return "-";
    return `${HARI[d.getDay()]}, ${String(d.getDate()).padStart(2, "0")} ${BULAN[d.getMonth()]} ${d.getFullYear()}`;
}
// "2026-10-05" -> ["Oktober 2026", "November 2026"] (bulan itu dan bulan depannya)
function periodeOptionsFromIso(iso) {
    const d = parseIsoDate(iso);
    if (isNaN(d)) return [];
    const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    return [`${BULAN_PANJANG[d.getMonth()]} ${d.getFullYear()}`, `${BULAN_PANJANG[next.getMonth()]} ${next.getFullYear()}`];
}

function showToast(text) {
    const t = $("rqToast");
    t.textContent = text;
    t.style.display = "block";
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { t.style.display = "none"; }, 3500);
}
function showMsg(text, type) {
    const el = $("rqMsg");
    if (!text) { el.hidden = true; el.textContent = ""; return; }
    el.className = `rq-msg ${type || "danger"}`;
    el.textContent = text;
    el.hidden = false;
    $("rqBody").scrollTop = 0;
}
function setBusy(btn, busy, busyText) {
    if (busy) {
        btn.dataset.origHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${busyText}`;
    } else {
        btn.disabled = false;
        if (btn.dataset.origHtml) btn.innerHTML = btn.dataset.origHtml;
    }
}

// ===================================================
// KELOMPOK 4: SESI LOGIN
// Fungsi: membaca pwa_mobile_session. Dibutuhkan: NIK (pemohon), branch_id,
// department_id, dan area_id. Jika ada yang tidak ditemukan, pembuatan
// permintaan dinonaktifkan dengan pesan yang menyebut field mana yang kosong.
// ===================================================
function getSession() {
    const raw = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); }
    catch (err) { console.error("Sesi login tidak bisa dibaca:", err); return null; }
}

// Mencari field pertama yang ada (di objek itu atau objek di dalamnya, maks. 2 tingkat)
function findField(obj, names, depth = 2) {
    if (!obj || typeof obj !== "object") return null;
    for (const n of names) {
        if (obj[n] !== undefined && obj[n] !== null && obj[n] !== "") return obj[n];
    }
    if (depth > 0) {
        for (const v of Object.values(obj)) {
            if (v && typeof v === "object" && !Array.isArray(v)) {
                const r = findField(v, names, depth - 1);
                if (r !== null) return r;
            }
        }
    }
    return null;
}

function toInt(v) { const n = parseInt(v, 10); return isNaN(n) ? null : n; }

function getUser() {
    const s = getSession();
    if (!s) return null;
    const nik = findField(s, SESSION_FIELDS.nik);
    return {
        nik: nik ? String(nik).trim() : null,
        branchId: toInt(findField(s, SESSION_FIELDS.branch)),
        departmentId: toInt(findField(s, SESSION_FIELDS.department)),
        areaId: toInt(findField(s, SESSION_FIELDS.area))
    };
}

// Daftar field sesi yang belum terbaca (untuk pesan error yang jelas)
function missingUserFields(u) {
    if (!u) return ["sesi login"];
    const miss = [];
    if (!u.nik) miss.push("nik");
    if (u.branchId === null) miss.push("branch_id");
    if (u.departmentId === null) miss.push("department_id");
    if (u.areaId === null) miss.push("area_id");
    return miss;
}

// ===================================================
// KELOMPOK 5: INISIALISASI
// Fungsi: dijalankan saat halaman selesai dimuat. Memasang tombol, lalu
// memuat daftar permintaan.
// ===================================================
document.addEventListener("DOMContentLoaded", () => {
    setupModal();
    $("btnBuat").addEventListener("click", openAddModal);

    const u = getUser();
    if (!u || !u.nik) {
        $("btnBuat").disabled = true;
        $("requestList").innerHTML = `<div class="rq-empty">Sesi login tidak ditemukan. Silakan login ulang.</div>`;
        return;
    }
    const miss = missingUserFields(u);
    if (miss.length) $("btnBuat").title = `Data sesi belum lengkap: ${miss.join(", ")}`;
    loadList(true);
});

// ===================================================
// KELOMPOK 6: DAFTAR KARTU
// Fungsi: menampilkan permintaan dalam bentuk kartu "Kode Batch • Periode".
// Urutan: status "Diajukan" paling atas, lalu "Disetujui", lalu status lain;
// di dalam tiap status, tanggal terbaru di atas. Dimuat bertahap (30 per kali).
// Hanya permintaan aktif (is_active = true).
// ===================================================
async function loadList(reset) {
    const u = getUser();
    if (!u || !u.nik || L.loading) return;
    const myReq = ++L.reqId;
    L.loading = true;

    if (reset) {
        L.cards = []; L.offset = 0; L.total = 0; L.lastStatus = null;
        $("requestList").innerHTML = `<div class="rq-loading"><i class="fa-solid fa-spinner fa-spin"></i> Memuat data...</div>`;
    } else {
        const btn = $("requestList").querySelector(".rq-more");
        if (btn) { btn.disabled = true; btn.textContent = "Memuat..."; }
    }

    try {
        let q = ga().from("v_request_card").select("*", { count: "exact" }).eq("is_active", true);
        if (FILTER_PEMOHON_SENDIRI) {
            q = q.eq("pemohon", u.nik);
        } else {
            if (u.branchId !== null) q = q.eq("branch_id", u.branchId);
            if (u.departmentId !== null) q = q.eq("department_id", u.departmentId);
            if (u.areaId !== null) q = q.eq("area_id", u.areaId);
        }
        q = q.order("status_rank", { ascending: true })
             .order("tanggal", { ascending: false })
             .order("created_at", { ascending: false })
             .order("id", { ascending: true })
             .range(L.offset, L.offset + PAGE_SIZE - 1);

        const { data, error, count } = await q;
        if (myReq !== L.reqId) return;
        if (error) throw error;

        const rows = data || [];
        L.total = count || 0;
        L.cards.push(...rows);
        L.offset += rows.length;
        renderList(rows, reset);
    } catch (err) {
        if (myReq !== L.reqId) return;
        console.error("Gagal memuat permintaan:", err);
        const msg = `<div class="rq-empty">Gagal memuat data: ${esc(err.message)}</div>`;
        if (reset) $("requestList").innerHTML = msg;
        else showToast("Gagal memuat data: " + err.message);
    } finally {
        if (myReq === L.reqId) L.loading = false;
    }
}

function badgeClass(status) {
    const s = String(status || "").toLowerCase();
    return s === "diajukan" ? "diajukan" : s === "disetujui" ? "disetujui" : "";
}

function cardHtml(c) {
    return `
        <div class="rq-card" data-id="${esc(c.id)}">
            <div class="rq-card-top">
                <div class="rq-card-title">${esc(c.kode_batch)} &bull; ${esc(c.periode_permintaan || "-")}</div>
                <span class="rq-badge ${badgeClass(c.status)}">${esc(c.status || "-")}</span>
            </div>
            <div class="rq-card-meta"><i class="fa-regular fa-calendar"></i> ${esc(formatTanggal(c.tanggal))}</div>
            <div class="rq-card-meta">
                <i class="fa-solid fa-boxes-stacked"></i> ${formatInt(c.jumlah_barang)} barang
                ${c.ada_pengiriman ? '<span class="rq-tag">Sudah ada pengiriman</span>' : ""}
            </div>
        </div>`;
}

function renderList(newRows, reset) {
    const box = $("requestList");
    if (reset) box.innerHTML = "";
    box.querySelector(".rq-more")?.remove();

    if (L.cards.length === 0) {
        box.innerHTML = `<div class="rq-empty">Belum ada permintaan barang.</div>`;
        return;
    }

    let html = "";
    newRows.forEach(c => {
        const st = c.status || "Tanpa Status";
        if (st !== L.lastStatus) {
            html += `<div class="rq-group">${esc(st)}</div>`;
            L.lastStatus = st;
        }
        html += cardHtml(c);
    });
    box.insertAdjacentHTML("beforeend", html);

    if (L.cards.length < L.total) {
        box.insertAdjacentHTML("beforeend", `<button type="button" class="rq-more">Muat lebih banyak (${L.total - L.cards.length} lagi)</button>`);
    }
}

// Klik kartu / tombol "muat lebih banyak" (satu pendengar untuk semua kartu)
document.addEventListener("click", (e) => {
    const more = e.target.closest(".rq-more");
    if (more) { loadList(false); return; }
    const card = e.target.closest(".rq-card");
    if (card) {
        const c = L.cards.find(x => String(x.id) === card.dataset.id);
        if (c) openDetailModal(c);
    }
});

// ===================================================
// KELOMPOK 7: MODAL - PEMASANGAN TOMBOL & KEJADIAN
// Fungsi: tombol modal, kotak saran melayang, dan penanganan ketikan di
// tabel barang (satu pendengar untuk semua baris).
// ===================================================
function setupModal() {
    $("rqBtnX").addEventListener("click", closeModal);
    $("rqBtnTutup").addEventListener("click", closeModal);
    $("rqBtnBatal").addEventListener("click", () => {
        if (R.mode === "edit") backToView();
        else closeModal();
    });
    $("rqBtnEdit").addEventListener("click", enterEdit);
    $("rqBtnSimpan").addEventListener("click", () => {
        if (R.mode === "add") saveAdd();
        else if (R.mode === "edit") saveEdit();
    });

    suggest.box = document.createElement("div");
    suggest.box.className = "rq-suggest";
    document.body.appendChild(suggest.box);
    suggest.box.addEventListener("mousedown", (e) => {
        e.preventDefault();                // jangan pindahkan fokus dari kolom Kode Barang
        const el = e.target.closest(".rq-suggest-item");
        if (el) pickSuggestion(parseInt(el.dataset.k, 10));
    });
    suggest.box.addEventListener("touchstart", (e) => {
        const el = e.target.closest(".rq-suggest-item");
        if (el) { e.preventDefault(); pickSuggestion(parseInt(el.dataset.k, 10)); }
    }, { passive: false });
    $("rqBody").addEventListener("scroll", hideSuggest);

    const tbody = $("rqTbody");
    tbody.addEventListener("input", (e) => {
        const tr = e.target.closest("tr[data-i]");
        if (!tr) return;
        const i = parseInt(tr.dataset.i, 10);
        if (e.target.classList.contains("kode-input")) onKodeInput(i, e.target);
        else if (e.target.classList.contains("qty-input")) onQtyInput(i, e.target);
    });
    tbody.addEventListener("click", (e) => {
        const tr = e.target.closest("tr[data-i]");
        if (tr && e.target.closest(".rq-row-del")) removeRow(parseInt(tr.dataset.i, 10));
    });
    tbody.addEventListener("keydown", (e) => {
        if (!e.target.classList.contains("kode-input") || suggest.box.style.display !== "block") return;
        if (e.key === "ArrowDown") { e.preventDefault(); moveSuggest(1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); moveSuggest(-1); }
        else if (e.key === "Enter") { e.preventDefault(); pickSuggestion(suggest.active >= 0 ? suggest.active : 0); }
        else if (e.key === "Escape") hideSuggest();
    });
    tbody.addEventListener("focusout", (e) => {
        if (e.target.classList.contains("kode-input")) setTimeout(hideSuggest, 200);
    });
}

function openModalShell() {
    $("rqModal").classList.add("open");
    document.body.style.overflow = "hidden";
}
function closeModal() {
    hideSuggest();
    $("rqModal").classList.remove("open");
    document.body.style.overflow = "";
    R = freshModal();
    showMsg("", "");
}

// Mengatur tombol footer, isian, dan kolom sesuai mode
function applyModeUi() {
    const add = R.mode === "add", view = R.mode === "view", edit = R.mode === "edit";
    $("rqTitle").textContent = add ? "Buat Permintaan" : view ? "Detail Permintaan" : "Edit Permintaan";
    $("rqPeriode").hidden = view;
    $("rqPeriodeTxt").hidden = !view;
    $("rqStatusWrap").hidden = add;
    $("rqBtnTutup").hidden = !view;
    $("rqBtnBatal").hidden = view;
    $("rqBtnEdit").hidden = true;                  // diatur oleh openDetailModal sesuai syarat
    $("rqBtnSimpan").hidden = view;
}

// ===================================================
// KELOMPOK 8: MODAL - BUAT PERMINTAAN
// Fungsi: membuka form kosong. Tanggal dan nomor batch diambil dari SERVER
// (tampilan hanya pratinjau; nomor final ditetapkan saat Simpan, aman jika
// dua orang menyimpan bersamaan). Periode = bulan ini atau bulan depan.
// ===================================================
async function fetchServerInfo(branchId) {
    const { data, error } = await ga().rpc("next_kode_request", { p_branch: branchId });
    if (error) throw error;
    return data;      // { tanggal: "YYYY-MM-DD", kode_batch: "RO-DDMMYY-001" }
}

function fillPeriodeSelect(options, selected) {
    const sel = $("rqPeriode");
    const list = [...options];
    if (selected && !list.includes(selected)) list.unshift(selected);   // periode asli tetap tersedia saat edit
    sel.innerHTML = `<option value="">Pilih Periode</option>` +
        list.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join("");
    sel.value = selected || "";
}

async function openAddModal() {
    const u = getUser();
    const miss = missingUserFields(u);
    if (miss.length) {
        showToast(`Data sesi belum lengkap (${miss.join(", ")}). Hubungi admin.`);
        return;
    }

    R = freshModal();
    R.mode = "add";
    $("rqKode").value = "...";
    $("rqTanggal").value = "";
    $("rqPeriodeTxt").value = "";
    fillPeriodeSelect([], "");
    R.rows = [makeEmptyRow()];
    applyModeUi();
    renderRows();
    $("rqHint").textContent = "Nomor batch final ditetapkan saat disimpan.";
    showMsg("", "");
    openModalShell();

    try {
        R.info = await fetchServerInfo(u.branchId);
        $("rqKode").value = R.info.kode_batch || "";
        $("rqTanggal").value = formatTanggal(R.info.tanggal);
        fillPeriodeSelect(periodeOptionsFromIso(R.info.tanggal), "");
    } catch (err) {
        $("rqKode").value = "";
        showMsg("Gagal menyiapkan form: " + err.message, "danger");
    }
}

// ===================================================
// KELOMPOK 9: MODAL - DETAIL & EDIT
// Fungsi: klik kartu membuka detail (semua readonly). Tombol "Edit" hanya
// muncul jika: permintaan milik user ini, status Diajukan/Disetujui, dan
// BELUM ada pengiriman barang. Setelah diedit, status kembali "Diajukan"
// (data persetujuan dikosongkan). Database memeriksa ulang syarat ini.
// ===================================================
function canEdit(card) {
    const u = getUser();
    return !!u && card.pemohon === u.nik && !card.ada_pengiriman && EDITABLE_STATUS.includes(card.status);
}

function editBlockReason(card) {
    const u = getUser();
    if (!u || card.pemohon !== u.nik) return "Hanya pemohon yang dapat mengubah permintaan ini.";
    if (card.ada_pengiriman) return "Tidak dapat diedit: sudah ada pengiriman barang.";
    if (!EDITABLE_STATUS.includes(card.status)) return `Tidak dapat diedit: status "${card.status}".`;
    return "";
}

async function openDetailModal(card) {
    R = freshModal();
    R.mode = "view";
    R.card = card;
    $("rqKode").value = card.kode_batch || "";
    $("rqTanggal").value = formatTanggal(card.tanggal);
    $("rqPeriodeTxt").value = card.periode_permintaan || "";
    $("rqStatus").value = card.status || "";
    R.rows = [];
    applyModeUi();
    $("rqBtnEdit").hidden = !canEdit(card);
    $("rqHint").textContent = canEdit(card) ? "" : editBlockReason(card);
    $("rqTbody").innerHTML = `<tr class="rq-placeholder"><td colspan="6"><i class="fa-solid fa-spinner fa-spin"></i> Memuat barang...</td></tr>`;
    showMsg("", "");
    openModalShell();

    try {
        const { data, error } = await ga().from("v_request_item")
            .select("kode_barang, nama_barang, satuan, photo_path, qty, kategori_barang_id")
            .eq("request_batch_id", card.id)
            .order("kode_barang", { ascending: true });
        if (error) throw error;
        if (R.card !== card) return;                      // modal sudah ditutup / diganti
        R.origRows = (data || []).map(d => ({
            item: { kode_barang: d.kode_barang, nama_barang: d.nama_barang, satuan: d.satuan, photo_path: d.photo_path, kategori_barang_id: d.kategori_barang_id },
            text: d.kode_barang, qty: Number(d.qty) || 0
        }));
        R.rows = R.origRows.map(r => ({ ...r, item: { ...r.item } }));
        renderRows();
    } catch (err) {
        if (R.card !== card) return;
        console.error("Gagal memuat barang permintaan:", err);
        $("rqTbody").innerHTML = "";
        showMsg("Gagal memuat barang: " + err.message, "danger");
    }
}

async function enterEdit() {
    const card = R.card;
    if (!card || !canEdit(card)) return;
    const btn = $("rqBtnEdit");
    setBusy(btn, true, "Memuat...");
    try {
        R.info = await fetchServerInfo(card.branch_id);
    } catch (err) {
        setBusy(btn, false);
        showMsg("Gagal menyiapkan edit: " + err.message, "danger");
        return;
    }
    setBusy(btn, false);

    R.mode = "edit";
    applyModeUi();
    fillPeriodeSelect(periodeOptionsFromIso(R.info.tanggal), card.periode_permintaan || "");
    R.rows = R.origRows.map(r => ({ ...r, item: { ...r.item } }));
    ensureTrailingEmptyRow(true);
    renderRows();
    $("rqHint").textContent = "Jika disimpan dengan perubahan, status kembali menjadi \"Diajukan\".";
    showMsg("", "");
}

function backToView() {
    hideSuggest();
    R.mode = "view";
    applyModeUi();
    $("rqBtnEdit").hidden = !canEdit(R.card);
    $("rqPeriodeTxt").value = R.card.periode_permintaan || "";
    R.rows = R.origRows.map(r => ({ ...r, item: { ...r.item } }));
    $("rqHint").textContent = canEdit(R.card) ? "" : editBlockReason(R.card);
    showMsg("", "");
    renderRows();
}

// ===================================================
// KELOMPOK 10: MODAL - TABEL BARANG
// Fungsi: menggambar baris dan mengelola Qty (angka bulat, pemisah ribuan
// otomatis). Baris kosong baru muncul otomatis di bawah saat baris terakhir
// mulai diisi (maksimal 50). Nama barang boleh turun ke bawah (tidak melebar).
// ===================================================
function makeEmptyRow() { return { item: null, text: "", qty: null }; }
function rowIsEmpty(r) { return !r.item && (r.text || "").trim() === "" && !r.qty; }
function getTr(i) { return $("rqTbody").querySelector(`tr[data-i="${i}"]`); }

function fotoHtml(url) {
    if (!url) return `<span class="rq-dash">-</span>`;
    return `<a href="${esc(url)}" target="_blank" rel="noopener"><img class="rq-thumb" src="${esc(url)}" alt="Foto" loading="lazy"></a>`;
}

function buildRowHtml(i, row) {
    const it = row.item;
    const editable = R.mode === "add" || R.mode === "edit";
    const dash = `<span class="rq-dash">-</span>`;
    if (!editable) {
        return `
            <tr data-i="${i}">
                <td>${esc(row.item?.kode_barang || row.text)}</td>
                <td class="rq-nama">${it?.nama_barang ? esc(it.nama_barang) : dash}</td>
                <td class="rq-qty-text">${formatQty(row.qty)}</td>
                <td>${it?.satuan ? esc(it.satuan) : dash}</td>
                <td>${fotoHtml(it?.photo_path)}</td>
                <td></td>
            </tr>`;
    }
    return `
        <tr data-i="${i}">
            <td><input type="text" class="rq-cell-input kode-input" value="${esc(row.text)}" placeholder="Kode / nama" autocomplete="off" autocapitalize="characters"></td>
            <td class="rq-nama nama-out">${it?.nama_barang ? esc(it.nama_barang) : ""}</td>
            <td><input type="text" class="rq-cell-input qty-input" inputmode="numeric" value="${row.qty ? formatInt(row.qty) : ""}" autocomplete="off"></td>
            <td class="satuan-out">${it?.satuan ? esc(it.satuan) : ""}</td>
            <td class="foto-out">${it ? fotoHtml(it.photo_path) : ""}</td>
            <td><button type="button" class="rq-row-del" aria-label="Hapus baris"><i class="fa-solid fa-trash"></i></button></td>
        </tr>`;
}

function renderRows() {
    const tbody = $("rqTbody");
    if (R.rows.length === 0) {
        tbody.innerHTML = `<tr class="rq-placeholder"><td colspan="6">Tidak ada barang.</td></tr>`;
        return;
    }
    tbody.innerHTML = R.rows.map((r, i) => buildRowHtml(i, r)).join("");
}

// Pastikan ada tepat satu baris kosong di akhir (jika belum penuh)
function ensureTrailingEmptyRow(skipDom) {
    if (R.mode !== "add" && R.mode !== "edit") return;
    const last = R.rows[R.rows.length - 1];
    if (R.rows.length >= MAX_ROWS) return;
    if (!last || !rowIsEmpty(last)) {
        const row = makeEmptyRow();
        R.rows.push(row);
        if (!skipDom) $("rqTbody").insertAdjacentHTML("beforeend", buildRowHtml(R.rows.length - 1, row));
    }
}

function onQtyInput(i, el) {
    const row = R.rows[i];
    const digits = el.value.replace(/\D/g, "");
    row.qty = digits === "" ? null : Number(digits);
    el.value = row.qty === null ? "" : formatInt(row.qty);
    ensureTrailingEmptyRow();
}

function removeRow(i) {
    R.rows.splice(i, 1);
    if (R.rows.length === 0) R.rows.push(makeEmptyRow());
    ensureTrailingEmptyRow(true);
    hideSuggest();
    renderRows();
}

// ===================================================
// KELOMPOK 11: MODAL - PENCARIAN KODE BARANG (AUTOSEARCH)
// Fungsi: saat mengetik, muncul saran "KODE - Nama Barang" dari data_barang
// (barang aktif, tersedia di cabang ini). Kode yang SUDAH ada di baris lain
// tidak ditampilkan lagi, sehingga tidak ada kode barang ganda.
// ===================================================
function onKodeInput(i, inputEl) {
    const row = R.rows[i];
    row.text = inputEl.value;
    if (row.item) {                         // teks diubah -> pilihan lama dibatalkan
        row.item = null;
        const tr = getTr(i);
        tr.querySelector(".nama-out").textContent = "";
        tr.querySelector(".satuan-out").textContent = "";
        tr.querySelector(".foto-out").innerHTML = "";
    }
    ensureTrailingEmptyRow();

    clearTimeout(suggest.timer);
    const term = row.text.trim();
    if (!term) { hideSuggest(); return; }
    suggest.timer = setTimeout(() => runSuggest(i, term, inputEl), 250);
}

async function runSuggest(i, term, inputEl) {
    const myReq = ++suggest.reqId;
    const branchId = R.mode === "edit" ? R.card.branch_id : getUser()?.branchId;
    try {
        const safe = term.replace(/[\\"]/g, "\\$&");
        const pattern = `"%${safe}%"`;
        const { data, error } = await ga().from("data_barang")
            .select("kode_barang, nama_barang, satuan, photo_path, kategori_barang_id, is_makassar, is_surabaya")
            .eq("is_active", true)
            .or(`kode_barang.ilike.${pattern},nama_barang.ilike.${pattern}`)
            .order("kode_barang", { ascending: true })
            .limit(SUGGEST_LIMIT * 3);
        if (myReq !== suggest.reqId) return;
        if (error) throw error;

        let items = data || [];
        const flagCol = BRANCH_FLAG_COLUMN[branchId];
        if (BATASI_BARANG_PER_CABANG && flagCol) items = items.filter(x => x[flagCol] !== false);

        const taken = new Set(R.rows.filter((r, idx) => idx !== i && r.item).map(r => r.item.kode_barang));
        const hiddenCount = items.filter(x => taken.has(x.kode_barang)).length;
        suggest.items = items.filter(x => !taken.has(x.kode_barang)).slice(0, SUGGEST_LIMIT);
        suggest.active = suggest.items.length ? 0 : -1;
        suggest.rowIdx = i;
        showSuggest(inputEl, hiddenCount);
    } catch (err) {
        if (myReq !== suggest.reqId) return;
        console.error("Gagal mencari barang:", err);
        suggest.items = []; suggest.rowIdx = i;
        showSuggest(inputEl, 0, "Gagal mencari barang: " + err.message);
    }
}

function showSuggest(inputEl, hiddenCount, errorText) {
    const box = suggest.box;
    const rect = inputEl.getBoundingClientRect();
    const width = Math.min(window.innerWidth - 16, 340);
    box.style.width = `${width}px`;
    box.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;

    // Tampil di bawah kolom; jika tidak muat (keyboard / dasar layar), tampil di atas
    const spaceBelow = window.innerHeight - rect.bottom;
    if (spaceBelow < 180 && rect.top > spaceBelow) {
        box.style.top = "auto";
        box.style.bottom = `${window.innerHeight - rect.top + 2}px`;
    } else {
        box.style.bottom = "auto";
        box.style.top = `${rect.bottom + 2}px`;
    }

    let html = suggest.items.length === 0
        ? `<div class="rq-suggest-note">${esc(errorText || "Tidak ada barang yang cocok.")}</div>`
        : suggest.items.map((x, k) => `
            <div class="rq-suggest-item ${k === suggest.active ? "active" : ""}" data-k="${k}">
                <b>${esc(x.kode_barang)}</b> &mdash; ${esc(x.nama_barang || "-")}
            </div>`).join("");
    if (hiddenCount > 0) html += `<div class="rq-suggest-note">${hiddenCount} barang tidak ditampilkan karena sudah ada di daftar.</div>`;
    box.innerHTML = html;
    box.style.display = "block";
}
function hideSuggest() {
    if (!suggest.box) return;
    suggest.box.style.display = "none";
    suggest.items = [];
    suggest.active = -1;
}
function moveSuggest(step) {
    if (!suggest.items.length) return;
    suggest.active = (suggest.active + step + suggest.items.length) % suggest.items.length;
    suggest.box.querySelectorAll(".rq-suggest-item").forEach((el, k) => el.classList.toggle("active", k === suggest.active));
}

function pickSuggestion(k) {
    const item = suggest.items[k];
    const i = suggest.rowIdx;
    if (!item || i < 0 || !R.rows[i]) return;

    // Pengaman duplikasi: kode yang sama tidak boleh ada di baris lain
    if (R.rows.some((r, idx) => idx !== i && r.item && r.item.kode_barang === item.kode_barang)) {
        showToast(`Barang ${item.kode_barang} sudah ada di daftar.`);
        hideSuggest();
        return;
    }

    const row = R.rows[i];
    row.item = item; row.text = item.kode_barang;

    const tr = getTr(i);
    tr.classList.remove("invalid");
    tr.querySelector(".kode-input").value = item.kode_barang;
    tr.querySelector(".nama-out").textContent = item.nama_barang || "";
    tr.querySelector(".satuan-out").textContent = item.satuan || "";
    tr.querySelector(".foto-out").innerHTML = fotoHtml(item.photo_path);

    hideSuggest();
    ensureTrailingEmptyRow();
    tr.querySelector(".qty-input").focus();
}

// ===================================================
// KELOMPOK 12: VALIDASI & SIMPAN
// Fungsi: memeriksa isian lalu mengirim SEMUA barang dalam satu panggilan
// fungsi database. Jika satu barang saja bermasalah, tidak ada yang tersimpan.
// Database memeriksa ulang semua aturan (termasuk kode barang ganda).
// Data di belakang layar: pemohon = NIK sesi; cabang, departemen, area dari
// sesi; status "Diajukan"; is_active true; kategori dari data_barang.
// ===================================================
function collectUsedRows() {
    document.querySelectorAll("#rqTbody tr.invalid").forEach(tr => tr.classList.remove("invalid"));
    const errs = [];
    const used = [];
    R.rows.forEach((r, i) => { if (!rowIsEmpty(r)) used.push({ r, i }); });
    if (used.length === 0) errs.push({ msg: "Isi minimal satu barang." });

    const seen = new Map();
    used.forEach(({ r, i }) => {
        const msgs = [];
        if (!r.item) msgs.push("pilih kode barang dari daftar saran");
        if (!r.qty || r.qty <= 0) msgs.push("qty harus lebih dari 0");
        if (r.item) {
            if (seen.has(r.item.kode_barang)) msgs.push(`kode ${r.item.kode_barang} sama dengan baris ${seen.get(r.item.kode_barang) + 1}`);
            else seen.set(r.item.kode_barang, i);
        }
        if (msgs.length) errs.push({ idx: i, msg: `Baris ${i + 1}: ${msgs.join(", ")}.` });
    });
    return { used, errs };
}

function showErrors(errs) {
    errs.forEach(e => { if (e.idx != null) getTr(e.idx)?.classList.add("invalid"); });
    const shown = errs.slice(0, 6).map(e => e.msg).join("\n");
    showMsg(`Belum bisa disimpan. Perbaiki dulu:\n${shown}${errs.length > 6 ? `\n...dan ${errs.length - 6} masalah lain.` : ""}`, "danger");
}

async function saveAdd() {
    if (R.saving) return;
    showMsg("", "");
    const u = getUser();
    const miss = missingUserFields(u);
    if (miss.length) { showMsg(`Data sesi belum lengkap (${miss.join(", ")}). Hubungi admin.`, "danger"); return; }

    const periode = $("rqPeriode").value;
    const { used, errs } = collectUsedRows();
    if (!R.info) errs.unshift({ msg: "Form belum siap. Tutup lalu buka kembali." });
    if (!periode) errs.unshift({ msg: "Pilih Periode Permintaan." });
    if (errs.length) { showErrors(errs); return; }

    const payload = {
        branch_id: u.branchId,
        department_id: u.departmentId,
        area_id: u.areaId,
        pemohon: u.nik,
        periode,
        items: used.map(({ r }) => ({ kode_barang: r.item.kode_barang, qty: r.qty }))
    };

    const btn = $("rqBtnSimpan");
    R.saving = true;
    setBusy(btn, true, "Menyimpan...");
    try {
        const { data, error } = await ga().rpc("simpan_request", { p: payload });
        if (error) throw error;
        closeModal();
        showToast(`Permintaan tersimpan: ${data?.kode_batch || ""}`);
        loadList(true);
    } catch (err) {
        console.error("Gagal menyimpan permintaan:", err);
        showMsg(`Tidak ada data yang tersimpan.\n${err.message}`, "danger");
    } finally {
        R.saving = false;
        setBusy(btn, false);
    }
}

async function saveEdit() {
    if (R.saving) return;
    showMsg("", "");
    const u = getUser();
    if (!u || !u.nik) { showMsg("Sesi login tidak ditemukan. Silakan login ulang.", "danger"); return; }

    const periode = $("rqPeriode").value;
    const { used, errs } = collectUsedRows();
    if (!periode) errs.unshift({ msg: "Pilih Periode Permintaan." });
    if (errs.length) { showErrors(errs); return; }

    // Tidak ada perubahan? (periode dan isi barang sama)
    const asKey = (rows) => rows.map(r => `${r.item.kode_barang}:${r.qty}`).sort().join("|");
    if (periode === (R.card.periode_permintaan || "") && asKey(used.map(x => x.r)) === asKey(R.origRows)) {
        showToast("Tidak ada perubahan.");
        backToView();
        return;
    }

    const payload = {
        id: R.card.id,
        pemohon: u.nik,
        periode,
        items: used.map(({ r }) => ({ kode_barang: r.item.kode_barang, qty: r.qty }))
    };

    const btn = $("rqBtnSimpan");
    R.saving = true;
    setBusy(btn, true, "Menyimpan...");
    try {
        const { data, error } = await ga().rpc("ubah_request", { p: payload });
        if (error) throw error;
        const wasApproved = R.card.status === "Disetujui";
        closeModal();
        showToast(data?.changed === false
            ? "Tidak ada perubahan."
            : (wasApproved ? "Perubahan tersimpan. Status kembali menjadi Diajukan." : "Perubahan tersimpan."));
        loadList(true);
    } catch (err) {
        console.error("Gagal menyimpan perubahan:", err);
        showMsg(`Tidak ada perubahan yang tersimpan.\n${err.message}`, "danger");
    } finally {
        R.saving = false;
        setBusy(btn, false);
    }
}