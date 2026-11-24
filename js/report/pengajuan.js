// ===================================================
// pengajuan.js (versi 2)
// PWA - halaman "Pengajuan": Cuti, Absensi (koreksi), Perubahan Shift, Lembur.
// Baca : fungsi database hrd.pengajuan_* (lihat pengajuan.sql)
// Tulis: fungsi database hrd.ajukan_* (satu transaksi per pengajuan)
// File : bucket Storage "hrd", jalur {id_karyawan}/pengajuan/{jenis}/...
// WAJIB: jalankan pengajuan.sql di Supabase terlebih dulu.
// Browser TIDAK menulis tabel langsung dan TIDAK mengirim id karyawan:
// identitas diambil server dari login (hrd.employee_id_saya).
// ===================================================

// ===================================================
// KELOMPOK 1: PENGATURAN (KONFIGURASI)
// Fungsi: nilai tetap yang mudah diubah.
// ===================================================
let supabaseClient = window.supabaseClient;

const BUCKET = "hrd";                       // bucket penyimpanan lampiran
const MAX_FILE_BYTES = 10 * 1024 * 1024;    // batas ukuran file asli: 10 MB
const IMG_MAX_SIDE = 1600;                  // sisi terpanjang foto setelah dikecilkan (piksel)
const IMG_QUALITY = 0.75;                   // kualitas JPEG (0-1)
const PAGE_SIZE = 30;                       // jumlah kartu per pemuatan
const KET_MAX = 200;                        // batas karakter Alasan / Keterangan (sama dengan HRIS referensi)
const OT_MAX_MENIT = 12 * 60;               // durasi lembur maksimum di pilihan
const BREAK_MAX_MENIT = 3 * 60;             // durasi istirahat maksimum di pilihan
const STEP_MENIT = 15;                      // kelipatan pilihan durasi lembur
const ROW_H = 44;                           // tinggi satu baris roda jam (harus sama dengan CSS .pg-wheel-item)

// Jenis pengajuan: judul dan ikon.
// Alasan / Keterangan TIDAK wajib, kecuali pengajuan Cuti dengan jenis "Sakit".
// Jenis cuti dianggap "Sakit" jika namanya mengandung kata "sakit" (tidak peka huruf besar/kecil).
const JENIS = {
    cuti:    { label: "Cuti",            icon: "fa-regular fa-calendar-minus" },
    absensi: { label: "Absensi",         icon: "fa-solid fa-fingerprint" },
    shift:   { label: "Perubahan Shift", icon: "fa-solid fa-right-left" },
    lembur:  { label: "Lembur",          icon: "fa-regular fa-clock" }
};
const KET_WAJIB_CUTI = /sakit/i;
const OT_TIPE = ["Pengganti", "Casual", "Overtime"];   // pilihan Jenis Lembur (default Pengganti)

