// ===================================================
// pelanggaran.js
// PWA - halaman "Pelanggaran" (Surat Peringatan karyawan: opr.pelanggaran)
// Tulis: opr.pelanggaran (tambah SP, edit data H-1)
// Baca : opr.pelanggaran (hanya Surat Peringatan 1/2/3, 3 bulan terakhir),
//        opr.jenis_pelanggaran, hrd.employees, tabel penempatan karyawan, public.departments
// WAJIB: jalankan pelanggaran.sql (grant, policy, trigger) terlebih dulu.
// ===================================================

// ===================================================
// KELOMPOK 1: PENGATURAN (KONFIGURASI)
// Fungsi: nilai tetap yang dipakai di seluruh file.
// ===================================================
let supabaseClient = window.supabaseClient;   // dibaca ulang saat halaman siap (Kelompok 5)

const SCHEMA_OPR = "opr";
const SCHEMA_HRD = "hrd";
const TABLE_PELANGGARAN = "pelanggaran";
const TABLE_JENIS = "jenis_pelanggaran";
const TABLE_EMPLOYEES = "employees";                   // hrd.employees (id, nik_karyawan, nama, is_active)
// PERLU DICEK: nama tabel penempatan karyawan (sama dengan laporan-pelanggaran.js)
const SCHEMA_ASSIGNMENT = SCHEMA_HRD;
const TABLE_ASSIGNMENT = "employee_assignments";
const TABLE_DEPT = "departments";                      // schema default (public)

const SESSION_KEY = "pwa_mobile_session";
// "username" dipakai sebagai NIK (sesi PWA tidak punya field nik)
const SESSION_FIELDS = {
    nik: ["nik", "nik_karyawan", "username"],
    branch: ["branchId", "branch_id"],
    department: ["depId", "deptId", "dept_id", "departmentId", "department_id"]
};

// Hak akses (role id)
const ROLE_IDS_BLOCKED = [5];          // tidak boleh membuka halaman (Employee)
const ROLE_IDS_ADMIN_VIEW = [1, 2];    // Maintenance & Superadmin: melihat semua data, kartu menampilkan Departemen, dikelompokkan per departemen
const ROLE_IDS_ALL_EMP = [1, 2, 3];    // saat mencari karyawan: semua karyawan aktif. Role lain: hanya departemen yang sama

const SP_LABELS = { 1: "Surat Peringatan - 1", 2: "Surat Peringatan - 2", 3: "Surat Peringatan - 3" };
const SP_MAX = 3;
const SP_VALID_MONTHS = 6;             // End Date = Start Date + 6 bulan
const LIST_MONTHS = 3;                 // daftar hanya menampilkan 3 bulan terakhir (menurut Start Date)
const EDIT_MAX_DAYS_BACK = 1;          // batas edit: H-1 = data yang DIBUAT hari ini atau kemarin (created_at, zona waktu cabang)
const PAGE_SIZE = 30;                  // jumlah kartu per pemuatan
const ID_CHUNK = 100;

const DEFAULT_BRANCH = 1;
const BRANCH_TZ = { 1: "Asia/Jakarta", 2: "Asia/Makassar", 3: "Asia/Jakarta" };

