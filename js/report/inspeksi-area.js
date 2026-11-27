// ===================================================
// inspeksi.js
// PWA - halaman "Inspeksi" (petugas mencatat temuan)
// Tulis: opr.inspeksi (+ foto ke Storage bucket "laporan-inspeksi")
// Baca : opr.inspeksi (hanya milik petugas yang login), opr.kategori_inspeksi,
//        opr.sub_kategori_inspeksi, public.areas, hrd.employees
// WAJIB: jalankan inspeksi.sql (grant & policy) di Supabase terlebih dulu.
// ===================================================

// ===================================================
// KELOMPOK 1: PENGATURAN (KONFIGURASI)
// Fungsi: nilai tetap yang dipakai di seluruh file.
// ===================================================
// Koneksi Supabase dari js/supabase.js (dibaca ulang saat halaman siap, lihat Kelompok 5)
let supabaseClient = window.supabaseClient;

const SCHEMA_OPR = "opr";
const SCHEMA_HRD = "hrd";
const TABLE_INSPEKSI = "inspeksi";
const TABLE_KATEGORI = "kategori_inspeksi";
const TABLE_SUB = "sub_kategori_inspeksi";
const TABLE_EMPLOYEES = "employees";   // hrd.employees: nik_karyawan -> id (uuid) yang disimpan di inspeksi.petugas
const TABLE_AREA = "areas";            // schema default (public), sama seperti halaman lain
const TABLE_PELANGGARAN = "pelanggaran";   // Temuan Individu menghasilkan 1 baris Peringatan Lisan di sini
const TABLE_DEPT = "departments";
// PERLU DICEK: tabel penempatan karyawan (sama dengan halaman Pelanggaran): cabang, departemen, area, bagian karyawan
const SCHEMA_ASSIGNMENT = SCHEMA_HRD;
const TABLE_ASSIGNMENT = "employee_assignments";
const LISAN_LABEL = "Peringatan Lisan";    // nilai jenis_peringatan untuk Temuan Individu
const ROLE_IDS_ALL_EMP = [1, 2, 3];        // cari karyawan: semua karyawan aktif. Role lain: hanya departemen yang sama
const ID_CHUNK = 100;

const SESSION_KEY = "pwa_mobile_session";   // key sesi login PWA (JSON)
// Nama field di sesi. Skrip mencari field pertama yang ada.
// "username" dipakai sebagai NIK karena sesi Anda tidak punya field nik (sama seperti permintaan-barang.js).
const SESSION_FIELDS = {
    nik: ["nik", "nik_karyawan", "username"],
    branch: ["branchId", "branch_id"],
    department: ["depId", "deptId", "dept_id", "department_id"]
};   // area TIDAK dibaca dari sesi: area dipilih petugas di form

const PHOTO_BUCKET = "laporan-inspeksi";
const PHOTO_COLUMNS = ["photo_path_1", "photo_path_2", "photo_path_3", "photo_path_4", "photo_path_5"];
const MAX_PHOTOS = 5;                  // jumlah kotak foto
const MIN_PHOTOS = 1;                  // minimal foto yang wajib diisi
const PHOTO_MAX_SIDE = 1280;           // sisi terpanjang foto (piksel) setelah dikecilkan
const PHOTO_QUALITY = 0.7;             // kualitas JPEG (0-1)
const PHOTO_CAPTURE_ONLY = false;      // true = langsung buka kamera (tanpa galeri); false = boleh pilih dari galeri
const SIGNED_URL_SECONDS = 3600;       // masa berlaku link foto (bucket private)

const LOCATION_TIMEOUT_MS = 12000;     // batas waktu menunggu GPS
const LOCATION_REQUIRED = false;       // true = Simpan DIBLOKIR jika GPS gagal; false = petugas ditanya, boleh simpan tanpa lokasi

const PAGE_SIZE = 30;                  // jumlah kartu per pemuatan
const EDIT_MAX_DAYS_BACK = 1;          // batas edit: H-1 = data yang dibuat hari ini atau kemarin (zona waktu cabang)

// Zona waktu per cabang (tanggal kartu mengikuti cabang data)
const DEFAULT_BRANCH = 1;
const BRANCH_TZ = { 1: "Asia/Jakarta", 2: "Asia/Makassar" };

// ===================================================
// KELOMPOK 2: STATE (DATA SEMENTARA DI MEMORI)
// ===================================================
const S = {
    employeeId: null,                  // hrd.employees.id (uuid) milik user login
    kategori: [], sub: [],             // master kategori & sub kategori (semua)
    areaList: [],                      // semua area (id, nama, cabang, aktif)
    kategoriMap: new Map(), subMap: new Map(), areaMap: new Map(),
    cards: [], offset: 0, total: 0, loading: false, reqId: 0,
    mode: null,                        // "add" | "view"
    card: null,
    photos: new Array(MAX_PHOTOS).fill(null),   // tiap kotak: { blob, url } atau null
    pendingSlot: -1,
    saving: false,
    detailReq: 0,
    // --- Temuan Individu ---
    roleId: null, sessionDept: null, restrictDept: true,
    deptMap: new Map(),
    human: false,                      // false = Temuan Team, true = Temuan Individu (kolom is_human)
    ket: false,                        // Keterangan Tambahan? (Ya = deskripsi pelanggaran diisi sendiri)
    emp: null,                         // karyawan terpilih { id, nik, nama, asg }
    partial: null                      // { base, inspeksi } jika temuan tersimpan tetapi Peringatan Lisan gagal
};

// ===================================================
// KELOMPOK 3: FUNGSI BANTU (HELPER)
// ===================================================
const $ = (id) => document.getElementById(id);