// ===================================================
// KELOMPOK 2: STATE (DATA SEMENTARA DI MEMORI)
// ===================================================
const S = {
    ctx: null,                 // konteks pengguna dari server (id karyawan, hari ini, dst)
    list: [], offset: 0, hasMore: false, loading: false, listReq: 0,
    jenis: null,               // jenis form yang sedang terbuka
    saving: false,
    infoReq: 0,                // penanda permintaan info tanggal terbaru
    info: null,                // info tanggal terakhir (shift, waktu absen)
    edit: null,                // saat mengedit: { id, data } (data dari hrd.pengajuan_ambil)
    taps: {},                  // id kolom ketuk -> fungsi yang dijalankan saat diketuk
    cache: {}                  // daftar yang dimuat sekali: cuti, shift, karyawan, mitra
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

const BULAN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const BULAN_PANJANG = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const HARI_SINGKAT = ["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"];   // kalender mulai hari Senin

function pad(n) { return String(n).padStart(2, "0"); }
function ymd(y, m, d) { return `${y}-${pad(m + 1)}-${pad(d)}`; }          // m = 0-11
function parseYmd(s) { const [y, m, d] = String(s).slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); }
function addDays(s, n) { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d.getFullYear(), d.getMonth(), d.getDate()); }
function fmtTgl(s) {                                                        // "2026-11-09" -> "09 Nov 26"
    if (!s) return "-";
    const d = parseYmd(s);
    return `${pad(d.getDate())} ${BULAN[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;
}
function fmtTglLengkap(s) {                                                 // "2026-11-09" -> "09 Nov 2026"
    const d = parseYmd(s);
    return `${pad(d.getDate())} ${BULAN[d.getMonth()]} ${d.getFullYear()}`;
}
function fmtWaktu(s) { return `${fmtTglLengkap(s)}, ${String(s).slice(11, 16)}`; }   // "2026-11-09 08:00" -> "09 Nov 2026, 08:00"
function fmtRentang(a, b) { return !b || a === b ? fmtTgl(a) : `${fmtTgl(a)} - ${fmtTgl(b)}`; }
function diffHari(a, b) { return Math.round((parseYmd(b) - parseYmd(a)) / 86400000); }
function toMenit(hhmm) { const [h, m] = String(hhmm || "00:00").split(":").map(Number); return h * 60 + m; }

// Baris-baris kalender satu bulan (Senin di kolom pertama); sel kosong = null
function monthRows(y, m) {
    const offset = (new Date(y, m, 1).getDay() + 6) % 7;
    const days = new Date(y, m + 1, 0).getDate();
    const rows = [];
    for (let r = 0; r < Math.ceil((offset + days) / 7); r++) {
        const row = [];
        for (let c = 0; c < 7; c++) { const d = r * 7 + c - offset + 1; row.push(d >= 1 && d <= days ? d : null); }
        rows.push(row);
    }
    return rows;
}
function todayLocal() { const t = new Date(); return ymd(t.getFullYear(), t.getMonth(), t.getDate()); }

let toastTimer = null;
function showToast(text) {
    const t = $("pgToast");
    t.textContent = text;
    t.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.style.display = "none"; }, 3500);
}
function setMsg(text, type) {
    const el = $("pgMsg");
    if (!text) { el.hidden = true; el.textContent = ""; return; }
    el.className = `pg-msg ${type || "danger"}`;
    el.textContent = text;
    el.hidden = false;
    $("pgFormScroll").scrollTop = 0;
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

// Teks shift: "Pagi (07:00 - 15:00)" atau "Tidak ada jadwal"
function shiftText(s) {
    if (!s) return "Tidak ada jadwal";
    return s.jam_masuk ? `${s.nama_shift} (${s.jam_masuk} - ${s.jam_pulang})` : String(s.nama_shift || s.kode_shift);
}

// ===================================================
// KELOMPOK 4: INISIALISASI
// Fungsi: dijalankan saat halaman selesai dimuat. Memeriksa koneksi dan login,
// memuat konteks pengguna dari server, memasang tombol, lalu memuat daftar.
// ===================================================
function failPage(message) {
    $("btnAjukan").disabled = true;
    $("pgList").innerHTML = `<div class="pg-empty">${esc(message)}</div>`;
}

document.addEventListener("DOMContentLoaded", async () => {
    supabaseClient = window.supabaseClient || supabaseClient;
    setupEvents();

    const sessionRaw = localStorage.getItem("pwa_mobile_session") || sessionStorage.getItem("pwa_mobile_session");
    if (!sessionRaw) { window.location.replace("../../login.html"); return; }
    if (!supabaseClient) { failPage("Koneksi database tidak tersedia (supabase.js tidak termuat). Periksa path <script> di pengajuan.html."); return; }

    try {
        const { data: sess } = await supabaseClient.auth.getSession();
        if (!sess || !sess.session) { failPage("Sesi login belum terhubung ke server. Keluar lalu masuk kembali."); return; }
        const { data, error } = await hrd().rpc("pengajuan_konteks");
        if (error) throw error;
        S.ctx = data;
    } catch (err) {
        console.error("Gagal memuat data pengguna:", err);
        failPage(`Gagal memuat data pengguna: ${err.message}`);
        return;
    }
    loadList(true);
});

function setupEvents() {
    $("btnAjukan").addEventListener("click", () => openModal("pgPick"));
    $("pgPickX").addEventListener("click", () => closeModal("pgPick"));
    $("pgPick").addEventListener("click", (e) => {
        if (e.target === $("pgPick")) { closeModal("pgPick"); return; }
        const opt = e.target.closest(".pg-option");
        if (opt) { closeModal("pgPick"); openForm(opt.dataset.jenis); }
    });
    $("pgFormX").addEventListener("click", closeForm);
    $("pgBtnBatal").addEventListener("click", closeForm);
    $("pgFormBack").addEventListener("click", () => { if (S.saving) return; const wasEdit = !!S.edit; closeForm(); if (!wasEdit) openModal("pgPick"); });
    $("pgBtnKirim").addEventListener("click", submitCurrent);

    // Satu pendengar untuk semua isian di dalam form (isinya dibuat ulang tiap form dibuka)
    const body = $("pgFormBody");
    body.addEventListener("click", (e) => {
        const item = e.target.closest(".pg-combo-item");
        if (item) { pickComboItem(item); return; }
        if (!e.target.closest(".pg-combo")) closeCombos();
        const tap = e.target.closest(".pg-tap");
        if (tap && S.taps[tap.dataset.tap]) { S.taps[tap.dataset.tap](); return; }
        const add = e.target.closest("[data-attach-add]");
        if (add) { $(add.dataset.attachAdd).click(); return; }
        const del = e.target.closest("[data-attach-del]");
        if (del) { const id = del.dataset.attachDel; $(id).value = ""; renderAttach(id); }
    });
    body.addEventListener("change", (e) => {
        if (e.target.type !== "file") return;
        const f = e.target.files[0];
        if (f && f.size > MAX_FILE_BYTES) {
            e.target.value = "";
            setMsg(`File terlalu besar (maksimal ${MAX_FILE_BYTES / 1024 / 1024} MB).`, "danger");
        } else if (f) setMsg("");
        renderAttach(e.target.id);
    });
    body.addEventListener("input", (e) => {
        if (e.target.id === "fKet") $("fKetCnt").textContent = `${e.target.value.length}/${KET_MAX}`;
        if (e.target.classList.contains("pg-combo-search")) filterCombo(e.target.dataset.combo);
    });

    setupPickers();
}

function openModal(id) { $(id).classList.add("open"); document.body.style.overflow = "hidden"; }
function closeModal(id) { $(id).classList.remove("open"); if (!document.querySelector(".pg-modal.open")) document.body.style.overflow = ""; }

// ===================================================
// KELOMPOK 5: DAFTAR PENGAJUAN
// Fungsi: kartu pengajuan milik sendiri (semua jenis), terbaru di atas,
// dimuat bertahap 30 per kali dari hrd.pengajuan_saya.
// ===================================================
async function loadList(reset) {
    if (S.loading) return;
    const my = ++S.listReq;
    S.loading = true;
    if (reset) {
        S.list = []; S.offset = 0;
        $("pgList").innerHTML = `<div class="pg-loading"><i class="fa-solid fa-spinner fa-spin"></i> Memuat data...</div>`;
    } else {
        const b = $("pgList").querySelector(".pg-more");
        if (b) { b.disabled = true; b.textContent = "Memuat..."; }
    }
    try {
        const { data, error } = await hrd().rpc("pengajuan_saya", { p_limit: PAGE_SIZE, p_offset: S.offset });
        if (my !== S.listReq) return;
        if (error) throw error;
        const rows = data || [];
        S.list.push(...rows);
        S.offset += rows.length;
        S.hasMore = rows.length === PAGE_SIZE;
        renderList();
    } catch (err) {
        if (my !== S.listReq) return;
        console.error("Gagal memuat pengajuan:", err);
        if (reset) $("pgList").innerHTML = `<div class="pg-empty">Gagal memuat data: ${esc(err.message)}</div>`;
        else showToast("Gagal memuat data: " + err.message);
    } finally {
        if (my === S.listReq) S.loading = false;
    }
}

function badgeClass(status) {
    const s = String(status || "").toLowerCase();
    if (s === "diajukan") return "diajukan";
    if (s === "disetujui" || s === "approved") return "disetujui";
    if (s === "ditolak" || s === "rejected") return "ditolak";
    if (s === "koreksi") return "koreksi";
    return "";
}

function cardHtml(r) {
    const j = JENIS[r.jenis] || { icon: "fa-regular fa-file", label: r.jenis };
    const edit = r.bisa_edit ? ` data-edit="1" data-jenis="${esc(r.jenis)}" data-id="${esc(r.id)}" style="cursor:pointer"` : "";
    const koreksi = String(r.status || "").toLowerCase() === "koreksi";
    return `
        <div class="pg-card"${edit}>
            <div class="pg-card-icon"><i class="${esc(j.icon)}"></i></div>
            <div class="pg-card-main">
                <div class="pg-card-top">
                    <div class="pg-card-title">${esc(r.judul)}</div>
                    <span class="pg-badge ${badgeClass(r.status)}">${esc(r.status || "-")}</span>
                </div>
                <div class="pg-card-meta"><i class="fa-regular fa-calendar"></i> ${esc(fmtRentang(r.tanggal_awal, r.tanggal_akhir))}</div>
                ${r.keterangan ? `<div class="pg-card-meta">${esc(r.keterangan)}</div>` : ""}
                ${r.catatan ? `<div class="pg-msg warn" style="margin:8px 0 0"><b>Catatan atasan:</b> ${esc(r.catatan)}</div>` : ""}
                ${r.bisa_edit ? `<div class="pg-card-meta"><i class="fa-solid fa-pen"></i> ${koreksi ? "Perlu dikoreksi. Ketuk untuk mengedit." : "Ketuk untuk mengedit."}</div>` : ""}
            </div>
        </div>`;
}

function renderList() {
    const box = $("pgList");
    if (S.list.length === 0) {
        box.innerHTML = `<div class="pg-empty">Belum ada pengajuan. Ketuk <b>Ajukan</b> untuk membuat pengajuan baru.</div>`;
        return;
    }
    box.innerHTML = S.list.map(cardHtml).join("") +
        (S.hasMore ? `<button type="button" class="pg-more">Muat lebih banyak</button>` : "");
}

document.addEventListener("click", (e) => {
    if (e.target.closest(".pg-more")) { loadList(false); return; }
    const card = e.target.closest(".pg-card[data-edit]");
    if (card) openEdit(card.dataset.jenis, card.dataset.id);
});

// Membuka pengajuan milik sendiri untuk diedit (hanya status Diajukan / Koreksi; server memeriksa ulang)
async function openEdit(jenis, id) {
    if (S.saving) return;
    try {
        const { data, error } = await hrd().rpc("pengajuan_ambil", { p_jenis: jenis, p_id: String(id) });
        if (error) throw error;
        openForm(jenis, { id: String(id), data });
    } catch (err) {
        console.error("Gagal membuka pengajuan:", err);
        showToast("Gagal membuka pengajuan: " + err.message);
    }
}

// ===================================================
// KELOMPOK 6: MODAL FORM - KERANGKA
// Fungsi: membuka form sesuai jenis, menutupnya, dan mengirimkan.
// Tiap jenis punya dua fungsi: render (membuat isian) dan collect (memeriksa
// isian lalu menyusun data kiriman). Alur kirim sama untuk semuanya:
// periksa -> unggah file (jika ada) -> panggil fungsi database -> segarkan daftar.
// ===================================================
const HANDLERS = {
    cuti:    { render: renderCuti,    collect: collectCuti },
    absensi: { render: renderAbsensi, collect: collectAbsensi },
    shift:   { render: renderShift,   collect: collectShift },
    lembur:  { render: renderLembur,  collect: collectLembur }
};

function releaseAttachUrls() {
    document.querySelectorAll(".pg-attach[data-url]").forEach(b => URL.revokeObjectURL(b.dataset.url));
}

function openForm(jenis, edit) {
    if (!HANDLERS[jenis]) return;
    releaseAttachUrls();
    S.jenis = jenis;
    S.edit = edit || null;
    S.info = null;
    S.taps = {};
    S.combos = {};
    $("pgFormTitle").textContent = (S.edit ? "Edit " : "") + JENIS[jenis].label;
    $("pgFormBody").innerHTML = "";
    setMsg("");
    openModal("pgForm");
    $("pgFormScroll").scrollTop = 0;
    HANDLERS[jenis].render();
}

function closeForm() {
    if (S.saving) return;
    releaseAttachUrls();
    closeModal("pgForm");
    S.jenis = null;
    S.edit = null;
    S.infoReq++;                    // abaikan hasil pemuatan yang masih berjalan
}

async function submitCurrent() {
    if (S.saving || !S.jenis) return;
    setMsg("");
    const jenis = S.jenis;
    let job;
    try { job = HANDLERS[jenis].collect(); }
    catch (err) { setMsg(err.message, "danger"); return; }

    const btn = $("pgBtnKirim");
    S.saving = true;
    setBusy(btn, true, "Mengirim...");
    let path = null;
    try {
        if (job.file) {
            setBusy(btn, true, "Mengunggah...");
            path = await uploadFile(job.file, jenis, job.allowPdf);
        }
        setBusy(btn, true, "Mengirim...");
        const payload = { ...job.payload };
        if (job.fileKey) payload[job.fileKey] = path;       // kosong = tanpa file baru (server memakai lampiran lama)
        if (S.edit) payload.id = S.edit.id;                  // ada id = edit, approval diproses ulang
        const { data, error } = await hrd().rpc(job.rpc, { p: payload });
        if (error) throw error;

        const edited = !!S.edit;
        S.saving = false;
        closeForm();
        showToast(data && data.status === "Disetujui" ? "Pengajuan disetujui otomatis."
            : (edited ? "Perubahan terkirim, menunggu persetujuan." : "Pengajuan terkirim, menunggu persetujuan."));
        loadList(true);
    } catch (err) {
        console.error("Gagal mengirim pengajuan:", err);
        if (path) supabaseClient.storage.from(BUCKET).remove([path]).catch(() => {});   // bersihkan file yatim
        setMsg(`Pengajuan tidak terkirim.\n${err.message}`, "danger");
    } finally {
        S.saving = false;
        setBusy(btn, false);
    }
}

// ===================================================
// KELOMPOK 7: PEMILIH TANGGAL & JAM (lembar di atas form)
// Fungsi: kalender TIDAK tampil langsung di form; baru terbuka saat kolom
// tanggal diketuk.
//  pickDate()  : pilih satu tanggal. Tanggal yang tidak boleh dipilih (isEnabled
//                bernilai false) berwarna abu-abu. Opsi auto:true = begitu
//                tanggal diketuk langsung selesai tanpa menekan Simpan.
//  pickRange() : pilih rentang tanggal (dipakai Cuti): ketuk tanggal awal lalu
//                tanggal akhir (ketuk tanggal yang sama = 1 hari). Tanggal sebelum
//                tanggal awal tidak bisa dipilih saat memilih tanggal akhir.
//  pickTime()  : dua roda (jam : menit), dipakai untuk jam absen dan durasi lembur.
// Semuanya mengembalikan hasil lewat Promise (null jika ditutup tanpa Simpan).
// ===================================================
const dp = { resolve: null, mode: "single", sel: null, start: null, end: null, auto: false, y: 0, m: 0, isEnabled: () => true };
const tp = { resolve: null, built: false };

function setupPickers() {
    $("pgDateOk").addEventListener("click", () => {
        if (dp.mode === "range") finishDate(dp.start && dp.end ? { start: dp.start, end: dp.end } : null);
        else finishDate(dp.sel);
    });
    $("pgDateX").addEventListener("click", () => finishDate(null));
    $("pgDate").addEventListener("click", (e) => { if (e.target === $("pgDate")) finishDate(null); });
    $("pgDateCal").addEventListener("click", (e) => {
        const nav = e.target.closest("[data-nav]");
        if (nav) {
            const d = new Date(dp.y, dp.m + Number(nav.dataset.nav), 1);
            dp.y = d.getFullYear(); dp.m = d.getMonth();
            renderDateCal();
            return;
        }
        if (e.target.closest("[data-reset]")) { dp.start = null; dp.end = null; renderDateCal(); return; }
        const btn = e.target.closest(".pg-day");
        if (!btn || btn.disabled) return;
        const d = btn.dataset.d;
        if (dp.mode === "range") {
            if (!dp.start || dp.end) { dp.start = d; dp.end = null; }     // mulai pilihan baru
            else if (d >= dp.start) { dp.end = d; }                        // tanggal akhir (boleh sama = 1 hari)
            renderDateCal();
            return;
        }
        dp.sel = d;
        if (dp.auto) { finishDate(d); return; }
        renderDateCal();
    });
    $("pgTimeOk").addEventListener("click", () => finishTime(`${pad(wheelIndex($("pgWheelH")))}:${pad(wheelIndex($("pgWheelM")))}`));
    $("pgTimeX").addEventListener("click", () => finishTime(null));
    $("pgTime").addEventListener("click", (e) => { if (e.target === $("pgTime")) finishTime(null); });
}

// opt: { value, focus, title, isEnabled, auto }
function pickDate(opt) {
    return new Promise((resolve) => {
        dp.resolve = resolve;
        dp.mode = "single";
        dp.auto = !!opt.auto;
        dp.isEnabled = opt.isEnabled || (() => true);
        dp.sel = opt.value || null;
        const base = parseYmd(opt.value || opt.focus || S.ctx.hari_ini);
        dp.y = base.getFullYear(); dp.m = base.getMonth();
        $("pgDateTitle").textContent = opt.title || "Pilih tanggal";
        $("pgDateOk").hidden = dp.auto;
        renderDateCal();
        openModal("pgDate");
    });
}

// opt: { start, end, title }
function pickRange(opt) {
    return new Promise((resolve) => {
        dp.resolve = resolve;
        dp.mode = "range";
        dp.auto = false;
        dp.isEnabled = () => true;
        dp.start = opt.start || null;
        dp.end = opt.end || null;
        const base = parseYmd(opt.start || S.ctx.hari_ini);
        dp.y = base.getFullYear(); dp.m = base.getMonth();
        $("pgDateTitle").textContent = opt.title || "Pilih tanggal";
        $("pgDateOk").hidden = false;
        renderDateCal();
        openModal("pgDate");
    });
}

function finishDate(v) {
    if (!dp.resolve) return;
    const r = dp.resolve; dp.resolve = null;
    closeModal("pgDate");
    r(v);
}

function renderDateCal() {
    const range = dp.mode === "range";
    const today = todayLocal();
    const choosingEnd = range && dp.start && !dp.end;
    const endEff = dp.end || dp.start;

    const body = monthRows(dp.y, dp.m).map(row => "<tr>" + row.map(day => {
        if (!day) return "<td></td>";
        const d = ymd(dp.y, dp.m, day);
        let tdCls = "", sel = false, disabled = false;
        if (range) {
            const inRange = dp.start && d >= dp.start && d <= endEff;
            tdCls = inRange ? `band${d === dp.start ? " band-start" : ""}${d === endEff ? " band-end" : ""}` : "";
            sel = d === dp.start || d === dp.end;
            disabled = !!(choosingEnd && d < dp.start);
        } else {
            sel = d === dp.sel;
            disabled = !dp.isEnabled(d);
        }
        const cls = `pg-day${d === today ? " today" : ""}${sel ? " sel" : ""}`;
        return `<td class="${tdCls}"><button type="button" class="${cls}" data-d="${d}" ${disabled ? "disabled" : ""}>${day}</button></td>`;
    }).join("") + "</tr>").join("");

    let foot = "";
    if (range) {
        let sum = "Ketuk tanggal awal.";
        if (dp.start && !dp.end) sum = `Awal: ${fmtTglLengkap(dp.start)}. Ketuk tanggal akhir (ketuk tanggal yang sama jika hanya 1 hari).`;
        if (dp.start && dp.end) sum = rangeText(dp.start, dp.end);
        foot = `<div class="pg-cal-foot"><div class="pg-cal-sum">${esc(sum)}</div><button type="button" class="pg-link-btn" data-reset="1" ${dp.start ? "" : "hidden"}>Ulangi</button></div>`;
    }

    $("pgDateCal").innerHTML = `
        <div class="pg-cal-head">
            <button type="button" class="pg-cal-nav" data-nav="-1" aria-label="Bulan sebelumnya"><i class="fa-solid fa-chevron-left"></i></button>
            <div class="pg-cal-title">${BULAN_PANJANG[dp.m]} ${dp.y}</div>
            <button type="button" class="pg-cal-nav" data-nav="1" aria-label="Bulan berikutnya"><i class="fa-solid fa-chevron-right"></i></button>
        </div>
        <table><thead><tr>${HARI_SINGKAT.map(h => `<th>${h}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table>
        ${foot}`;
    $("pgDateOk").disabled = range ? !(dp.start && dp.end) : !dp.sel;
}

// "2026-11-09" + "2026-11-12" -> "09 Nov 2026 - 12 Nov 2026 (4 hari)"
function rangeText(a, b) {
    const n = diffHari(a, b) + 1;
    return a === b ? `${fmtTglLengkap(a)} (1 hari)` : `${fmtTglLengkap(a)} - ${fmtTglLengkap(b)} (${n} hari)`;
}

// --- Roda jam: daftar bergulir dengan snap; baris di tengah = nilai terpilih
function buildWheels() {
    if (tp.built) return;
    tp.built = true;
    const fill = (el, n) => { el.innerHTML = Array.from({ length: n }, (_, i) => `<div class="pg-wheel-item" data-i="${i}">${pad(i)}</div>`).join(""); };
    fill($("pgWheelH"), 24);
    fill($("pgWheelM"), 60);
    ["pgWheelH", "pgWheelM"].forEach((id) => {
        const el = $(id);
        let t = null;
        el.addEventListener("scroll", () => { clearTimeout(t); t = setTimeout(() => markWheel(el), 90); }, { passive: true });
        el.addEventListener("click", (e) => {
            const it = e.target.closest(".pg-wheel-item");
            if (it) el.scrollTo({ top: Number(it.dataset.i) * ROW_H, behavior: "smooth" });
        });
    });
}
function wheelIndex(el) {
    const max = el.querySelectorAll(".pg-wheel-item").length - 1;
    return Math.max(0, Math.min(max, Math.round(el.scrollTop / ROW_H)));
}
function markWheel(el) {
    const i = wheelIndex(el);
    el.querySelectorAll(".pg-wheel-item").forEach(x => x.classList.toggle("sel", Number(x.dataset.i) === i));
}
function setWheel(el, i) { el.scrollTop = i * ROW_H; markWheel(el); }

function pickTime(value, title) {
    return new Promise((resolve) => {
        tp.resolve = resolve;
        buildWheels();
        $("pgTimeTitle").textContent = title || "Pilih jam";
        openModal("pgTime");
        const [h, m] = String(value || "08:00").split(":").map(Number);
        requestAnimationFrame(() => { setWheel($("pgWheelH"), h || 0); setWheel($("pgWheelM"), m || 0); });
    });
}
function finishTime(v) {
    if (!tp.resolve) return;
    const r = tp.resolve; tp.resolve = null;
    closeModal("pgTime");
    r(v);
}

// ===================================================
// KELOMPOK 8: KOMPONEN ISIAN (kolom ketuk, Alasan, Lampiran)
// Fungsi: potongan tampilan yang dipakai berulang di keempat form.
//  - Kolom ketuk : tampil seperti kolom biasa dengan ikon di kanan; diketuk
//    membuka pemilih tanggal / jam. Nilai sebenarnya disimpan di atribut
//    data-value (tanggal "YYYY-MM-DD", waktu "YYYY-MM-DD HH:MM").
//  - Alasan      : kotak teks dengan penghitung karakter (maks KET_MAX).
//  - Lampiran    : kotak putus-putus bertanda +, satu file per pengajuan.
// ===================================================
function tapFieldHtml(id, label, icon, opt) {
    const o = opt || {};
    return `
        <div class="pg-field" ${o.flush ? 'style="margin-bottom:0"' : ""}>
            <label class="pg-label" for="${id}">${esc(label)}${o.wajib ? ' <span class="pg-req">*</span>' : ""}</label>
            <div class="pg-tap" data-tap="${id}">
                <input type="text" class="pg-input" id="${id}" readonly inputmode="none" placeholder="${esc(o.placeholder || "")}" data-value="">
                <i class="${icon} pg-tap-icon"></i>
            </div>
        </div>`;
}
function setTap(id, value, text) { const el = $(id); el.dataset.value = value || ""; el.value = value ? text : ""; }
function tapValue(id) { return $(id).dataset.value || ""; }

// Alasan / Keterangan: tidak wajib, kecuali Cuti jenis "Sakit" (tanda * dipasang oleh form Cuti)
function ketFieldHtml(id, label) {
    return `
        <div class="pg-field">
            <label class="pg-label" for="${id}">${esc(label)}<span class="pg-req" id="${id}Req" hidden> *</span></label>
            <textarea class="pg-input" id="${id}" maxlength="${KET_MAX}"></textarea>
            <div class="pg-count" id="${id}Cnt">0/${KET_MAX}</div>
        </div>`;
}
function getKet(id, jenis, label) {
    const v = $(id).value.trim();
    if (jenis === "cuti") {
        const m = cutiTerpilih();
        if (m && KET_WAJIB_CUTI.test(m.nama) && !v) throw new Error(`${label} wajib diisi untuk cuti "${m.nama}".`);
    }
    return v;
}

// --- Dropdown dengan kolom cari di dalamnya (dipakai "Menggantikan").
//     Diketuk membuka panel berisi kolom cari + daftar; memilih satu baris menutup panel.
function comboHtml(id, label, placeholder, wajib, hint) {
    return `
        <div class="pg-field">
            <div class="pg-combo">
                <label class="pg-label" for="${id}">${esc(label)}${wajib ? ' <span class="pg-req">*</span>' : ""}</label>
                <div class="pg-tap" data-tap="${id}">
                    <input type="text" class="pg-input" id="${id}" readonly inputmode="none" placeholder="${esc(placeholder)}" data-value="">
                    <i class="fa-solid fa-chevron-down pg-tap-icon"></i>
                </div>
                <div class="pg-combo-panel" id="${id}Panel" hidden>
                    <input type="search" class="pg-input pg-combo-search" id="${id}Search" data-combo="${id}" placeholder="Cari NIK atau nama" autocomplete="off">
                    <div class="pg-combo-list" id="${id}List"></div>
                </div>
            </div>
            ${hint ? `<div class="pg-hint">${esc(hint)}</div>` : ""}
        </div>`;
}
function renderComboList(id) {
    const c = S.combos[id];
    if (!c) return;
    const q = ($(id + "Search").value || "").trim().toLowerCase();
    const found = c.items.filter(i => !q || i.text.toLowerCase().includes(q)).slice(0, 100);
    $(id + "List").innerHTML = found.length
        ? found.map(i => `<div class="pg-combo-item${i.value === tapValue(id) ? " sel" : ""}" data-combo="${id}" data-v="${esc(i.value)}">${esc(i.text)}</div>`).join("")
        : `<div class="pg-combo-empty">${c.loading ? "Memuat..." : "Tidak ada hasil"}</div>`;
}
function filterCombo(id) { renderComboList(id); }
function closeCombos() { document.querySelectorAll(".pg-combo-panel").forEach(p => { p.hidden = true; }); }
function toggleCombo(id) {
    const panel = $(id + "Panel");
    const willOpen = panel.hidden;
    closeCombos();
    if (!willOpen) return;
    panel.hidden = false;
    $(id + "Search").value = "";
    renderComboList(id);
    $(id + "Search").focus();
    panel.scrollIntoView({ block: "nearest" });
}
function pickComboItem(el) {
    const id = el.dataset.combo;
    const c = S.combos[id];
    const it = c && c.items.find(x => x.value === el.dataset.v);
    if (it) setTap(id, it.value, it.text);
    closeCombos();
}

function fileFieldHtml(opt) {
    return `
        <div class="pg-field">
            <label class="pg-label">${esc(opt.label)}<span class="pg-req" id="${opt.id}Req" ${opt.wajib ? "" : "hidden"}> *</span></label>
            <div class="pg-attach" id="${opt.id}Box">
                <button type="button" class="pg-attach-add" data-attach-add="${opt.id}" aria-label="Tambah file"><i class="fa-solid fa-plus"></i></button>
            </div>
            <input type="file" id="${opt.id}" accept="${opt.accept}" hidden>
            <div class="pg-hint">${esc(opt.hint)}</div>
        </div>`;
}

// Saat edit: beri tahu bahwa lampiran lama tetap dipakai bila tidak memilih file baru
function noteAttach(id, path) {
    if (!path) return;
    $(id + "Box").insertAdjacentHTML("afterend", '<div class="pg-hint">Lampiran sebelumnya tetap dipakai kecuali Anda memilih file baru.</div>');
}

// Menggambar ulang kotak lampiran: tanda + (kosong) atau pratinjau + tombol hapus
function renderAttach(id) {
    const box = $(id + "Box");
    if (box.dataset.url) { URL.revokeObjectURL(box.dataset.url); delete box.dataset.url; }
    const f = $(id).files[0];
    if (!f) {
        box.innerHTML = `<button type="button" class="pg-attach-add" data-attach-add="${id}" aria-label="Tambah file"><i class="fa-solid fa-plus"></i></button>`;
        return;
    }
    const del = `<button type="button" class="pg-attach-del" data-attach-del="${id}" aria-label="Hapus file"><i class="fa-solid fa-xmark"></i></button>`;
    if (/^image\//i.test(f.type)) {
        const url = URL.createObjectURL(f);
        box.dataset.url = url;
        box.innerHTML = `<div class="pg-attach-item"><img src="${url}" alt="Lampiran">${del}</div>`;
    } else {
        box.innerHTML = `<div class="pg-attach-item pg-attach-file"><i class="fa-regular fa-file-pdf"></i><span>${esc(f.name)}</span>${del}</div>`;
    }
}

// Info satu tanggal dari server: shift, waktu Clock In/Out aktif, penanda pengajuan menunggu
async function fetchInfo(tgl) {
    const { data, error } = await hrd().rpc("pengajuan_info_tanggal", { p_tanggal: tgl });
    if (error) throw error;
    return data;
}

// Memuat daftar sekali saja (cuti, shift, karyawan, mitra)
async function cached(key, rpcName) {
    if (S.cache[key]) return S.cache[key];
    const { data, error } = await hrd().rpc(rpcName);
    if (error) throw error;
    S.cache[key] = data;
    return data;
}

// ===================================================
// KELOMPOK 9: FILE LAMPIRAN (KOMPRES & UNGGAH)
// Fungsi: foto dikecilkan di HP (sisi terpanjang 1600 px, JPEG) sebelum
// diunggah; PDF (hanya Cuti) diunggah apa adanya. File asli maksimal 10 MB.
// Jalur: {id_karyawan}/pengajuan/{jenis}/{waktu}_{acak}.{jpg|pdf}
// ===================================================
async function compressImage(file) {
    let src;
    try { src = await createImageBitmap(file, { imageOrientation: "from-image" }); }
    catch (err) {
        src = await new Promise((resolve, reject) => {
            const img = new Image();
            const url = URL.createObjectURL(file);
            img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Gambar tidak terbaca.")); };
            img.src = url;
        });
    }
    const w0 = src.width || src.naturalWidth, h0 = src.height || src.naturalHeight;
    const scale = Math.min(1, IMG_MAX_SIDE / Math.max(w0, h0));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w0 * scale);
    canvas.height = Math.round(h0 * scale);
    canvas.getContext("2d").drawImage(src, 0, 0, canvas.width, canvas.height);
    if (src.close) src.close();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", IMG_QUALITY));
    if (!blob) throw new Error("Foto gagal diproses.");
    return blob;
}

async function uploadFile(file, jenis, allowPdf) {
    if (file.size > MAX_FILE_BYTES) throw new Error(`File terlalu besar (maksimal ${MAX_FILE_BYTES / 1024 / 1024} MB).`);
    let blob, ext, type;
    if (/^image\//i.test(file.type)) {
        blob = await compressImage(file); ext = "jpg"; type = "image/jpeg";
    } else if (allowPdf && file.type === "application/pdf") {
        blob = file; ext = "pdf"; type = "application/pdf";
    } else {
        throw new Error(allowPdf ? "File harus berupa foto atau PDF." : "File harus berupa foto.");
    }
    const path = `${S.ctx.employee_id}/pengajuan/${jenis}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error } = await supabaseClient.storage.from(BUCKET).upload(path, blob, { contentType: type, upsert: false });
    if (error) throw new Error("File gagal diunggah: " + error.message);
    return path;
}

// ===================================================
// KELOMPOK 10: FORM CUTI -> hrd.time_off_assignments
// Isian: Jenis Cuti (sudah disaring cost center oleh server), Tanggal (kolom
// ketuk -> kalender rentang), Alasan (wajib hanya untuk jenis "Sakit"),
// Unggah File (wajib jika jenis cuti mewajibkan lampiran).
// ===================================================
const rng = { start: null, end: null };      // rentang tanggal cuti terpilih

function renderCuti() {
    $("pgFormBody").innerHTML = `
        <div class="pg-field">
            <label class="pg-label" for="fCutiJenis">Jenis Cuti <span class="pg-req">*</span></label>
            <select class="pg-input" id="fCutiJenis"><option value="">Memuat...</option></select>
            <div class="pg-hint" id="fCutiHint"></div>
        </div>
        ${tapFieldHtml("fCutiTgl", "Tanggal", "fa-regular fa-calendar", { wajib: true, placeholder: "Pilih tanggal cuti" })}
        ${ketFieldHtml("fKet", "Alasan", "cuti")}
        ${fileFieldHtml({ id: "fFile", label: "Unggah File", wajib: false, accept: "image/*,application/pdf", hint: "Foto atau PDF, maksimal 10 MB." })}`;

    const ed = S.edit && S.edit.data;
    rng.start = null; rng.end = null;
    if (ed) {
        rng.start = ed.start_date; rng.end = ed.end_date;
        setTap("fCutiTgl", rng.start, rangeText(rng.start, rng.end));
        $("fKet").value = ed.keterangan || "";
        $("fKetCnt").textContent = `${$("fKet").value.length}/${KET_MAX}`;
        noteAttach("fFile", ed.attachment);
    }
    S.taps.fCutiTgl = async () => {
        const v = await pickRange({ start: rng.start, end: rng.end, title: "Pilih tanggal cuti" });
        if (v) { rng.start = v.start; rng.end = v.end; setTap("fCutiTgl", v.start, rangeText(v.start, v.end)); }
    };

    $("fCutiJenis").addEventListener("change", updateCutiInfo);
    cached("cuti", "pengajuan_jenis_cuti").then((list) => {
        if (S.jenis !== "cuti") return;
        $("fCutiJenis").innerHTML = list.length
            ? `<option value="">Pilih Jenis Cuti</option>` + list.map(m => `<option value="${esc(m.id)}">${esc(m.nama)}</option>`).join("")
            : `<option value="">Tidak ada jenis cuti untuk Anda</option>`;
        if (ed) { $("fCutiJenis").value = String(ed.time_off_id); updateCutiInfo(); }
    }).catch((err) => {
        if (S.jenis !== "cuti") return;
        $("fCutiJenis").innerHTML = `<option value="">Gagal memuat</option>`;
        setMsg("Gagal memuat jenis cuti: " + err.message, "danger");
    });
}

function cutiTerpilih() {
    const sel = $("fCutiJenis");
    if (!sel) return null;
    return (S.cache.cuti || []).find(m => String(m.id) === sel.value) || null;
}

// Tanda * pada Alasan dan Unggah File mengikuti jenis cuti yang dipilih
function updateCutiInfo() {
    const m = cutiTerpilih();
    $("fFileReq").hidden = !(m && m.wajib_lampiran);
    $("fKetReq").hidden = !(m && KET_WAJIB_CUTI.test(m.nama));
    let hint = "";
    if (m && m.wajib_lampiran) hint += "Jenis cuti ini wajib melampirkan file. ";
    if (m && m.saldo_tipe === "limit" && m.saldo_jumlah_hari != null) hint += `Jatah ${m.saldo_jumlah_hari} hari per tahun.`;
    $("fCutiHint").textContent = hint;
}

function collectCuti() {
    const m = cutiTerpilih();
    if (!m) throw new Error("Pilih Jenis Cuti.");
    if (!rng.start || !rng.end) throw new Error("Pilih tanggal cuti.");
    const ket = getKet("fKet", "cuti", "Alasan");
    const file = $("fFile").files[0] || null;
    const adaLama = !!(S.edit && S.edit.data && S.edit.data.attachment);
    if (m.wajib_lampiran && !file && !adaLama) throw new Error(`Jenis cuti "${m.nama}" wajib melampirkan file.`);
    return {
        rpc: "ajukan_cuti", file, allowPdf: true, fileKey: "attachment",
        payload: { time_off_id: m.id, start_date: rng.start, end_date: rng.end, keterangan: ket }
    };
}

// ===================================================
// KELOMPOK 11: FORM ABSENSI (KOREKSI) -> hrd.absensi
// Isian: Tanggal presensi, Shift (hanya tampil), Waktu clock in, Waktu clock out
// (tanggal + jam), Alasan (wajib), Lampiran foto (opsional).
// Waktu lama ditampilkan dari data aktif (kosong jika belum ada). Hanya waktu yang
// DIUBAH yang dikirim: ubah 1 = 1 baris pengajuan, ubah keduanya = 2 baris.
// Tanggal waktu yang bisa dipilih: 1 hari sebelum tanggal presensi, tanggal
// presensi itu sendiri, dan 1 hari sesudahnya HANYA untuk shift lintas hari.
// Tanggal setelah hari ini tidak bisa dipilih. Server memeriksa ulang semuanya.
// ===================================================
function absenTanggalBoleh(tgl, info) {
    const lintas = !!(info && info.shift && info.shift.lintas_hari);
    const list = [addDays(tgl, -1), tgl];
    if (lintas) list.push(addDays(tgl, 1));
    return list.filter(d => d <= S.ctx.hari_ini);
}

function renderAbsensi() {
    $("pgFormBody").innerHTML = `
        ${tapFieldHtml("fTgl", "Tanggal presensi", "fa-regular fa-calendar", { wajib: true })}
        <div class="pg-field">
            <label class="pg-label" for="fShift">Shift</label>
            <input type="text" class="pg-input" id="fShift" readonly>
        </div>
        ${tapFieldHtml("fIn", "Waktu clock in", "fa-regular fa-clock", { placeholder: "Pilih waktu clock in" })}
        ${tapFieldHtml("fOut", "Waktu clock out", "fa-regular fa-clock", { placeholder: "Pilih waktu clock out" })}
        <div class="pg-hint" id="fAbsenHint" style="margin: -6px 0 14px;"></div>
        ${ketFieldHtml("fKet", "Alasan", "absensi")}
        ${fileFieldHtml({ id: "fFile", label: "Lampiran", wajib: false, accept: "image/*", hint: "Foto, maksimal 10 MB. Foto dikecilkan otomatis sebelum diunggah." })}`;

    const ed = S.edit && S.edit.data;
    setTap("fTgl", ed ? ed.tanggal_kerja : S.ctx.hari_ini, fmtTglLengkap(ed ? ed.tanggal_kerja : S.ctx.hari_ini));
    if (ed) {
        // Edit: tanggal presensi dikunci (untuk tanggal lain, ajukan koreksi baru)
        $("fTgl").closest(".pg-tap").style.opacity = "0.6";
        $("fTgl").closest(".pg-field").insertAdjacentHTML("beforeend", '<div class="pg-hint">Tanggal presensi tidak bisa diubah. Untuk tanggal lain, ajukan koreksi baru.</div>');
        $("fKet").value = ed.keterangan || "";
        $("fKetCnt").textContent = `${$("fKet").value.length}/${KET_MAX}`;
        noteAttach("fFile", ed.attachment);
    } else {
        S.taps.fTgl = async () => {
            const v = await pickDate({ value: tapValue("fTgl"), title: "Pilih tanggal", isEnabled: d => d <= S.ctx.hari_ini });
            if (v) { setTap("fTgl", v, fmtTglLengkap(v)); loadAbsenInfo(); }
        };
    }
    S.taps.fIn = () => editWaktu("fIn", "clock_in");
    S.taps.fOut = () => editWaktu("fOut", "clock_out");
    loadAbsenInfo();
}

// Ketuk kolom waktu: pilih tanggal (hanya yang boleh), lalu jam, lalu terisi "19 Nov 2026, 08:00"
async function editWaktu(id, tipe) {
    if (!S.info) { setMsg("Data tanggal belum termuat. Tunggu sebentar lalu coba lagi.", "warn"); return; }
    const tgl = tapValue("fTgl");
    const boleh = absenTanggalBoleh(tgl, S.info);
    const cur = tapValue(id);
    const date = await pickDate({
        value: cur ? cur.slice(0, 10) : null, focus: tgl, title: "Pilih tanggal",
        isEnabled: d => boleh.includes(d), auto: true      // begitu tanggal diketuk, langsung lanjut ke pemilih jam
    });
    if (!date) return;
    const s = S.info.shift;
    const awal = cur ? cur.slice(11, 16) : ((s && (tipe === "clock_in" ? s.jam_masuk : s.jam_pulang)) || "08:00");
    const jam = await pickTime(awal, tipe === "clock_in" ? "Waktu clock in" : "Waktu clock out");
    if (!jam) return;
    setTap(id, `${date} ${jam}`, fmtWaktu(`${date} ${jam}`));
    setMsg("");
}

async function loadAbsenInfo() {
    const tgl = tapValue("fTgl");
    if (!tgl) return;
    const my = ++S.infoReq;
    S.info = null;
    $("fShift").value = "Memuat...";
    setTap("fIn", "", ""); setTap("fOut", "", "");
    $("fAbsenHint").textContent = "";
    try {
        const info = await fetchInfo(tgl);
        if (my !== S.infoReq || S.jenis !== "absensi") return;
        S.info = info;
        $("fShift").value = shiftText(info.shift);
        setTap("fIn", info.clock_in || "", info.clock_in ? fmtWaktu(info.clock_in) : "");
        setTap("fOut", info.clock_out || "", info.clock_out ? fmtWaktu(info.clock_out) : "");
        const notes = [];
        const ed = S.edit && S.edit.data;
        if (ed) {
            // Edit: yang sedang diajukan tampil menggantikan waktu aktif
            if (ed.clock_in) setTap("fIn", ed.clock_in, fmtWaktu(ed.clock_in));
            if (ed.clock_out) setTap("fOut", ed.clock_out, fmtWaktu(ed.clock_out));
        } else {
            if (info.menunggu_in) notes.push("Ada pengajuan Clock In yang masih menunggu persetujuan.");
            if (info.menunggu_out) notes.push("Ada pengajuan Clock Out yang masih menunggu persetujuan.");
        }
        if (!info.clock_in && !info.clock_out) notes.push("Belum ada data absen pada tanggal ini.");
        $("fAbsenHint").textContent = notes.join(" ");
    } catch (err) {
        if (my !== S.infoReq || S.jenis !== "absensi") return;
        $("fShift").value = "-";
        setMsg("Gagal memuat data tanggal ini: " + err.message, "danger");
    }
}

function collectAbsensi() {
    const tgl = tapValue("fTgl");
    if (!tgl) throw new Error("Tanggal presensi wajib diisi.");
    if (tgl > S.ctx.hari_ini) throw new Error("Tanggal presensi tidak boleh di masa depan.");
    if (!S.info) throw new Error("Data tanggal belum termuat. Pilih ulang tanggal.");

    const inNow = tapValue("fIn"), outNow = tapValue("fOut");
    const inOld = S.info.clock_in || "", outOld = S.info.clock_out || "";
    const payload = { tanggal_kerja: tgl };
    if (inNow && inNow !== inOld) payload.clock_in = inNow;
    if (outNow && outNow !== outOld) payload.clock_out = outNow;
    if (!payload.clock_in && !payload.clock_out) throw new Error("Belum ada perubahan waktu. Ubah waktu clock in atau clock out terlebih dahulu.");

    const boleh = absenTanggalBoleh(tgl, S.info);
    if (payload.clock_in && !boleh.includes(payload.clock_in.slice(0, 10))) throw new Error("Tanggal waktu clock in tidak diperbolehkan untuk tanggal presensi ini.");
    if (payload.clock_out && !boleh.includes(payload.clock_out.slice(0, 10))) throw new Error("Tanggal waktu clock out tidak diperbolehkan untuk tanggal presensi ini.");
    const effIn = payload.clock_in || inOld, effOut = payload.clock_out || outOld;
    if (effIn && effOut && effOut <= effIn) throw new Error("Waktu clock out harus setelah clock in.");

    payload.keterangan = getKet("fKet", "absensi", "Alasan");
    return { rpc: "ajukan_absensi", file: $("fFile").files[0] || null, allowPdf: false, fileKey: "foto_path", payload };
}

// ===================================================
// KELOMPOK 12: FORM PERUBAHAN SHIFT -> hrd.jadwal_assignments
// Isian: Tanggal (hari ini atau setelahnya), Shift Sekarang (hanya tampil),
// Shift Baru (nama + jam masuk - pulang; yang dikirim kodenya), Alasan.
// ===================================================
function renderShift() {
    $("pgFormBody").innerHTML = `
        ${tapFieldHtml("fTgl", "Tanggal pengajuan", "fa-regular fa-calendar", { wajib: true })}
        <div class="pg-field">
            <label class="pg-label" for="fShift">Shift Sekarang</label>
            <input type="text" class="pg-input" id="fShift" readonly>
        </div>
        <div class="pg-field">
            <label class="pg-label" for="fShiftBaru">Shift Baru <span class="pg-req">*</span></label>
            <select class="pg-input" id="fShiftBaru"><option value="">Memuat...</option></select>
            <div class="pg-hint" id="fShiftHint"></div>
        </div>
        ${ketFieldHtml("fKet", "Alasan", "shift")}`;

    const ed = S.edit && S.edit.data;
    const tgl = ed ? ed.tanggal : S.ctx.hari_ini;
    setTap("fTgl", tgl, fmtTglLengkap(tgl));
    if (ed) {
        $("fKet").value = ed.keterangan || "";
        $("fKetCnt").textContent = `${$("fKet").value.length}/${KET_MAX}`;
    }
    S.taps.fTgl = async () => {
        const v = await pickDate({ value: tapValue("fTgl"), title: "Pilih tanggal", isEnabled: d => d >= S.ctx.hari_ini });
        if (v) { setTap("fTgl", v, fmtTglLengkap(v)); loadShiftInfo(); }
    };
    loadShiftInfo();
}

async function loadShiftInfo() {
    const tgl = tapValue("fTgl");
    if (!tgl) return;
    const my = ++S.infoReq;
    $("fShift").value = "Memuat...";
    $("fShiftBaru").innerHTML = `<option value="">Memuat...</option>`;
    $("fShiftHint").textContent = "";
    try {
        const [info, daftar] = await Promise.all([fetchInfo(tgl), cached("shift", "pengajuan_daftar_shift")]);
        if (my !== S.infoReq || S.jenis !== "shift") return;
        S.info = info;
        $("fShift").value = shiftText(info.shift);
        const kodeNow = info.shift ? info.shift.kode_shift : null;
        const opts = daftar.filter(s => s.kode !== kodeNow).map(s => {
            const jam = s.jam_masuk ? ` (${s.jam_masuk} - ${s.jam_pulang})` : "";
            return `<option value="${esc(s.kode)}">${esc(s.nama + jam)}</option>`;
        });
        $("fShiftBaru").innerHTML = `<option value="">Pilih Shift Baru</option>` + opts.join("");
        if (S.edit && S.edit.data && S.edit.data.kode_shift) $("fShiftBaru").value = S.edit.data.kode_shift;
        if (info.menunggu_shift && !S.edit) $("fShiftHint").textContent = "Sudah ada pengajuan perubahan shift tanggal ini yang menunggu persetujuan.";
    } catch (err) {
        if (my !== S.infoReq || S.jenis !== "shift") return;
        $("fShift").value = "-";
        $("fShiftBaru").innerHTML = `<option value="">Gagal memuat</option>`;
        setMsg("Gagal memuat data: " + err.message, "danger");
    }
}

function collectShift() {
    const tgl = tapValue("fTgl");
    if (!tgl) throw new Error("Tanggal pengajuan wajib diisi.");
    if (tgl < S.ctx.hari_ini) throw new Error("Perubahan shift tidak bisa untuk tanggal yang sudah lewat.");
    const kode = $("fShiftBaru").value;
    if (!kode) throw new Error("Pilih Shift Baru.");
    const ket = getKet("fKet", "shift", "Alasan");
    return { rpc: "ajukan_perubahan_shift", file: null, allowPdf: false, fileKey: null, payload: { tanggal: tgl, kode_shift: kode, keterangan: ket } };
}

// ===================================================
// KELOMPOK 13: FORM LEMBUR -> hrd.lembur_assignments (+ karyawan_pengganti)
// Sub header "Jadwal Lembur": Tanggal, Shift (hanya tampil), kotak Lembur
// Sebelum Shift dan Lembur Setelah Shift (durasi lembur + durasi istirahat,
// diisi dengan roda jam format hh:mm seperti jam absensi).
// Sub header "Informasi Tambahan": Jenis Lembur (default Pengganti):
//   Pengganti -> Menggantikan (satu dropdown dengan kolom cari; NIK + nama,
//                satu departemen dan cost center dengan pengguna)
//   Casual    -> Mitra (cost center) dan Area, hanya yang satu cabang dengan pengguna
//   Overtime  -> tidak ada isian tambahan
// lalu Keterangan (tidak wajib) dan Lampiran foto (opsional).
// ===================================================
const OT_FIELDS = [
    { id: "fObOt",  title: "Durasi lembur sebelum shift" },
    { id: "fObBrk", title: "Durasi istirahat sebelum shift" },
    { id: "fOaOt",  title: "Durasi lembur setelah shift" },
    { id: "fOaBrk", title: "Durasi istirahat setelah shift" }
];

function otBoxHtml(judul, prefix) {
    return `
        <div class="pg-box">
            <div class="pg-box-title">${esc(judul)}</div>
            <div class="pg-two">
                ${tapFieldHtml(prefix + "Ot", "Durasi Lembur", "fa-regular fa-clock", { flush: true })}
                ${tapFieldHtml(prefix + "Brk", "Durasi Istirahat", "fa-regular fa-clock", { flush: true })}
            </div>
        </div>`;
}

function renderLembur() {
    $("pgFormBody").innerHTML = `
        <div class="pg-subhead">Jadwal Lembur</div>
        ${tapFieldHtml("fTgl", "Tanggal lembur", "fa-regular fa-calendar", { wajib: true })}
        <div class="pg-field">
            <label class="pg-label" for="fShift">Shift</label>
            <input type="text" class="pg-input" id="fShift" readonly>
        </div>
        <div class="pg-hint" id="fLemburHint" style="margin: -6px 0 12px;"></div>
        ${otBoxHtml("Lembur Sebelum Shift", "fOb")}
        ${otBoxHtml("Lembur Setelah Shift", "fOa")}

        <div class="pg-subhead">Informasi Tambahan</div>
        <div class="pg-field">
            <label class="pg-label" for="fTipe">Jenis Lembur <span class="pg-req">*</span></label>
            <select class="pg-input" id="fTipe">${OT_TIPE.map(t => `<option value="${t}">${t}</option>`).join("")}</select>
        </div>
        <div id="fTipeExtra"></div>
        ${ketFieldHtml("fKet", "Keterangan", "lembur")}
        ${fileFieldHtml({ id: "fFile", label: "Lampiran", wajib: false, accept: "image/*", hint: "Foto, maksimal 10 MB. Foto dikecilkan otomatis sebelum diunggah." })}`;

    const ed = S.edit && S.edit.data;
    $("fTipe").value = ed ? ed.type_ot : "Pengganti";          // default Pengganti
    const tgl = ed ? ed.tanggal : S.ctx.hari_ini;
    setTap("fTgl", tgl, fmtTglLengkap(tgl));
    S.taps.fTgl = async () => {
        const v = await pickDate({ value: tapValue("fTgl"), title: "Pilih tanggal" });
        if (v) { setTap("fTgl", v, fmtTglLengkap(v)); loadLemburInfo(); }
    };
    // Durasi: awalnya 00:00 (atau nilai pengajuan saat edit), diketuk membuka roda jam (hh:mm)
    const nilai = ed ? { fObOt: ed.ot_before, fObBrk: ed.break_before, fOaOt: ed.ot_after, fOaBrk: ed.break_after } : {};
    OT_FIELDS.forEach((f) => {
        const v0 = nilai[f.id] || "00:00";
        setTap(f.id, v0, v0);
        S.taps[f.id] = async () => {
            const v = await pickTime(tapValue(f.id) || "00:00", f.title);
            if (v) setTap(f.id, v, v);
        };
    });
    $("fTipe").addEventListener("change", renderTipeExtra);
    renderTipeExtra();
    if (ed) {
        $("fKet").value = ed.keterangan || "";
        $("fKetCnt").textContent = `${$("fKet").value.length}/${KET_MAX}`;
        noteAttach("fFile", ed.attachment);
        if (ed.type_ot === "Pengganti" && ed.karyawan_absen_id) setTap("fMenggantikan", ed.karyawan_absen_id, ed.karyawan_absen_label || "");
    }
    loadLemburInfo();
}

async function loadLemburInfo() {
    const tgl = tapValue("fTgl");
    if (!tgl) return;
    const my = ++S.infoReq;
    $("fShift").value = "Memuat...";
    $("fLemburHint").textContent = "";
    try {
        const info = await fetchInfo(tgl);
        if (my !== S.infoReq || S.jenis !== "lembur") return;
        S.info = info;
        $("fShift").value = shiftText(info.shift);
        const notes = [];
        if (info.menunggu_lembur && !S.edit) notes.push("Sudah ada pengajuan lembur tanggal ini yang menunggu persetujuan.");
        if (!info.shift) notes.push("Tidak ada jadwal shift pada tanggal ini. Lembur Pengganti dan Casual membutuhkan jadwal shift.");
        else if (info.shift.jenis && info.shift.jenis !== "kerja") notes.push("Tanggal ini hari libur. Jam lembur hanya ikut terbaca di kartu absen pada tanggal dengan shift kerja.");
        $("fLemburHint").textContent = notes.join(" ");
    } catch (err) {
        if (my !== S.infoReq || S.jenis !== "lembur") return;
        S.info = null;
        $("fShift").value = "-";
        setMsg("Gagal memuat data tanggal ini: " + err.message, "danger");
    }
}

// Isian tambahan yang berubah sesuai Jenis Lembur
function renderTipeExtra() {
    const tipe = $("fTipe").value;
    const box = $("fTipeExtra");
    closeCombos();
    if (tipe === "Pengganti") {
        box.innerHTML = comboHtml("fMenggantikan", "Menggantikan", "Pilih karyawan", true,
            "Hanya karyawan dengan departemen dan cost center yang sama dengan Anda.");
        S.combos.fMenggantikan = { items: [], loading: true };
        S.taps.fMenggantikan = () => toggleCombo("fMenggantikan");
        cached("karyawan", "pengajuan_daftar_karyawan").then((list) => {
            S.combos.fMenggantikan = { items: list.map(k => ({ value: k.id, text: `${k.nik} - ${k.nama}` })), loading: false };
            if ($("fMenggantikan")) renderComboList("fMenggantikan");
        }).catch((err) => {
            S.combos.fMenggantikan = { items: [], loading: false };
            setMsg("Gagal memuat daftar karyawan: " + err.message, "danger");
        });
    } else if (tipe === "Casual") {
        box.innerHTML = `
            <div class="pg-two">
                <div class="pg-field">
                    <label class="pg-label" for="fMitra">Mitra <span class="pg-req">*</span></label>
                    <select class="pg-input" id="fMitra"><option value="">Memuat...</option></select>
                </div>
                <div class="pg-field">
                    <label class="pg-label" for="fArea">Area <span class="pg-req">*</span></label>
                    <select class="pg-input" id="fArea"><option value="">Memuat...</option></select>
                </div>
            </div>`;
        cached("mitra", "pengajuan_daftar_mitra").then((d) => {
            if (S.jenis !== "lembur" || $("fTipe").value !== "Casual") return;
            $("fMitra").innerHTML = `<option value="">Pilih Mitra</option>` + (d.costcenter || []).map(c => `<option value="${esc(c.id)}">${esc(c.nama)}</option>`).join("");
            $("fArea").innerHTML = `<option value="">Pilih Area</option>` + (d.area || []).map(a => `<option value="${esc(a.id)}">${esc(a.nama)}</option>`).join("");
            const ed = S.edit && S.edit.data;
            if (ed && ed.type_ot === "Casual") {
                $("fMitra").value = String(ed.absen_costcenter_id || "");
                $("fArea").value = String(ed.absen_area_id || "");
            }
        }).catch((err) => {
            if ($("fMitra")) { $("fMitra").innerHTML = `<option value="">Gagal memuat</option>`; $("fArea").innerHTML = `<option value="">Gagal memuat</option>`; }
            setMsg("Gagal memuat daftar Mitra/Area: " + err.message, "danger");
        });
    } else {
        box.innerHTML = "";                                    // Overtime: tanpa isian tambahan
    }
}

function collectLembur() {
    const tgl = tapValue("fTgl");
    if (!tgl) throw new Error("Tanggal Lembur wajib diisi.");

    const ob = tapValue("fObOt") || "00:00", bb = tapValue("fObBrk") || "00:00";
    const oa = tapValue("fOaOt") || "00:00", ba = tapValue("fOaBrk") || "00:00";
    if (toMenit(ob) === 0 && toMenit(oa) === 0) throw new Error("Isi durasi lembur sebelum atau setelah shift.");
    if (toMenit(ob) > OT_MAX_MENIT || toMenit(oa) > OT_MAX_MENIT) throw new Error(`Durasi lembur maksimal ${OT_MAX_MENIT / 60} jam.`);
    if (toMenit(bb) > BREAK_MAX_MENIT || toMenit(ba) > BREAK_MAX_MENIT) throw new Error(`Durasi istirahat maksimal ${BREAK_MAX_MENIT / 60} jam.`);
    if (toMenit(ob) === 0 && toMenit(bb) > 0) throw new Error("Istirahat sebelum shift tidak boleh diisi tanpa durasi lembur.");
    if (toMenit(oa) === 0 && toMenit(ba) > 0) throw new Error("Istirahat setelah shift tidak boleh diisi tanpa durasi lembur.");
    if (toMenit(bb) >= toMenit(ob) && toMenit(bb) > 0) throw new Error("Istirahat sebelum shift harus lebih kecil dari durasi lembur.");
    if (toMenit(ba) >= toMenit(oa) && toMenit(ba) > 0) throw new Error("Istirahat setelah shift harus lebih kecil dari durasi lembur.");

    const tipe = $("fTipe").value;
    const payload = { tanggal: tgl, type_ot: tipe, ot_before: ob, break_before: bb, ot_after: oa, break_after: ba };

    if (tipe === "Pengganti") {
        const id = $("fMenggantikan") ? tapValue("fMenggantikan") : "";
        if (!id) throw new Error("Pilih karyawan yang digantikan.");
        payload.karyawan_absen_id = id;
    } else if (tipe === "Casual") {
        const mitra = $("fMitra") ? $("fMitra").value : "";
        const area = $("fArea") ? $("fArea").value : "";
        if (!mitra) throw new Error("Pilih Mitra.");
        if (!area) throw new Error("Pilih Area.");
        payload.absen_costcenter_id = Number(mitra);
        payload.absen_area_id = Number(area);
    }
    if (tipe !== "Overtime" && S.info && !(S.info.shift && S.info.shift.kode_shift)) {
        throw new Error(`Lembur ${tipe} membutuhkan jadwal shift pada tanggal ini.`);
    }

    payload.keterangan = getKet("fKet", "lembur", "Keterangan");
    return { rpc: "ajukan_lembur", file: $("fFile").files[0] || null, allowPdf: false, fileKey: "attachment", payload };
}