// ===================================================
// KELOMPOK 2: STATE (DATA SEMENTARA DI MEMORI)
// ===================================================
const S = {
    roleId: null,
    isAdminView: false,       // role 1 / 2
    restrictDept: true,       // true jika role BUKAN 1/2/3 (cari karyawan hanya se-departemen)
    sessionBranch: null,
    sessionDept: null,
    employeeId: null,         // hrd.employees.id user login (kolom petugas)
    deptMap: new Map(),
    jenis: [], jenisMap: new Map(),
    empCache: new Map(),      // id karyawan -> { nik, nama }
    rows: [], shown: 0,
    loading: false, reqId: 0,
    mode: null,               // "add" | "view" | "edit"
    row: null,
    bounds: { min: "", max: "" },   // batas Start Date (SP sebelumnya / berikutnya)
    add: { employee: null, highest: 0, saving: false },
    edit: { saving: false }
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

function tzOf(branchId) { return BRANCH_TZ[branchId] || BRANCH_TZ[DEFAULT_BRANCH]; }

// Tanggal "YYYY-MM-DD" di zona waktu cabang
function dayKey(date, branchId) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tzOf(branchId), year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
function todayStr(branchId) { return dayKey(new Date(), branchId); }

const BULAN_SHORT = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
// "2026-11-09" -> "09 Nov 26"
function fmtDate(d) {
    const m = String(d || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]} ${BULAN_SHORT[Number(m[2]) - 1]} ${m[1].slice(2)}` : (d ? String(d) : "");
}

// Tambah (atau kurangi, n negatif) bulan pada "YYYY-MM-DD"; jika harinya tidak ada dipakai hari terakhir bulan itu
function addMonths(dateStr, n) {
    const m = String(dateStr || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return "";
    const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
    const idx = mo + n;
    const ty = y + Math.floor(idx / 12), tm = ((idx % 12) + 12) % 12;
    const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
    return `${ty}-${String(tm + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

// Level SP dari teks (angka di akhir): "Surat Peringatan - 2" -> 2
function spLevel(text) { const m = String(text || "").match(/(\d+)\s*$/); return m ? Number(m[1]) : 0; }

function sanitizeSearch(text) { return String(text || "").replace(/[,()*%\\]/g, " ").replace(/\s+/g, " ").trim(); }

let toastTimer = null;
function showToast(text) {
    const t = $("plgToast");
    t.textContent = text;
    t.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.style.display = "none"; }, 3500);
}
function showMsg(text, type) {
    const el = $("plgMsg");
    if (!text) { el.hidden = true; el.textContent = ""; return; }
    el.className = `plg-alert ${type || "danger"}`;
    el.textContent = text;
    el.hidden = false;
    $("plgBody").scrollTop = 0;
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

const oprFrom = (table) => supabaseClient.schema(SCHEMA_OPR).from(table);
const hrdFrom = (table) => supabaseClient.schema(SCHEMA_HRD).from(table);
const asgFrom = () => supabaseClient.schema(SCHEMA_ASSIGNMENT).from(TABLE_ASSIGNMENT);

// ===================================================
// KELOMPOK 4: SESI LOGIN
// Fungsi: membaca pwa_mobile_session (NIK dari username, cabang, departemen, role).
// CATATAN KEAMANAN: pembatasan data di sini hanya di aplikasi; yang sebenarnya
// harus lewat RLS di database.
// ===================================================
function getSession() {
    const raw = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); }
    catch (err) { console.error("Sesi login tidak bisa dibaca:", err); return null; }
}

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

// NIK -> id karyawan (uuid). Kolom petugas dan employee_id berisi id ini.
async function resolveEmployeeId(nik) {
    const { data, error } = await hrdFrom(TABLE_EMPLOYEES).select("id").eq("nik_karyawan", nik).limit(1);
    if (error) throw error;
    return data && data.length ? data[0].id : null;
}

// ===================================================
// KELOMPOK 5: INISIALISASI
// Fungsi: periksa koneksi, login, dan role; cari id karyawan user; muat data
// pendukung; lalu muat daftar kartu.
// ===================================================
function failPage(message) {
    $("btnBuat").disabled = true;
    $("plgList").innerHTML = `<div class="plg-empty">${esc(message)}</div>`;
}

document.addEventListener("DOMContentLoaded", async () => {
    supabaseClient = window.supabaseClient || supabaseClient;
    setupModal();
    $("btnBuat").addEventListener("click", openAdd);

    if (!supabaseClient) {
        failPage("Koneksi database tidak tersedia (supabase.js tidak termuat). Periksa path <script> di pelanggaran.html.");
        return;
    }
    const session = getSession();
    if (!session) { failPage("Sesi login tidak ditemukan. Silakan login ulang."); return; }

    S.roleId = Number(session.roleId);
    S.sessionBranch = toInt(findField(session, SESSION_FIELDS.branch));
    S.sessionDept = toInt(findField(session, SESSION_FIELDS.department));
    S.isAdminView = ROLE_IDS_ADMIN_VIEW.includes(S.roleId);
    S.restrictDept = !ROLE_IDS_ALL_EMP.includes(S.roleId);
    const nikRaw = findField(session, SESSION_FIELDS.nik);
    const nik = nikRaw ? String(nikRaw).trim() : null;
    console.info("[Pelanggaran] roleId:", S.roleId, "| cabang:", S.sessionBranch, "| dept:", S.sessionDept, "| nik:", nik);

    if (ROLE_IDS_BLOCKED.includes(S.roleId)) { failPage("Anda tidak memiliki akses ke halaman ini."); return; }
    if (!nik) { failPage("NIK akun tidak terbaca dari sesi login. Silakan login ulang."); return; }

    try { S.employeeId = await resolveEmployeeId(nik); }
    catch (err) { console.error("Gagal membaca data karyawan:", err); failPage(`Gagal membaca data karyawan: ${err.message}`); return; }

    if (!S.employeeId) {
        // Non-admin: daftar bergantung pada id karyawan, jadi halaman dihentikan. Admin tetap bisa melihat daftar.
        if (!S.isAdminView) { failPage(`NIK ${nik} tidak ditemukan di data karyawan. Hubungi admin.`); return; }
        $("btnBuat").disabled = true;
        $("btnBuat").title = "Data karyawan akun Anda tidak ditemukan (NIK sesi tidak cocok dengan hrd.employees)";
    }

    try { await loadLookups(); }
    catch (err) { console.error("Gagal memuat data pendukung:", err); failPage(`Gagal memuat data pendukung: ${err.message}`); return; }
    loadList();
});