// Mengamankan teks sebelum dimasukkan ke HTML
function esc(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const HARI = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
const BULAN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

// Waktu UTC dari database -> "Senin, 09 Nov 2026 - 09:36" di zona waktu cabang
function formatWaktu(iso, branchId) {
    if (!iso) return "-";
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: BRANCH_TZ[branchId] || BRANCH_TZ[DEFAULT_BRANCH],
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(new Date(iso));
    const p = {};
    parts.forEach(x => { p[x.type] = x.value; });
    const hari = HARI[new Date(Number(p.year), Number(p.month) - 1, Number(p.day)).getDay()];
    return `${hari}, ${p.day} ${BULAN[Number(p.month) - 1]} ${p.year} - ${p.hour}:${p.minute}`;
}

function showToast(text) {
    const t = $("insToast");
    t.textContent = text;
    t.style.display = "block";
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { t.style.display = "none"; }, 3500);
}
function showMsg(text, type) {
    const el = $("insMsg");
    if (!text) { el.hidden = true; el.textContent = ""; return; }
    el.className = `ins-msg ${type || "danger"}`;
    el.textContent = text;
    el.hidden = false;
    $("insBody").scrollTop = 0;
}
function setBusy(btn, busy, busyText) {
    if (busy) {
        if (!btn.dataset.origHtml) btn.dataset.origHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${busyText}`;
    } else {
        btn.disabled = false;
        if (btn.dataset.origHtml) btn.innerHTML = btn.dataset.origHtml;
    }
}

// Mengambil SEMUA baris dari satu query bertahap per 1000 baris
async function fetchAll(buildQuery) {
    const out = [];
    for (let from = 0; ; from += 1000) {
        const { data, error } = await buildQuery(from, from + 999);
        if (error) throw error;
        out.push(...(data || []));
        if (!data || data.length < 1000) break;
    }
    return out;
}

function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ===================================================
// KELOMPOK 4: SESI LOGIN
// Fungsi: membaca pwa_mobile_session. Dibutuhkan: NIK (username), branch_id,
// dan dept_id (depId). Jika ada yang kosong, pembuatan inspeksi
// dinonaktifkan dengan pesan yang menyebut field mana yang kosong.
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
        deptId: toInt(findField(s, SESSION_FIELDS.department)),
        roleId: toInt(s.roleId)
    };
}

function missingUserFields(u) {
    if (!u) return ["sesi login"];
    const miss = [];
    if (!u.nik) miss.push("nik");
    if (u.branchId === null) miss.push("branch_id");
    if (u.deptId === null) miss.push("dept_id");
    return miss;
}

// NIK -> id karyawan (uuid). Kolom inspeksi.petugas berisi id ini, bukan NIK.
async function resolveEmployeeId(nik) {
    const { data, error } = await supabaseClient.schema(SCHEMA_HRD).from(TABLE_EMPLOYEES)
        .select("id").eq("nik_karyawan", nik).limit(1);
    if (error) throw error;
    return data && data.length ? data[0].id : null;
}

// ===================================================
// KELOMPOK 5: INISIALISASI
// Fungsi: dijalankan saat halaman selesai dimuat. Memeriksa koneksi & sesi,
// mencari id karyawan, memuat master kategori, lalu daftar kartu.
// ===================================================
function failPage(message) {
    $("btnBuat").disabled = true;
    $("inspeksiList").innerHTML = `<div class="ins-empty">${esc(message)}</div>`;
}

document.addEventListener("DOMContentLoaded", async () => {
    supabaseClient = window.supabaseClient || supabaseClient;
    setupModal();
    $("btnBuat").addEventListener("click", openAddModal);

    if (!supabaseClient) {
        failPage("Koneksi database tidak tersedia (supabase.js tidak termuat). Periksa path <script> di inspeksi.html.");
        return;
    }
    const u = getUser();
    if (!u || !u.nik) { failPage("Sesi login tidak ditemukan. Silakan login ulang."); return; }
    console.info("[Inspeksi] nik:", u.nik, "| cabang:", u.branchId, "| dept:", u.deptId, "| role:", u.roleId);
    S.roleId = u.roleId;
    S.sessionDept = u.deptId;
    S.restrictDept = !ROLE_IDS_ALL_EMP.includes(S.roleId);

    try {
        S.employeeId = await resolveEmployeeId(u.nik);
    } catch (err) {
        console.error("Gagal membaca data karyawan:", err);
        failPage(`Gagal membaca data karyawan: ${err.message}`);
        return;
    }
    if (!S.employeeId) { failPage(`NIK ${u.nik} tidak ditemukan di data karyawan. Hubungi admin.`); return; }

    try {
        await loadLookups();
    } catch (err) {
        console.error("Gagal memuat data pendukung:", err);
        failPage(`Gagal memuat data pendukung: ${err.message}`);
        return;
    }
    const miss = missingUserFields(u);
    if (miss.length) $("btnBuat").title = `Data sesi belum lengkap: ${miss.join(", ")}`;
    loadList(true);
});

// Master kategori, sub kategori, dan area (kecil, dimuat sekali)
async function loadLookups() {
    const opr = () => supabaseClient.schema(SCHEMA_OPR);
    const [kat, sub, areas, depts] = await Promise.all([
        fetchAll((f, t) => opr().from(TABLE_KATEGORI).select("id, kategori_inspeksi, is_active, dept_id, jenis_pelanggaran_id").order("kategori_inspeksi").order("id").range(f, t)),
        fetchAll((f, t) => opr().from(TABLE_SUB).select("id, sub_kategori_inspeksi, is_active, kategori_inspeksi_id, dept_id").order("sub_kategori_inspeksi").order("id").range(f, t)),
        fetchAll((f, t) => supabaseClient.from(TABLE_AREA).select("id, area_name, branch_id, is_active").order("area_name").order("id").range(f, t)),
        fetchAll((f, t) => supabaseClient.from(TABLE_DEPT).select("id, department_name").order("id").range(f, t))
    ]);
    S.kategori = kat;
    S.sub = sub;
    S.kategoriMap = new Map(kat.map(k => [String(k.id), k.kategori_inspeksi]));
    S.subMap = new Map(sub.map(x => [String(x.id), x.sub_kategori_inspeksi]));
    S.deptMap = new Map(depts.map(d => [String(d.id), d.department_name]));
    S.areaList = areas;
    S.areaMap = new Map(areas.map(a => [String(a.id), a.area_name]));
}

function areaName(id) {
    if (id === null || id === undefined) return "-";
    return S.areaMap.get(String(id)) || `Area ${id}`;
}

// ===================================================
// KELOMPOK 6: DAFTAR KARTU
// Fungsi: menampilkan inspeksi milik petugas yang login (petugas = id karyawan)
// sebagai kartu "Temuan, Tanggal, Area". Terbaru di paling atas.
// Dimuat bertahap (30 per kali). CATATAN: penyaringan "milik sendiri" di sini
// hanya di sisi aplikasi; pembatasan sebenarnya harus lewat RLS di database.
// ===================================================
const LIST_COLUMNS = "id, created_at, branch_id, dept_id, petugas, is_human, area_id, kategori_inspeksi_id, sub_kategori_inspeksi_id, deskripsi, lokasi, " + PHOTO_COLUMNS.join(", ");

async function loadList(reset) {
    if (!S.employeeId || S.loading) return;
    const myReq = ++S.reqId;
    S.loading = true;

    if (reset) {
        S.cards = []; S.offset = 0; S.total = 0;
        $("inspeksiList").innerHTML = `<div class="ins-loading"><i class="fa-solid fa-spinner fa-spin"></i> Memuat data...</div>`;
    } else {
        const btn = $("inspeksiList").querySelector(".ins-more");
        if (btn) { btn.disabled = true; btn.textContent = "Memuat..."; }
    }

    try {
        const { data, error, count } = await supabaseClient.schema(SCHEMA_OPR).from(TABLE_INSPEKSI)
            .select(LIST_COLUMNS, { count: "exact" })
            .eq("petugas", S.employeeId)
            .order("created_at", { ascending: false })
            .order("id", { ascending: false })
            .range(S.offset, S.offset + PAGE_SIZE - 1);
        if (myReq !== S.reqId) return;
        if (error) throw error;

        const rows = data || [];
        S.total = count || 0;
        S.cards.push(...rows);
        S.offset += rows.length;
        renderList(rows, reset);
    } catch (err) {
        if (myReq !== S.reqId) return;
        console.error("Gagal memuat inspeksi:", err);
        if (reset) $("inspeksiList").innerHTML = `<div class="ins-empty">Gagal memuat data: ${esc(err.message)}</div>`;
        else showToast("Gagal memuat data: " + err.message);
    } finally {
        if (myReq === S.reqId) S.loading = false;
    }
}

function cardHtml(c) {
    return `
        <div class="ins-card" data-id="${esc(c.id)}">
            <div class="ins-card-title">${esc(S.subMap.get(String(c.sub_kategori_inspeksi_id)) || "-")}</div>
            <div class="ins-card-meta"><i class="fa-regular fa-calendar"></i> ${esc(formatWaktu(c.created_at, c.branch_id))}</div>
            <div class="ins-card-meta"><i class="fa-solid fa-location-dot"></i> ${esc(areaName(c.area_id))}</div>
        </div>`;
}

function renderList(newRows, reset) {
    const box = $("inspeksiList");
    if (reset) box.innerHTML = "";
    box.querySelector(".ins-more")?.remove();

    if (S.cards.length === 0) {
        box.innerHTML = `<div class="ins-empty">Belum ada data inspeksi.</div>`;
        return;
    }
    box.insertAdjacentHTML("beforeend", newRows.map(cardHtml).join(""));
    if (S.cards.length < S.total) {
        box.insertAdjacentHTML("beforeend", `<button type="button" class="ins-more">Muat lebih banyak (${S.total - S.cards.length} lagi)</button>`);
    }
}

// Klik kartu / tombol "muat lebih banyak" (satu pendengar untuk semua kartu)
document.addEventListener("click", (e) => {
    if (e.target.closest(".ins-more")) { loadList(false); return; }
    const card = e.target.closest(".ins-card");
    if (card) {
        const c = S.cards.find(x => String(x.id) === card.dataset.id);
        if (c) openDetailModal(c);
    }
});

// ===================================================
// KELOMPOK 7: MODAL - PEMASANGAN TOMBOL & MODE
// Fungsi: tombol modal (termasuk Edit), kotak foto, dan pilihan Kategori -> Temuan.
// ===================================================
function setupModal() {
    $("insBtnX").addEventListener("click", closeModal);
    $("insBtnTutup").addEventListener("click", closeModal);
    $("insBtnBatal").addEventListener("click", () => { if (S.mode === "edit" && S.card) renderView(S.card); else closeModal(); });
    $("insBtnEdit").addEventListener("click", enterEdit);
    $("insBtnSimpan").addEventListener("click", () => { if (S.mode === "edit") saveEdit(); else saveAdd(); });
    $("insKategori").addEventListener("change", () => fillTemuanSelect($("insKategori").value));
    $("insFile").addEventListener("change", onFilePicked);
    // Toggle Temuan Team / Individu dan Keterangan Tambahan Ya / Tidak
    $("segHuman").addEventListener("click", (e) => { const b = e.target.closest(".ins-seg-btn"); if (b) setHuman(b.dataset.human === "true"); });
    $("segKet").addEventListener("click", (e) => { const b = e.target.closest(".ins-seg-btn"); if (b) setKet(b.dataset.ket === "true"); });
    // Pilih karyawan (pointerdown agar terpilih sebelum kolom kehilangan fokus)
    $("indEmpSearch").addEventListener("input", onEmpInput);
    $("indEmpClear").addEventListener("click", clearEmployee);
    $("indEmpList").addEventListener("pointerdown", (e) => {
        const item = e.target.closest(".ins-suggest-item[data-id]");
        if (!item || item.classList.contains("disabled")) return;
        e.preventDefault();
        chooseEmployee(empOptions.get(item.dataset.id));
    });
    document.addEventListener("click", (e) => { if (!e.target.closest(".ins-rel")) $("indEmpList").hidden = true; });
    if (PHOTO_CAPTURE_ONLY) $("insFile").setAttribute("capture", "environment");

    // Satu pendengar untuk semua kotak foto (tambah / hapus)
    $("insPhotoGrid").addEventListener("click", (e) => {
        if (S.mode !== "add" && S.mode !== "edit") return;
        const del = e.target.closest(".ins-slot-del");
        if (del) { removePhoto(parseInt(del.dataset.i, 10)); return; }
        const add = e.target.closest(".ins-slot-add");
        if (add) { S.pendingSlot = parseInt(add.dataset.i, 10); $("insFile").click(); }
    });
}

function openModalShell() {
    $("insModal").classList.add("open");
    document.body.style.overflow = "hidden";
}
function closeModal() {
    const hadPartial = !!S.partial;                    // temuan tersimpan tetapi Peringatan Lisan gagal
    S.partial = null;
    $("insBody").classList.remove("ins-locked");
    $("insModal").classList.remove("open");
    document.body.style.overflow = "";
    S.detailReq++;
    clearPhotos();
    S.mode = null;
    S.card = null;
    showMsg("", "");
    if (hadPartial) { showToast("Temuan tersimpan, tetapi Peringatan Lisan BELUM tersimpan."); loadList(true); }
}

// Mengatur tombol footer dan isian sesuai mode: add / view / edit
function applyModeUi() {
    const add = S.mode === "add", view = S.mode === "view";
    $("insTitle").textContent = add ? "Buat Inspeksi" : view ? "Detail Inspeksi" : "Edit Inspeksi";
    $("insAreaSel").hidden = view;   $("insArea").hidden = !view;
    $("insKategori").hidden = view;  $("insKategoriTxt").hidden = !view;
    $("insTemuan").hidden = view;    $("insTemuanTxt").hidden = !view;
    $("insDeskripsi").readOnly = view;
    $("wrapTanggal").hidden = !view;
    $("insBtnTutup").hidden = !view;
    $("insBtnEdit").hidden = true;                     // diatur renderView sesuai syarat
    $("insBtnBatal").hidden = view;
    $("insBtnSimpan").hidden = view;
    $("insEditHint").textContent = "";
    $("segHuman").hidden = !add;
    $("insJenisTxt").hidden = add;
    syncIndividuUi();
}

// ===================================================
// KELOMPOK 8: MODAL - BUAT INSPEKSI
// Fungsi: form kosong. Area DIPILIH petugas dari dropdown (hanya area aktif di
// cabang petugas, branch_id dari sesi). Kategori Temuan hanya yang AKTIF dan milik
// departemen petugas (dept_id dari sesi). Temuan hanya yang AKTIF di bawah kategori
// terpilih. Parameter "selectedId" dipakai mode Edit agar nilai lama tetap muncul
// walau sudah non aktif.
// ===================================================
function openAddModal() {
    const u = getUser();
    const miss = missingUserFields(u);
    if (miss.length) { showToast(`Data sesi belum lengkap (${miss.join(", ")}). Hubungi admin.`); return; }

    S.mode = "add";
    S.card = null;
    S.human = false; S.ket = false; S.emp = null; S.partial = null;
    $("insBody").classList.remove("ins-locked");
    $("indEmpSearch").value = "";
    $("indKet").value = "";
    $("indEmpList").hidden = true;
    clearPhotos();
    $("insDeskripsi").value = "";
    applyModeUi();
    fillAreaSelect(u.branchId, null);
    fillKategoriSelect(u.deptId, null);
    fillTemuanSelect("", null);
    $("wrapLokasi").hidden = true;
    renderPhotoGrid();
    $("insPhotoHint").textContent = `Minimal ${MIN_PHOTOS} foto, maksimal ${MAX_PHOTOS}. Lokasi GPS diambil otomatis saat Simpan.`;
    showMsg("", "");
    openModalShell();

    const warn = [];
    if ($("insAreaSel").options.length <= 1) warn.push("Belum ada area untuk cabang Anda.");
    if ($("insKategori").options.length <= 1) warn.push("Belum ada kategori temuan untuk departemen Anda.");
    if (warn.length) showMsg(`${warn.join("\n")}\nHubungi admin.`, "info");
}

// Dropdown Area: area aktif milik cabang (branch_id) petugas. Tidak ada pilihan awal.
function fillAreaSelect(branchId, selectedId) {
    let list = S.areaList.filter(a => String(a.branch_id) === String(branchId) && a.is_active !== false);
    const cur = selectedId ? S.areaList.find(a => String(a.id) === String(selectedId)) : null;
    if (cur && !list.includes(cur)) list = [cur, ...list];
    $("insAreaSel").innerHTML = `<option value="">Pilih Area</option>` +
        list.map(a => `<option value="${esc(a.id)}">${esc(a.area_name)}${a.is_active === false ? " (non aktif)" : ""}</option>`).join("");
    $("insAreaSel").value = selectedId ? String(selectedId) : "";
}

function fillKategoriSelect(deptId, selectedId) {
    let list = S.kategori.filter(k => k.is_active === true && String(k.dept_id) === String(deptId));
    // Temuan Individu: hanya kategori yang terhubung ke jenis pelanggaran (kolom jenis_pelanggaran_id terisi)
    if (S.mode === "add" && S.human) list = list.filter(k => k.jenis_pelanggaran_id !== null && k.jenis_pelanggaran_id !== undefined);
    const cur = selectedId ? S.kategori.find(k => String(k.id) === String(selectedId)) : null;
    if (cur && !list.includes(cur)) list = [cur, ...list];
    $("insKategori").innerHTML = `<option value="">Pilih Kategori Temuan</option>` +
        list.map(k => `<option value="${esc(k.id)}">${esc(k.kategori_inspeksi)}${k.is_active === true ? "" : " (non aktif)"}</option>`).join("");
    $("insKategori").value = selectedId ? String(selectedId) : "";
}

function fillTemuanSelect(kategoriId, selectedId) {
    const sel = $("insTemuan");
    if (!kategoriId) {
        sel.innerHTML = `<option value="">Pilih kategori dulu</option>`;
        sel.disabled = true;
        return;
    }
    let list = S.sub.filter(x => x.is_active === true && String(x.kategori_inspeksi_id) === String(kategoriId));
    const cur = selectedId ? S.sub.find(x => String(x.id) === String(selectedId)) : null;
    if (cur && String(cur.kategori_inspeksi_id) === String(kategoriId) && !list.includes(cur)) list = [cur, ...list];
    sel.innerHTML = list.length
        ? `<option value="">Pilih Temuan</option>` + list.map(x => `<option value="${esc(x.id)}">${esc(x.sub_kategori_inspeksi)}${x.is_active === true ? "" : " (non aktif)"}</option>`).join("")
        : `<option value="">Belum ada temuan untuk kategori ini</option>`;
    sel.value = selectedId && list.some(x => String(x.id) === String(selectedId)) ? String(selectedId) : "";
    sel.disabled = list.length === 0;
}

// ===================================================
// KELOMPOK 9: MODAL - DETAIL & EDIT
// Fungsi: klik kartu membuka isi temuan (hanya baca) beserta foto.
// Foto: mencoba signed URL (bucket private), jika gagal memakai public URL.
// Tombol "Edit" hanya muncul jika temuan milik petugas ini DAN tanggal dibuat
// masih dalam batas H-1 (hari ini atau kemarin, menurut zona waktu cabang;
// atur lewat EDIT_MAX_DAYS_BACK). Saat edit: area, kategori, temuan, deskripsi,
// dan foto bisa diubah. Lokasi GPS, cabang, departemen, dan petugas tetap.
// Database memeriksa ulang batas ini (lihat inspeksi.sql bagian 5).
// ===================================================
function dayKey(date, branchId) {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: BRANCH_TZ[branchId] || BRANCH_TZ[DEFAULT_BRANCH], year: "numeric", month: "2-digit", day: "2-digit"
    }).format(date);                                    // "2026-11-09"
}

// true jika tanggal dibuat (zona waktu cabang) tidak lebih dari EDIT_MAX_DAYS_BACK hari dari hari ini
function withinEditWindow(card) {
    const created = Date.parse(dayKey(new Date(card.created_at), card.branch_id));
    const today = Date.parse(dayKey(new Date(), card.branch_id));
    return (today - created) / 86400000 <= EDIT_MAX_DAYS_BACK;
}

function canEdit(card) {
    return !!S.employeeId && card.petugas === S.employeeId && withinEditWindow(card);
}

async function openDetailModal(card) {
    renderView(card);
    openModalShell();
}

// Menampilkan mode Detail (dipakai saat membuka kartu dan saat Batal dari Edit)
function renderView(card) {
    S.mode = "view";
    S.card = card;
    const myReq = ++S.detailReq;
    clearPhotos();
    applyModeUi();

    $("insTanggal").value = formatWaktu(card.created_at, card.branch_id);
    $("insArea").value = areaName(card.area_id);
    $("insKategoriTxt").value = S.kategoriMap.get(String(card.kategori_inspeksi_id)) || "-";
    $("insTemuanTxt").value = S.subMap.get(String(card.sub_kategori_inspeksi_id)) || "-";
    $("insDeskripsi").value = card.deskripsi || "";
    $("insJenisTxt").value = card.is_human ? "Temuan Individu" : "Temuan Team";
    $("insLokasi").value = card.lokasi || "";
    $("wrapLokasi").hidden = !card.lokasi;
    $("insPhotoHint").textContent = "";
    $("insPhotoGrid").innerHTML = "";
    $("insBtnEdit").hidden = !canEdit(card);
    $("insEditHint").textContent = canEdit(card) ? "" : `Data hanya dapat diedit sampai H-${EDIT_MAX_DAYS_BACK} (hari ini atau kemarin).`;
    showMsg("", "");
    loadViewPhotos(card, myReq);
}

async function loadViewPhotos(card, myReq) {
    const paths = PHOTO_COLUMNS.map(c => card[c]).filter(p => p && String(p).trim()).map(p => String(p).trim());
    if (paths.length === 0) { $("insPhotoHint").textContent = "Tidak ada foto pada temuan ini."; return; }
    $("insPhotoHint").textContent = "Memuat foto...";

    let urls = [];
    try { urls = await resolvePhotoUrls(paths); }
    catch (err) { console.error("Gagal memuat foto:", err); }
    if (myReq !== S.detailReq) return;                 // modal sudah ditutup / diganti

    const ok = urls.filter(Boolean);
    if (ok.length === 0) { $("insPhotoHint").textContent = "Foto gagal dimuat."; return; }
    $("insPhotoHint").textContent = "";
    $("insPhotoGrid").innerHTML = ok.map(u =>
        `<div class="ins-slot"><a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="Foto temuan" loading="lazy"></a></div>`).join("");
}

// Masuk mode Edit: isian terbuka dengan nilai lama, foto lama tampil di kotak
async function enterEdit() {
    const card = S.card;
    if (!card || S.mode !== "view" || !canEdit(card)) return;
    const btn = $("insBtnEdit");
    setBusy(btn, true, "Memuat...");

    const paths = PHOTO_COLUMNS.map(c => card[c]).filter(p => p && String(p).trim()).map(p => String(p).trim());
    let urls = [];
    try { urls = await resolvePhotoUrls(paths); }
    catch (err) { console.error("Gagal memuat foto:", err); }
    setBusy(btn, false);
    if (S.card !== card || S.mode !== "view") return;  // modal ditutup saat memuat

    // Jika foto lama gagal dimuat, edit dibatalkan agar foto tidak hilang saat disimpan
    if (paths.some((p, i) => !urls[i])) {
        showMsg("Foto lama gagal dimuat, jadi edit dibatalkan agar foto tidak hilang. Periksa koneksi lalu coba lagi.", "danger");
        return;
    }

    const u = getUser();
    S.detailReq++;                                     // hentikan pemuatan foto mode Detail
    clearPhotos();
    paths.forEach((p, i) => { S.photos[i] = { path: p, url: urls[i] }; });
    S.mode = "edit";
    applyModeUi();

    fillAreaSelect(card.branch_id, card.area_id);
    fillKategoriSelect(card.dept_id ?? (u && u.deptId), card.kategori_inspeksi_id);
    fillTemuanSelect($("insKategori").value, card.sub_kategori_inspeksi_id);
    $("insDeskripsi").value = card.deskripsi || "";
    renderPhotoGrid();
    $("insPhotoHint").textContent = `Minimal ${MIN_PHOTOS} foto, maksimal ${MAX_PHOTOS}. Lokasi GPS tetap seperti saat inspeksi dibuat.`;
    showMsg("", "");
}

// Mengubah path Storage menjadi URL yang bisa ditampilkan
async function resolvePhotoUrls(paths) {
    const bucket = supabaseClient.storage.from(PHOTO_BUCKET);
    const clean = paths.map(p => /^https?:\/\//i.test(p) ? p : p.replace(/^\/+/, ""));
    const out = clean.map(p => /^https?:\/\//i.test(p) ? p : null);
    const need = clean.filter((p, i) => out[i] === null);
    if (need.length) {
        const signed = new Map();
        try {
            const { data, error } = await bucket.createSignedUrls(need, SIGNED_URL_SECONDS);
            if (!error) (data || []).forEach(x => { if (x.signedUrl) signed.set(x.path, x.signedUrl); });
        } catch (err) { console.warn("Signed URL gagal, memakai public URL:", err); }
        clean.forEach((p, i) => {
            if (out[i] !== null) return;
            out[i] = signed.get(p) || bucket.getPublicUrl(p).data.publicUrl || null;
        });
    }
    return out;
}

// ===================================================
// KELOMPOK 10: FOTO TEMUAN (5 KOTAK)
// Fungsi: tiap kotak "+" membuka kamera/galeri. Foto langsung dikecilkan di
// browser (sisi terpanjang 1280 px, JPEG) agar upload cepat dan hemat kuota.
// Foto baru diunggah ke Storage saat tombol Simpan ditekan.
// ===================================================
function clearPhotos() {
    S.photos.forEach(p => { if (p && p.blob) URL.revokeObjectURL(p.url); });
    S.photos = new Array(MAX_PHOTOS).fill(null);
    S.pendingSlot = -1;
}

function renderPhotoGrid() {
    $("insPhotoGrid").innerHTML = S.photos.map((p, i) => p
        ? `<div class="ins-slot"><img src="${esc(p.url)}" alt="Foto ${i + 1}"><button type="button" class="ins-slot-del" data-i="${i}" aria-label="Hapus foto"><i class="fa-solid fa-xmark"></i></button></div>`
        : `<div class="ins-slot"><button type="button" class="ins-slot-add" data-i="${i}" aria-label="Tambah foto"><i class="fa-solid fa-plus"></i></button></div>`
    ).join("");
}

function removePhoto(i) {
    const p = S.photos[i];
    if (!p) return;
    if (p.blob) URL.revokeObjectURL(p.url);
    S.photos[i] = null;
    renderPhotoGrid();
}

async function onFilePicked(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";                               // supaya foto yang sama bisa dipilih ulang
    const i = S.pendingSlot;
    S.pendingSlot = -1;
    if (!file || i < 0 || (S.mode !== "add" && S.mode !== "edit")) return;
    if (!/^image\//i.test(file.type)) { showToast("File harus berupa gambar."); return; }

    try {
        const blob = await compressImage(file);
        if (S.mode !== "add" && S.mode !== "edit") return;   // modal ditutup saat memproses
        if (S.photos[i] && S.photos[i].blob) URL.revokeObjectURL(S.photos[i].url);
        S.photos[i] = { blob, url: URL.createObjectURL(blob) };
        renderPhotoGrid();
    } catch (err) {
        console.error("Gagal memproses foto:", err);
        showToast("Foto tidak bisa diproses. Coba foto lain.");
    }
}

// Mengecilkan foto dan mengubahnya menjadi JPEG
async function compressImage(file) {
    let src;
    try { src = await createImageBitmap(file, { imageOrientation: "from-image" }); }
    catch (err) {
        src = await new Promise((resolve, reject) => {
            const img = new Image();
            const url = URL.createObjectURL(file);
            img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Gambar tidak terbaca")); };
            img.src = url;
        });
    }
    const w0 = src.width || src.naturalWidth, h0 = src.height || src.naturalHeight;
    const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(w0, h0));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w0 * scale);
    canvas.height = Math.round(h0 * scale);
    canvas.getContext("2d").drawImage(src, 0, 0, canvas.width, canvas.height);
    if (src.close) src.close();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", PHOTO_QUALITY));
    if (!blob) throw new Error("Gagal membuat JPEG");
    return blob;
}

// ===================================================
// KELOMPOK 11: LOKASI GPS
// Fungsi: dibaca saat Simpan. Hasil disimpan di kolom lokasi sebagai
// "latitude,longitude" (contoh: -7.250000,112.750000), format yang dibaca
// peta di laporan-inspeksi. Null jika ditolak / gagal / terlalu lama.
// ===================================================
function getLocation() {
    return new Promise((resolve) => {
        if (!navigator.geolocation) { resolve(null); return; }
        navigator.geolocation.getCurrentPosition(
            (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
            () => resolve(null),
            { enableHighAccuracy: true, timeout: LOCATION_TIMEOUT_MS, maximumAge: 30000 }
        );
    });
}

// ===================================================
// KELOMPOK 12: VALIDASI & SIMPAN
// Urutan: validasi -> ambil GPS -> unggah foto -> simpan baris inspeksi.
// Jika simpan baris gagal, foto yang sudah terunggah dihapus (upaya terbaik).
// Data di belakang layar: branch_id dan dept_id dari sesi (area dipilih petugas);
// petugas = id karyawan (hrd.employees.id) dari NIK sesi; lokasi dari GPS.
// ===================================================
function validateForm() {
    const errs = [];
    if (!$("insAreaSel").value) errs.push("Pilih Area.");
    if (!$("insKategori").value) errs.push("Pilih Kategori Temuan.");
    if (!$("insTemuan").value) errs.push("Pilih Temuan.");
    if (!$("insDeskripsi").value.trim()) errs.push("Isi Deskripsi Temuan.");
    const nFoto = S.photos.filter(Boolean).length;
    if (nFoto < MIN_PHOTOS) errs.push(`Tambahkan minimal ${MIN_PHOTOS} foto temuan.`);
    if (S.mode === "add" && S.human) {                 // Temuan Individu
        if (!S.emp) errs.push("Pilih Nama Karyawan (Temuan Individu).");
        const kat = S.kategori.find(k => String(k.id) === $("insKategori").value);
        if (kat && (kat.jenis_pelanggaran_id === null || kat.jenis_pelanggaran_id === undefined)) {
            errs.push("Kategori Temuan ini belum terhubung ke jenis pelanggaran, jadi tidak bisa dipakai untuk Temuan Individu.");
        }
        if (S.ket && !$("indKet").value.trim()) errs.push("Isi Deskripsi Pelanggaran (Keterangan Tambahan = Ya).");
    }
    return errs;
}

async function uploadPhoto(blob, branchId) {
    const d = new Date();
    const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
    const path = `${branchId}/${ym}/${uuid()}.jpg`;
    const { error } = await supabaseClient.storage.from(PHOTO_BUCKET).upload(path, blob, { contentType: "image/jpeg", upsert: false });
    if (error) throw error;
    return path;
}

async function saveAdd() {
    if (S.saving || S.mode !== "add") return;
    if (S.partial) { await retryPelanggaran(); return; }   // temuan sudah tersimpan: ulangi Peringatan Lisan saja
    showMsg("", "");
    const u = getUser();
    const miss = missingUserFields(u);
    if (miss.length) { showMsg(`Data sesi belum lengkap (${miss.join(", ")}). Hubungi admin.`, "danger"); return; }
    if (!S.employeeId) { showMsg("Data karyawan tidak ditemukan. Hubungi admin.", "danger"); return; }

    const errs = validateForm();
    if (errs.length) { showMsg(`Belum bisa disimpan. Perbaiki dulu:\n${errs.join("\n")}`, "danger"); return; }

    const btn = $("insBtnSimpan");
    S.saving = true;
    setBusy(btn, true, "Mengambil lokasi...");
    const uploaded = [];
    let inserted = false;

    try {
        // 1) Lokasi GPS
        const loc = await getLocation();
        if (!loc) {
            if (LOCATION_REQUIRED) throw new Error("Lokasi GPS tidak terbaca. Aktifkan GPS dan izinkan akses lokasi, lalu coba lagi.");
            if (!confirm("Lokasi GPS tidak terbaca.\nSimpan temuan tanpa lokasi?")) return;
        }

        // 2) Unggah foto (paralel). Kotak kosong dilewati sehingga kolom foto terisi berurutan.
        setBusy(btn, true, "Mengunggah foto...");
        const files = S.photos.filter(Boolean);
        const results = await Promise.allSettled(files.map(p => uploadPhoto(p.blob, u.branchId)));
        results.forEach(r => { if (r.status === "fulfilled") uploaded.push(r.value); });
        const failed = results.find(r => r.status === "rejected");
        if (failed) throw new Error("Gagal mengunggah foto: " + (failed.reason?.message || failed.reason));

        // 3) Simpan baris inspeksi. Temuan Individu: ambil id & tanggal baris untuk Peringatan Lisan.
        setBusy(btn, true, "Menyimpan...");
        const individu = S.human;
        const base = individu ? buildPelanggaranBase() : null;    // isian Peringatan Lisan dibekukan sebelum menyimpan
        const payload = {
            branch_id: u.branchId,
            dept_id: u.deptId,
            area_id: parseInt($("insAreaSel").value, 10),
            petugas: S.employeeId,
            kategori_inspeksi_id: parseInt($("insKategori").value, 10),
            sub_kategori_inspeksi_id: parseInt($("insTemuan").value, 10),
            deskripsi: $("insDeskripsi").value.trim(),
            is_human: individu,
            lokasi: loc ? `${loc.lat.toFixed(6)},${loc.lng.toFixed(6)}` : null
        };
        PHOTO_COLUMNS.forEach((col, i) => { payload[col] = uploaded[i] || null; });

        let q = supabaseClient.schema(SCHEMA_OPR).from(TABLE_INSPEKSI).insert(payload);
        if (individu) q = q.select("id, created_at");
        const { data, error } = await q;
        if (error) throw error;
        inserted = true;

        if (!individu) {
            closeModal();
            showToast("Inspeksi tersimpan.");
            loadList(true);
            return;
        }

        // 4) Temuan Individu: simpan Peringatan Lisan (opr.pelanggaran) yang terhubung ke inspeksi ini
        const row = data && data[0];
        if (!row) {
            closeModal();
            showToast("Temuan tersimpan, tetapi Peringatan Lisan GAGAL dibuat: id inspeksi tidak terbaca (butuh izin SELECT di opr.inspeksi). Hubungi admin.");
            loadList(true);
            return;
        }
        S.partial = { base, inspeksi: row };
        await finishPelanggaran();
    } catch (err) {
        console.error("Gagal menyimpan inspeksi:", err);
        if (!inserted && uploaded.length) {
            // Bersihkan foto yatim (jika izin hapus tidak ada, langkah ini diam-diam gagal)
            supabaseClient.storage.from(PHOTO_BUCKET).remove(uploaded).catch(() => {});
        }
        showMsg(`Tidak ada data yang tersimpan.\n${err.message}`, "danger");
    } finally {
        S.saving = false;
        setBusy(btn, false);
    }
}

// ===================================================
// KELOMPOK 12B: TEMUAN INDIVIDU (PERINGATAN LISAN)
// Fungsi: toggle Temuan Team / Individu, pilih karyawan, Keterangan Tambahan, dan
// penyimpanan 1 baris di opr.pelanggaran untuk karyawan itu.
// Isian di belakang layar (sama dengan Surat Peringatan): branch_id, dept_id, area_id,
// bagian_id dari penempatan aktif KARYAWAN; petugas = karyawan login; employee_id &
// nik_karyawan = karyawan yang dituju; is_active = true. Tambahan khusus:
//   inspeksi_id = id baris inspeksi (FK)    jenis_peringatan = "Peringatan Lisan"
//   jenis_pelanggaran_id = dari kategori temuan terpilih (kategori_inspeksi.jenis_pelanggaran_id)
//   start_date = tanggal inspeksi (menurut zona waktu cabang)    end_date = start_date
//   deskripsi = isian Keterangan Tambahan (jika "Ya"), jika tidak = Deskripsi Temuan
// Penyimpanan inspeksi dan pelanggaran adalah 2 langkah terpisah. Jika langkah ke-2
// gagal, temuan tetap tersimpan, isian dikunci, dan tombol Simpan mengulang langkah ke-2 saja.
// ===================================================
let empTimer = null;
let empReq = 0;
const empOptions = new Map();

function sanitizeSearch(text) { return String(text || "").replace(/[,()*%\\]/g, " ").replace(/\s+/g, " ").trim(); }

// Menyesuaikan tampilan blok Temuan Individu dengan status S.human / S.ket / S.emp
function syncIndividuUi() {
    const add = S.mode === "add";
    $("wrapIndividu").hidden = !(add && S.human);
    $("indEmpSearch").hidden = !!S.emp;
    $("indEmpChosen").hidden = !S.emp;
    $("wrapKet").hidden = !S.ket;
    $("indKetHint").hidden = S.ket;
    $("segHuman").querySelectorAll(".ins-seg-btn").forEach(b => b.classList.toggle("active", (b.dataset.human === "true") === S.human));
    $("segKet").querySelectorAll(".ins-seg-btn").forEach(b => b.classList.toggle("active", (b.dataset.ket === "true") === S.ket));
}

function setHuman(v) {
    if (S.saving || S.partial || S.mode !== "add") return;
    S.human = v;
    const u = getUser();
    fillKategoriSelect(u ? u.deptId : null, null);     // Temuan Individu: hanya kategori yang terhubung ke jenis pelanggaran
    fillTemuanSelect("", null);
    syncIndividuUi();
    showMsg("", "");
    if (v && $("insKategori").options.length <= 1) {
        showMsg("Belum ada kategori temuan yang terhubung ke jenis pelanggaran untuk departemen Anda. Hubungi admin.", "info");
    }
}

function setKet(v) {
    if (S.saving || S.partial || S.mode !== "add") return;
    S.ket = v;
    syncIndividuUi();
    if (v) $("indKet").focus();
}

function onEmpInput() {
    clearTimeout(empTimer);
    const q = sanitizeSearch($("indEmpSearch").value);
    if (q.length < 2) { $("indEmpList").hidden = true; return; }
    empTimer = setTimeout(() => runEmpSearch(q), 300);
}

// Penempatan aktif terbaru tiap karyawan: Map(employee_id -> baris penempatan)
async function fetchAssignments(ids) {
    const out = new Map();
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const { data, error } = await supabaseClient.schema(SCHEMA_ASSIGNMENT).from(TABLE_ASSIGNMENT)
            .select("employee_id, branch_id, departemen_id, area_id, bagian_id, start_date")
            .in("employee_id", ids.slice(i, i + ID_CHUNK)).eq("is_active", true)
            .order("start_date", { ascending: false });
        if (error) throw error;
        (data || []).forEach(a => { if (!out.has(String(a.employee_id))) out.set(String(a.employee_id), a); });
    }
    return out;
}

// Role 1, 2, 3: semua karyawan aktif. Role lain: hanya yang penempatan aktifnya di departemen yang sama.
async function runEmpSearch(q) {
    const my = ++empReq;
    const list = $("indEmpList");
    list.hidden = false;
    list.innerHTML = `<div class="ins-suggest-item disabled">Mencari...</div>`;
    try {
        const { data, error } = await supabaseClient.schema(SCHEMA_HRD).from(TABLE_EMPLOYEES).select("id, nik_karyawan, nama")
            .eq("is_active", true).or(`nama.ilike.*${q}*,nik_karyawan.ilike.*${q}*`)
            .order("nama").limit(S.restrictDept ? 60 : 20);
        if (error) throw error;
        if (my !== empReq) return;
        const asg = await fetchAssignments((data || []).map(e => e.id));
        if (my !== empReq) return;

        let items = (data || []).map(e => ({ id: e.id, nik: e.nik_karyawan, nama: e.nama, asg: asg.get(String(e.id)) || null }));
        if (S.restrictDept) items = items.filter(e => e.asg && String(e.asg.departemen_id) === String(S.sessionDept));
        items = items.slice(0, 20);

        empOptions.clear();
        if (items.length === 0) { list.innerHTML = `<div class="ins-suggest-item disabled">Karyawan aktif tidak ditemukan</div>`; return; }
        list.innerHTML = items.map(e => {
            empOptions.set(String(e.id), e);
            const dept = e.asg ? (S.deptMap.get(String(e.asg.departemen_id)) || "") : "";
            return e.asg
                ? `<div class="ins-suggest-item" data-id="${esc(e.id)}">${esc(e.nama)}<small>${esc(e.nik)}${dept ? " - " + esc(dept) : ""}</small></div>`
                : `<div class="ins-suggest-item disabled" data-id="${esc(e.id)}">${esc(e.nama)}<small>${esc(e.nik)} - penempatan aktif tidak ditemukan</small></div>`;
        }).join("");
    } catch (err) {
        if (my !== empReq) return;
        console.error("Gagal mencari karyawan:", err);
        list.innerHTML = `<div class="ins-suggest-item disabled">Gagal mencari: ${esc(err.message)}</div>`;
    }
}

function chooseEmployee(e) {
    if (!e || S.partial) return;
    S.emp = e;
    $("indEmpList").hidden = true;
    $("indEmpChosenText").textContent = `${e.nik} - ${e.nama}`;
    syncIndividuUi();
}

function clearEmployee() {
    if (S.partial) return;
    S.emp = null;
    $("indEmpSearch").value = "";
    syncIndividuUi();
    $("indEmpSearch").focus();
}

// Isian Peringatan Lisan (tanpa inspeksi_id dan tanggal, yang baru diketahui setelah inspeksi tersimpan)
function buildPelanggaranBase() {
    const kat = S.kategori.find(k => String(k.id) === $("insKategori").value);
    const e = S.emp;
    return {
        branch_id: e.asg.branch_id,
        dept_id: e.asg.departemen_id,
        area_id: e.asg.area_id,
        bagian_id: e.asg.bagian_id,
        petugas: S.employeeId,
        employee_id: e.id,
        nik_karyawan: e.nik,
        jenis_peringatan: LISAN_LABEL,
        jenis_pelanggaran_id: kat.jenis_pelanggaran_id,
        deskripsi: S.ket ? $("indKet").value.trim() : $("insDeskripsi").value.trim(),
        is_active: true
    };
}

// Menyimpan Peringatan Lisan. Jika gagal: isian dikunci dan Simpan mengulang langkah ini saja.
async function finishPelanggaran() {
    const { base, inspeksi } = S.partial;
    const u = getUser();
    try {
        const startDate = dayKey(new Date(inspeksi.created_at || Date.now()), u ? u.branchId : null);   // tanggal inspeksi
        const { error } = await supabaseClient.schema(SCHEMA_OPR).from(TABLE_PELANGGARAN)
            .insert({ ...base, inspeksi_id: inspeksi.id, start_date: startDate, end_date: startDate });
        if (error) throw error;
        S.partial = null;
        closeModal();
        showToast("Inspeksi dan Peringatan Lisan tersimpan.");
        loadList(true);
    } catch (err) {
        console.error("Gagal menyimpan Peringatan Lisan:", err);
        $("insBody").classList.add("ins-locked");
        showMsg(`Temuan inspeksi SUDAH tersimpan, tetapi Peringatan Lisan gagal tersimpan:\n${err.message}\n\nTekan Simpan untuk mencoba lagi (hanya Peringatan Lisan). Jika ditutup, temuan tetap tersimpan tanpa Peringatan Lisan.`, "danger");
    }
}

async function retryPelanggaran() {
    const btn = $("insBtnSimpan");
    S.saving = true;
    setBusy(btn, true, "Menyimpan...");
    try { await finishPelanggaran(); }
    finally { S.saving = false; setBusy(btn, false); }
}

// ===================================================
// KELOMPOK 13: SIMPAN EDIT
// Urutan: cek batas H-1 -> validasi -> (tanpa perubahan = selesai) -> unggah
// foto baru -> perbarui baris. Foto lama yang dihapus dari kotak TIDAK dihapus
// dari Storage (hanya dilepas dari data), sehingga file lama tetap aman.
// Yang diubah: area, kategori, temuan, deskripsi, foto. Lokasi, cabang,
// departemen, petugas, dan tanggal tidak disentuh.
// ===================================================
async function saveEdit() {
    if (S.saving || S.mode !== "edit" || !S.card) return;
    showMsg("", "");
    const card = S.card;
    if (!canEdit(card)) { showMsg(`Data ini sudah melewati batas edit (H-${EDIT_MAX_DAYS_BACK}).`, "danger"); return; }

    const errs = validateForm();
    if (errs.length) { showMsg(`Belum bisa disimpan. Perbaiki dulu:\n${errs.join("\n")}`, "danger"); return; }

    const areaId = parseInt($("insAreaSel").value, 10);
    const kategoriId = parseInt($("insKategori").value, 10);
    const subId = parseInt($("insTemuan").value, 10);
    const deskripsi = $("insDeskripsi").value.trim();

    // Tidak ada perubahan?
    const origPaths = PHOTO_COLUMNS.map(c => card[c]).filter(p => p && String(p).trim()).map(p => String(p).trim());
    const slots = S.photos.filter(Boolean);
    const photosSame = slots.length === origPaths.length && slots.every((p, i) => !p.blob && p.path === origPaths[i]);
    if (photosSame && String(card.area_id) === String(areaId) && String(card.kategori_inspeksi_id) === String(kategoriId)
        && String(card.sub_kategori_inspeksi_id) === String(subId) && (card.deskripsi || "") === deskripsi) {
        showToast("Tidak ada perubahan.");
        renderView(card);
        return;
    }

    const btn = $("insBtnSimpan");
    S.saving = true;
    setBusy(btn, true, "Mengunggah foto...");
    const uploaded = [];
    let updated = false;

    try {
        // Foto lama dipakai ulang (path tetap), foto baru diunggah. Urutan kotak dipertahankan.
        const tasks = slots.map(p => p.blob
            ? uploadPhoto(p.blob, card.branch_id).then(path => { uploaded.push(path); return path; })
            : Promise.resolve(p.path));
        const results = await Promise.allSettled(tasks);
        const failed = results.find(r => r.status === "rejected");
        if (failed) throw new Error("Gagal mengunggah foto: " + (failed.reason?.message || failed.reason));
        const finalPaths = results.map(r => r.value);

        setBusy(btn, true, "Menyimpan...");
        const payload = { area_id: areaId, kategori_inspeksi_id: kategoriId, sub_kategori_inspeksi_id: subId, deskripsi };
        PHOTO_COLUMNS.forEach((col, i) => { payload[col] = finalPaths[i] || null; });

        const { data, error } = await supabaseClient.schema(SCHEMA_OPR).from(TABLE_INSPEKSI)
            .update(payload).eq("id", card.id).eq("petugas", S.employeeId).select("id");
        if (error) throw error;
        // Jika izin (RLS) / batas H-1 di database menolak, tidak ada error tetapi tidak ada baris yang berubah
        if (!data || data.length === 0) throw new Error("Tidak ada data yang berubah. Kemungkinan data sudah melewati batas edit (H-" + EDIT_MAX_DAYS_BACK + ") atau akun tidak punya izin.");
        updated = true;

        closeModal();
        showToast("Perubahan tersimpan.");
        loadList(true);
    } catch (err) {
        console.error("Gagal menyimpan perubahan inspeksi:", err);
        if (!updated && uploaded.length) {
            supabaseClient.storage.from(PHOTO_BUCKET).remove(uploaded).catch(() => {});   // bersihkan foto baru yang yatim
        }
        showMsg(`Tidak ada perubahan yang tersimpan.\n${err.message}`, "danger");
    } finally {
        S.saving = false;
        setBusy(btn, false);
    }
}