// Departemen dan jenis pelanggaran (kecil, dimuat sekali)
async function loadLookups() {
    const [depts, jenis] = await Promise.all([
        fetchAll((f, t) => supabaseClient.from(TABLE_DEPT).select("id, department_name").order("id").range(f, t)),
        fetchAll((f, t) => oprFrom(TABLE_JENIS).select("id, jenis_pelanggaran, is_active").order("jenis_pelanggaran").order("id").range(f, t))
    ]);
    S.deptMap = new Map(depts.map(d => [String(d.id), d.department_name]));
    S.jenis = jenis;
    S.jenisMap = new Map(jenis.map(j => [String(j.id), j.jenis_pelanggaran]));
}

// ===================================================
// KELOMPOK 6: DAFTAR KARTU
// Fungsi: hanya Surat Peringatan 1/2/3 dengan Start Date dalam 3 bulan terakhir.
// Role di luar 1/2 hanya melihat data yang petugasnya = karyawan login.
// Maintenance/Superadmin: kartu menampilkan Departemen dan data dikelompokkan per
// departemen (A-Z). Di tiap kelompok / untuk role lain: Start Date terbaru di atas.
// Jumlah data kecil (3 bulan), jadi diambil sekaligus lalu diurutkan di aplikasi.
// ===================================================
const LIST_COLUMNS = "id, created_at, branch_id, dept_id, petugas, employee_id, nik_karyawan, jenis_peringatan, jenis_pelanggaran_id, deskripsi, start_date, end_date";

async function loadList() {
    if (S.loading) return;
    const myReq = ++S.reqId;
    S.loading = true;
    $("plgList").innerHTML = `<div class="plg-loading"><i class="fa-solid fa-spinner fa-spin"></i> Memuat data...</div>`;

    try {
        const fromDate = addMonths(todayStr(S.sessionBranch), -LIST_MONTHS);
        const rows = await fetchAll((f, t) => {
            let q = oprFrom(TABLE_PELANGGARAN).select(LIST_COLUMNS)
                .in("jenis_peringatan", Object.values(SP_LABELS))
                .gte("start_date", fromDate);
            if (!S.isAdminView) q = q.eq("petugas", S.employeeId);
            return q.order("start_date", { ascending: false, nullsFirst: false }).order("id", { ascending: false }).range(f, t);
        });
        await resolveEmployees(rows.map(r => r.employee_id));
        if (myReq !== S.reqId) return;

        const deptName = (r) => S.deptMap.get(String(r.dept_id)) || "";
        if (S.isAdminView) {
            // kelompok departemen A-Z; di dalamnya Start Date terbaru di atas
            rows.sort((a, b) => deptName(a).localeCompare(deptName(b), "id")
                || String(b.start_date || "").localeCompare(String(a.start_date || ""))
                || Number(b.id) - Number(a.id));
        }
        S.rows = rows;
        S.shown = Math.min(PAGE_SIZE, rows.length);
        renderList();
    } catch (err) {
        if (myReq !== S.reqId) return;
        console.error("Gagal memuat pelanggaran:", err);
        $("plgList").innerHTML = `<div class="plg-empty">Gagal memuat data: ${esc(err.message)}</div>`;
    } finally {
        if (myReq === S.reqId) S.loading = false;
    }
}

// Mencari NIK dan nama karyawan berdasarkan employee_id (yang belum pernah dicari saja)
async function resolveEmployees(ids) {
    const need = [...new Set(ids.filter(n => n && !S.empCache.has(String(n))).map(String))];
    for (let i = 0; i < need.length; i += ID_CHUNK) {
        const chunk = need.slice(i, i + ID_CHUNK);
        const { data, error } = await hrdFrom(TABLE_EMPLOYEES).select("id, nik_karyawan, nama").in("id", chunk);
        if (error) throw error;
        (data || []).forEach(e => S.empCache.set(String(e.id), { nik: e.nik_karyawan, nama: e.nama }));
        chunk.forEach(n => { if (!S.empCache.has(n)) S.empCache.set(n, { nik: "", nama: "" }); });
    }
}

// "NIK - Nama": NIK dari kolom nik_karyawan (data baru), jika kosong dari data karyawan
function empLabel(r) {
    const e = S.empCache.get(String(r.employee_id)) || {};
    const nik = r.nik_karyawan || e.nik || "";
    return [nik, e.nama].filter(Boolean).join(" - ") || "-";
}

function cardHtml(r) {
    const lv = spLevel(r.jenis_peringatan);
    return `
        <div class="plg-card" data-id="${esc(r.id)}">
            ${S.isAdminView ? `<span class="plg-dept">${esc(S.deptMap.get(String(r.dept_id)) || "-")}</span>` : ""}
            <div class="plg-card-top">
                <div class="plg-card-title">${esc(empLabel(r))}</div>
                <span class="plg-badge sp${lv}">${esc(r.jenis_peringatan)}</span>
            </div>
            <div class="plg-card-meta">${esc(S.jenisMap.get(String(r.jenis_pelanggaran_id)) || "-")}</div>
            <div class="plg-card-meta"><i class="fa-regular fa-calendar"></i> ${esc(fmtDate(r.start_date) || "-")}</div>
        </div>`;
}

function renderList() {
    const box = $("plgList");
    if (S.rows.length === 0) {
        box.innerHTML = `<div class="plg-empty">Belum ada Surat Peringatan dalam ${LIST_MONTHS} bulan terakhir.</div>`;
        return;
    }
    const sisa = S.rows.length - S.shown;
    box.innerHTML = S.rows.slice(0, S.shown).map(cardHtml).join("") +
        (sisa > 0 ? `<button type="button" class="plg-more">Muat lebih banyak (${sisa} lagi)</button>` : "");
}

// Klik kartu / tombol "muat lebih banyak" (satu pendengar untuk semua kartu)
document.addEventListener("click", (e) => {
    if (e.target.closest(".plg-more")) { S.shown = Math.min(S.shown + PAGE_SIZE, S.rows.length); renderList(); return; }
    const card = e.target.closest(".plg-card");
    if (card) {
        const r = S.rows.find(x => String(x.id) === card.dataset.id);
        if (r) openView(r);
    }
});

// ===================================================
// KELOMPOK 7: MODAL - PEMASANGAN TOMBOL & MODE
// Fungsi: satu modal untuk Buat / Detail / Edit. applyMode() mengatur isian yang
// tampil dan tombol footer sesuai mode.
// ===================================================
let empTimer = null;
let empReq = 0;
const empOptions = new Map();

function setupModal() {
    $("plgBtnX").addEventListener("click", closeModal);
    $("plgBtnTutup").addEventListener("click", closeModal);
    $("plgBtnBatal").addEventListener("click", () => { if (S.mode === "edit" && S.row) openView(S.row); else closeModal(); });
    $("plgBtnEdit").addEventListener("click", enterEdit);
    $("plgBtnSimpan").addEventListener("click", () => { if (S.mode === "edit") saveEdit(); else saveAdd(); });
    $("pEmpSearch").addEventListener("input", onEmpInput);
    $("btnEmpClear").addEventListener("click", clearEmployee);
    $("pStart").addEventListener("change", onStartChange);
    // pilihan saran karyawan (pointerdown agar terpilih sebelum kolom kehilangan fokus)
    $("pEmpList").addEventListener("pointerdown", (e) => {
        const item = e.target.closest(".plg-suggest-item[data-id]");
        if (!item || item.classList.contains("disabled")) return;
        e.preventDefault();
        chooseEmployee(empOptions.get(item.dataset.id));
    });
    document.addEventListener("click", (e) => { if (!e.target.closest(".plg-rel")) $("pEmpList").hidden = true; });
}

function applyMode() {
    const add = S.mode === "add", view = S.mode === "view", edit = S.mode === "edit";
    $("plgTitle").textContent = add ? "Surat Peringatan" : view ? "Detail Surat Peringatan" : "Edit Surat Peringatan";
    $("pEmpSearch").hidden = !(add && !S.add.employee);
    $("pEmpChosen").hidden = !(add && S.add.employee);
    $("pEmpTxt").hidden = add;
    $("pSp").hidden = !add;           $("pSpTxt").hidden = add;
    $("pJenis").hidden = view;        $("pJenisTxt").hidden = !view;
    $("pDesc").readOnly = view;
    $("pStart").disabled = view;
    $("plgBtnTutup").hidden = !view;
    $("plgBtnBatal").hidden = view;
    $("plgBtnEdit").hidden = true;    // diatur openView sesuai syarat
    $("plgBtnSimpan").hidden = view;
    $("pHint").textContent = "";
    $("pEmpList").hidden = true;
    if (!add) $("pSpInfo").hidden = true;
}

function openModalShell() { $("plgModal").classList.add("open"); document.body.style.overflow = "hidden"; }
function closeModal() {
    $("plgModal").classList.remove("open");
    document.body.style.overflow = "";
    S.mode = null; S.row = null;
    showMsg("", "");
}

// Dropdown Jenis Pelanggaran: yang aktif (+ nilai lama saat edit walau sudah nonaktif)
function fillJenisSelect(selectedId) {
    let list = S.jenis.filter(j => j.is_active === true);
    const cur = selectedId ? S.jenis.find(j => String(j.id) === String(selectedId)) : null;
    if (cur && !list.includes(cur)) list = [cur, ...list];
    $("pJenis").innerHTML = `<option value="">Pilih Jenis Pelanggaran</option>` +
        list.map(j => `<option value="${esc(j.id)}">${esc(j.jenis_pelanggaran)}${j.is_active === true ? "" : " (non aktif)"}</option>`).join("");
    $("pJenis").value = selectedId ? String(selectedId) : "";
}

function setBounds(min, max) {
    S.bounds = { min: min || "", max: max || "" };
    if (S.bounds.min) $("pStart").min = S.bounds.min; else $("pStart").removeAttribute("min");
    if (S.bounds.max) $("pStart").max = S.bounds.max; else $("pStart").removeAttribute("max");
}

// Start Date harus di antara SP sebelumnya (batas bawah) dan SP berikutnya (batas atas, hanya saat edit)
function onStartChange() {
    const v = $("pStart").value, { min, max } = S.bounds;
    if (v && min && v < min) {
        $("pStart").value = min;
        showMsg(`Start Date tidak boleh lebih kecil dari Start Date SP sebelumnya (${fmtDate(min)}). Tanggal dikembalikan.`, "warn");
    } else if (v && max && v > max) {
        $("pStart").value = max;
        showMsg(`Start Date tidak boleh lebih besar dari Start Date SP berikutnya (${fmtDate(max)}). Tanggal dikembalikan.`, "warn");
    }
    updateEndDate();
}

// End Date = Start Date + 6 bulan (otomatis, tidak bisa diketik)
function updateEndDate() { $("pEnd").value = addMonths($("pStart").value, SP_VALID_MONTHS); }

// ===================================================
// KELOMPOK 8: MODAL - DETAIL (HANYA BACA)
// Fungsi: klik kartu membuka isi yang sama dengan form, hanya baca. Tombol Edit
// muncul jika data masih H-1 (dibuat hari ini / kemarin) dan milik petugas ini
// (Maintenance & Superadmin boleh semua).
// ===================================================
function withinEditWindow(r) {
    const created = Date.parse(dayKey(new Date(r.created_at), r.branch_id));
    const today = Date.parse(dayKey(new Date(), r.branch_id));
    return (today - created) / 86400000 <= EDIT_MAX_DAYS_BACK;
}
function canEdit(r) {
    return withinEditWindow(r) && (S.isAdminView || (!!S.employeeId && String(r.petugas) === String(S.employeeId)));
}

function openView(r) {
    S.mode = "view";
    S.row = r;
    applyMode();
    $("pEmpTxt").value = empLabel(r);
    $("pSpTxt").value = r.jenis_peringatan || "";
    $("pJenisTxt").value = S.jenisMap.get(String(r.jenis_pelanggaran_id)) || "";
    $("pDesc").value = r.deskripsi || "";
    setBounds("", "");
    $("pStart").value = r.start_date || "";
    $("pEnd").value = r.end_date || "";
    const editable = canEdit(r);
    $("plgBtnEdit").hidden = !editable;
    $("pHint").textContent = editable ? "" : `Data hanya dapat diedit sampai H-${EDIT_MAX_DAYS_BACK} (dibuat hari ini atau kemarin).`;
    showMsg("", "");
    openModalShell();
}

// ===================================================
// KELOMPOK 9: MODAL - EDIT
// Fungsi: yang bisa diubah: Jenis Pelanggaran, Deskripsi, dan Start Date (End Date
// mengikuti). Karyawan dan Jenis Peringatan dikunci agar urutan SP tidak rusak.
// Start Date harus di antara Start Date SP sebelumnya dan SP berikutnya karyawan itu.
// ===================================================

// Batas Start Date untuk baris ini dari SP lain karyawan yang sama
async function getBounds(r) {
    const { data, error } = await oprFrom(TABLE_PELANGGARAN).select("id, jenis_peringatan, start_date")
        .eq("employee_id", r.employee_id).limit(500);
    if (error) throw error;
    const lv = spLevel(r.jenis_peringatan);
    let lower = "", upper = "";
    (data || []).forEach(x => {
        const l = spLevel(x.jenis_peringatan);
        if (String(x.id) === String(r.id) || l === 0 || !x.start_date) return;
        if (l < lv && x.start_date > lower) lower = x.start_date;
        if (l > lv && (!upper || x.start_date < upper)) upper = x.start_date;
    });
    return { lower, upper };
}

async function enterEdit() {
    const r = S.row;
    if (!r || S.mode !== "view" || !canEdit(r)) return;
    const btn = $("plgBtnEdit");
    setBusy(btn, true, "Memuat...");
    let b;
    try { b = await getBounds(r); }
    catch (err) { setBusy(btn, false); showMsg(`Gagal memeriksa SP karyawan: ${err.message}`, "danger"); return; }
    setBusy(btn, false);
    if (S.row !== r || S.mode !== "view") return;      // modal ditutup saat memuat

    S.mode = "edit";
    applyMode();
    fillJenisSelect(r.jenis_pelanggaran_id);
    setBounds(b.lower, b.upper);
    $("pStart").value = r.start_date || "";
    updateEndDate();
    const parts = [];
    if (b.lower) parts.push(`tidak lebih kecil dari ${fmtDate(b.lower)} (SP sebelumnya)`);
    if (b.upper) parts.push(`tidak lebih besar dari ${fmtDate(b.upper)} (SP berikutnya)`);
    $("pHint").textContent = parts.length ? `Start Date ${parts.join(" dan ")}.` : "";
    showMsg("", "");
}

async function saveEdit() {
    if (S.edit.saving || S.mode !== "edit" || !S.row) return;
    showMsg("", "");
    const r = S.row;
    if (!canEdit(r)) { showMsg(`Data ini sudah melewati batas edit (H-${EDIT_MAX_DAYS_BACK}).`, "danger"); return; }

    const errs = [];
    if (!$("pJenis").value) errs.push("Pilih Jenis Pelanggaran.");
    if (!$("pDesc").value.trim()) errs.push("Isi Deskripsi Pelanggaran.");
    const start = $("pStart").value;
    if (!start) errs.push("Isi Start Date.");
    else {
        if (S.bounds.min && start < S.bounds.min) errs.push(`Start Date tidak boleh lebih kecil dari ${fmtDate(S.bounds.min)} (SP sebelumnya).`);
        if (S.bounds.max && start > S.bounds.max) errs.push(`Start Date tidak boleh lebih besar dari ${fmtDate(S.bounds.max)} (SP berikutnya).`);
    }
    if (errs.length) { showMsg(`Belum bisa disimpan. Perbaiki dulu:\n${errs.join("\n")}`, "danger"); return; }

    const jenisId = parseInt($("pJenis").value, 10);
    const desc = $("pDesc").value.trim();
    const end = addMonths(start, SP_VALID_MONTHS);
    if (String(r.jenis_pelanggaran_id) === String(jenisId) && (r.deskripsi || "") === desc && r.start_date === start) {
        showToast("Tidak ada perubahan.");
        openView(r);
        return;
    }

    const btn = $("plgBtnSimpan");
    S.edit.saving = true;
    setBusy(btn, true, "Menyimpan...");
    try {
        let q = oprFrom(TABLE_PELANGGARAN)
            .update({ jenis_pelanggaran_id: jenisId, deskripsi: desc, start_date: start, end_date: end })
            .eq("id", r.id);
        if (!S.isAdminView) q = q.eq("petugas", S.employeeId);
        const { data, error } = await q.select("id");
        if (error) throw error;
        // Jika izin (RLS) / batas H-1 di database menolak, tidak ada error tetapi tidak ada baris yang berubah
        if (!data || data.length === 0) throw new Error(`Tidak ada data yang berubah. Kemungkinan data sudah melewati batas edit (H-${EDIT_MAX_DAYS_BACK}) atau akun tidak punya izin.`);

        closeModal();
        showToast("Perubahan tersimpan.");
        loadList();
    } catch (err) {
        console.error("Gagal menyimpan perubahan:", err);
        showMsg(`Tidak ada perubahan yang tersimpan.\n${err.message}`, "danger");
    } finally {
        S.edit.saving = false;
        setBusy(btn, false);
    }
}

// ===================================================
// KELOMPOK 10: MODAL - BUAT: PEMILIHAN KARYAWAN
// Fungsi: kolom cari (nama atau NIK) menampilkan karyawan AKTIF.
// Role 1, 2, 3: semua karyawan aktif. Role lain: hanya yang penempatan aktifnya
// di departemen yang sama. Nilai yang disimpan = employee_id (dan NIK di nik_karyawan).
// Penempatan aktif (cabang, departemen, area, bagian) dibaca dari tabel penempatan
// untuk mengisi kolom di belakang layar.
// ===================================================
function openAdd() {
    if (!S.employeeId) { showToast("Data karyawan akun Anda tidak ditemukan."); return; }
    if (S.restrictDept && S.sessionDept === null) { showToast("Departemen akun Anda tidak terbaca dari sesi. Hubungi admin."); return; }
    S.mode = "add";
    S.row = null;
    S.add = { employee: null, highest: 0, saving: false };
    applyMode();
    $("pEmpSearch").value = "";
    resetSpSelect("Pilih karyawan dulu");
    fillJenisSelect(null);
    $("pDesc").value = "";
    setBounds("", "");
    $("pStart").value = todayStr(S.sessionBranch);
    updateEndDate();
    $("pSpInfo").hidden = true;
    showMsg("", "");
    openModalShell();
    $("pEmpSearch").focus();
}

function resetSpSelect(text) {
    $("pSp").innerHTML = `<option value="">${esc(text)}</option>`;
    $("pSp").disabled = true;
}

function onEmpInput() {
    clearTimeout(empTimer);
    const q = sanitizeSearch($("pEmpSearch").value);
    if (q.length < 2) { $("pEmpList").hidden = true; return; }
    empTimer = setTimeout(() => runEmpSearch(q), 300);
}

// Penempatan aktif terbaru tiap karyawan: Map(employee_id -> baris penempatan)
async function fetchAssignments(ids) {
    const out = new Map();
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const { data, error } = await asgFrom()
            .select("employee_id, branch_id, departemen_id, area_id, bagian_id, start_date")
            .in("employee_id", ids.slice(i, i + ID_CHUNK)).eq("is_active", true)
            .order("start_date", { ascending: false });
        if (error) throw error;
        (data || []).forEach(a => { if (!out.has(String(a.employee_id))) out.set(String(a.employee_id), a); });
    }
    return out;
}

async function runEmpSearch(q) {
    const my = ++empReq;
    const list = $("pEmpList");
    list.hidden = false;
    list.innerHTML = `<div class="plg-suggest-item disabled">Mencari...</div>`;
    try {
        const { data, error } = await hrdFrom(TABLE_EMPLOYEES).select("id, nik_karyawan, nama")
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
        if (items.length === 0) { list.innerHTML = `<div class="plg-suggest-item disabled">Karyawan aktif tidak ditemukan</div>`; return; }
        list.innerHTML = items.map(e => {
            empOptions.set(String(e.id), e);
            const dept = e.asg ? (S.deptMap.get(String(e.asg.departemen_id)) || "") : "";
            return e.asg
                ? `<div class="plg-suggest-item" data-id="${esc(e.id)}">${esc(e.nama)}<small>${esc(e.nik)}${dept ? " - " + esc(dept) : ""}</small></div>`
                : `<div class="plg-suggest-item disabled" data-id="${esc(e.id)}">${esc(e.nama)}<small>${esc(e.nik)} - penempatan aktif tidak ditemukan</small></div>`;
        }).join("");
    } catch (err) {
        if (my !== empReq) return;
        console.error("Gagal mencari karyawan:", err);
        list.innerHTML = `<div class="plg-suggest-item disabled">Gagal mencari: ${esc(err.message)}</div>`;
    }
}

function clearEmployee() {
    S.add.employee = null;
    S.add.highest = 0;
    applyMode();
    $("pEmpSearch").value = "";
    $("pSpInfo").hidden = true;
    resetSpSelect("Pilih karyawan dulu");
    setBounds("", "");
    showMsg("", "");
    $("pEmpSearch").focus();
}

async function chooseEmployee(e) {
    if (!e) return;
    S.add.employee = e;
    applyMode();
    $("pEmpChosenText").textContent = `${e.nik} - ${e.nama}`;
    $("pStart").value = todayStr(e.asg.branch_id);       // tanggal default mengikuti zona waktu cabang karyawan
    updateEndDate();
    await refreshSpOptions();
}

// ===================================================
// KELOMPOK 11: SARAN SP BERIKUTNYA
// Fungsi: membaca riwayat SP karyawan. SP yang MASIH BERLAKU menurut End Date
// (end_date kosong atau belum lewat; kolom is_active TIDAK dipakai) menentukan
// level tertinggi; opsi yang tersedia hanya level di atasnya. Jika SP-3 masih
// berlaku: peringatan, tidak ada SP berikutnya (proses selanjutnya PHK).
// Start Date SP baru tidak boleh lebih kecil dari Start Date SP terakhir.
// ===================================================
async function getActiveSp(employeeId, branchId) {
    const today = todayStr(branchId);
    const { data, error } = await oprFrom(TABLE_PELANGGARAN)
        .select("jenis_peringatan, start_date, end_date")
        .eq("employee_id", employeeId)
        .order("start_date", { ascending: false, nullsFirst: false })
        .limit(500);
    if (error) throw error;
    const all = (data || []).filter(r => spLevel(r.jenis_peringatan) > 0);
    const rows = all.filter(r => !r.end_date || String(r.end_date) >= today);
    const highest = rows.reduce((m, r) => Math.max(m, spLevel(r.jenis_peringatan)), 0);
    const lastStart = all.reduce((m, r) => (r.start_date && String(r.start_date) > m ? String(r.start_date) : m), "");
    return { highest, rows, lastStart };
}

async function refreshSpOptions() {
    const e = S.add.employee;
    if (!e) return;
    resetSpSelect("Memeriksa SP sebelumnya...");
    $("pSpInfo").hidden = true;
    $("pSpInfo").textContent = "";
    showMsg("", "");
    try {
        const { highest, rows, lastStart } = await getActiveSp(e.id, e.asg.branch_id);
        if (S.add.employee !== e) return;               // karyawan diganti saat memeriksa
        S.add.highest = highest;
        setBounds(lastStart, "");
        if (lastStart && $("pStart").value < lastStart) { $("pStart").value = lastStart; updateEndDate(); }

        const lines = [];
        if (rows.length) {
            lines.push("SP yang masih berlaku:");
            rows.sort((a, b) => spLevel(a.jenis_peringatan) - spLevel(b.jenis_peringatan))
                .forEach(r => lines.push(`${r.jenis_peringatan} (s.d. ${r.end_date ? fmtDate(r.end_date) : "tanpa batas"})`));
        }
        if (lastStart) lines.push(`Start Date tidak boleh lebih kecil dari ${fmtDate(lastStart)} (SP sebelumnya).`);
        if (lines.length) { $("pSpInfo").textContent = lines.join("\n"); $("pSpInfo").hidden = false; }

        if (highest >= SP_MAX) {
            resetSpSelect("Tidak ada SP berikutnya");
            showMsg(`${e.nama} sudah mendapat ${SP_LABELS[SP_MAX]} yang masih berlaku dan tidak ada SP berikutnya yang bisa diberikan. Proses selanjutnya adalah PHK.`, "warn");
            return;
        }
        const options = [];
        for (let lv = highest + 1; lv <= SP_MAX; lv++) options.push(`<option value="${esc(SP_LABELS[lv])}">${esc(SP_LABELS[lv])}</option>`);
        $("pSp").innerHTML = `<option value="">Pilih Jenis Peringatan</option>${options.join("")}`;
        $("pSp").disabled = false;
    } catch (err) {
        console.error("Gagal memeriksa SP karyawan:", err);
        resetSpSelect("Gagal memeriksa SP");
        showMsg(`Gagal memeriksa SP sebelumnya: ${err.message}`, "danger");
    }
}

// ===================================================
// KELOMPOK 12: SIMPAN SP BARU
// Fungsi: validasi, periksa ulang SP (data bisa berubah sejak karyawan dipilih),
// lalu simpan. Di belakang layar: branch_id, dept_id, area_id, bagian_id dari
// penempatan aktif karyawan yang diberi peringatan; petugas = id karyawan user
// login; nik_karyawan = NIK karyawan yang diberi peringatan; is_active = true.
// SP lama karyawan yang sama dinonaktifkan oleh trigger database.
// ===================================================
async function saveAdd() {
    if (S.add.saving || S.mode !== "add") return;
    showMsg("", "");
    const e = S.add.employee;
    const errs = [];
    if (!e) errs.push("Pilih karyawan.");
    if (e && S.add.highest >= SP_MAX) errs.push("Karyawan ini sudah mendapat SP-3 yang masih berlaku.");
    if (!$("pSp").value) errs.push("Pilih Jenis Peringatan.");
    if (!$("pJenis").value) errs.push("Pilih Jenis Pelanggaran.");
    if (!$("pDesc").value.trim()) errs.push("Isi Deskripsi Pelanggaran.");
    if (!$("pStart").value) errs.push("Isi Start Date.");
    if ($("pStart").value && S.bounds.min && $("pStart").value < S.bounds.min) errs.push(`Start Date tidak boleh lebih kecil dari ${fmtDate(S.bounds.min)} (Start Date SP sebelumnya).`);
    if (!S.employeeId) errs.push("Data karyawan akun Anda tidak ditemukan (kolom petugas tidak bisa diisi).");
    if (errs.length) { showMsg(`Belum bisa disimpan. Perbaiki dulu:\n${errs.join("\n")}`, "danger"); return; }

    const btn = $("plgBtnSimpan");
    S.add.saving = true;
    setBusy(btn, true, "Menyimpan...");
    try {
        // periksa ulang SP yang berlaku
        const level = spLevel($("pSp").value);
        const { highest, lastStart } = await getActiveSp(e.id, e.asg.branch_id);
        if (lastStart && $("pStart").value < lastStart) {
            await refreshSpOptions();
            throw new Error(`Start Date tidak boleh lebih kecil dari ${fmtDate(lastStart)} (Start Date SP sebelumnya).`);
        }
        if (level <= highest) {
            await refreshSpOptions();
            throw new Error("Data SP karyawan ini berubah sejak dipilih. Pilih ulang Jenis Peringatan.");
        }

        const payload = {
            branch_id: e.asg.branch_id,
            dept_id: e.asg.departemen_id,
            area_id: e.asg.area_id,
            bagian_id: e.asg.bagian_id,
            petugas: S.employeeId,
            employee_id: e.id,
            nik_karyawan: e.nik,
            jenis_peringatan: $("pSp").value,
            jenis_pelanggaran_id: parseInt($("pJenis").value, 10),
            deskripsi: $("pDesc").value.trim(),
            start_date: $("pStart").value,
            end_date: $("pEnd").value || null,
            is_active: true
        };
        const { error } = await oprFrom(TABLE_PELANGGARAN).insert(payload);
        if (error) throw error;

        closeModal();
        showToast("Surat peringatan tersimpan.");
        loadList();
    } catch (err) {
        console.error("Gagal menyimpan surat peringatan:", err);
        showMsg(`Tidak ada data yang tersimpan.\n${err.message}`, "danger");
    } finally {
        S.add.saving = false;
        setBusy(btn, false);
    }
}