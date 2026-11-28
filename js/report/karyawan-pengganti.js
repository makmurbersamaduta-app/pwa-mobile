// ===================================================
// karyawan-pengganti.js  (versi 2)
// PWA - halaman "Karyawan Pengganti": supervisor menugaskan karyawan menggantikan karyawan
// yang absen (Pengganti) atau sebagai tenaga Casual. Mengisi hrd.karyawan_pengganti dan:
//   Karyawan Reliver -> jadwal_assignments (jadwal kerja)
//   Karyawan Reguler -> lembur_assignments (lembur, isian sama seperti Pengajuan Lembur)
// Pilihan Reliver / Reguler hanya menentukan tujuan simpan; tidak disimpan sebagai kolom.
// Baca/tulis HANYA lewat fungsi database hrd.pengganti_* (lihat pengganti.sql).
// Semua aturan (siapa boleh, filter karyawan, edit terkunci, penonaktifan data lama)
// ada di database; file ini hanya menampilkan dan mengirim isian.
// WAJIB: jalankan pengganti.sql (versi 2) di Supabase terlebih dulu.
// ===================================================

// ===================================================
// KELOMPOK 1: PENGATURAN (KONFIGURASI)
// ===================================================
let supabaseClient = window.supabaseClient;

const SESSION_KEY = "pwa_mobile_session";   // key sesi login PWA (JSON)
const PAGE_SIZE = 30;                       // jumlah kartu per pemuatan
const BUCKET = "hrd";                       // bucket lampiran lembur
const MAX_FILE_BYTES = 10 * 1024 * 1024;    // batas ukuran foto asli: 10 MB
const IMG_MAX_SIDE = 1600;                  // sisi terpanjang foto setelah dikecilkan (piksel)
const IMG_QUALITY = 0.75;                   // kualitas JPEG (0-1)
const KET_MAX = 200;                        // batas karakter Keterangan
const OT_MAX_MENIT = 12 * 60;               // durasi lembur maksimum per sisi
const BREAK_MAX_MENIT = 3 * 60;             // durasi istirahat maksimum per sisi
const ROW_H = 44;                           // tinggi baris roda jam (harus sama dengan CSS .kp-wheel-item)
const FILE_HINT = "Foto, maksimal 10 MB. Foto dikecilkan otomatis sebelum diunggah.";

// ===================================================
// KELOMPOK 2: STATE (DATA SEMENTARA DI MEMORI)
// ===================================================
const S = {
    ctx: null,                  // konteks pengguna dari server (role, departemen, hari ini)
    rows: [], offset: 0, hasMore: false, loading: false, listReq: 0,
    mode: null,                 // "add" | "view" | "edit"
    cur: null,                  // data kartu yang dibuka (dari pengganti_ambil)
    cara: "reliver",            // "reliver" | "reguler" (hanya tampilan; tidak disimpan)
    saving: false,
    shiftReq: 0,                // penanda pengisian otomatis shift terbaru
    cache: {},                  // daftar yang dimuat sekali: shift, mitra, karyawan
    combos: {}                  // id dropdown cari -> { items, loading, need }
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
function toMenit(hhmm) { const [h, m] = String(hhmm || "00:00").split(":").map(Number); return h * 60 + m; }

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

// Kolom ketuk (tanggal, durasi, dropdown cari): nilai sebenarnya di data-value, teks tampil di value
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
    $("fMitra").addEventListener("change", onMitraChange);
    $("segCara").addEventListener("click", (e) => {
        const b = e.target.closest("[data-cara]");
        if (b && b.dataset.cara !== S.cara) { setCara(b.dataset.cara); resetBertugas(); }
    });

    // Satu pendengar untuk semua isian di dalam form
    const body = $("kpBody");
    body.addEventListener("click", (e) => {
        const item = e.target.closest(".kp-combo-item");
        if (item) { pickComboItem(item); return; }
        if (!e.target.closest(".kp-combo")) closeCombos();
        const add = e.target.closest("[data-attach-add]");
        if (add) { $(add.dataset.attachAdd).click(); return; }
        const del = e.target.closest("[data-attach-del]");
        if (del) { $(del.dataset.attachDel).value = ""; renderAttach(del.dataset.attachDel); return; }
        const tap = e.target.closest(".kp-tap");
        if (!tap) return;
        if (tap.id === "tapTgl") pickTanggal();
        else if (tap.dataset.combo) toggleCombo(tap.dataset.combo);
        else if (tap.dataset.dur) pickDuration(tap.dataset.dur, tap.dataset.title);
    });
    body.addEventListener("input", (e) => {
        if (e.target.classList.contains("kp-combo-search")) renderComboList(e.target.dataset.combo);
        if (e.target.id === "fKet") $("fKetCnt").textContent = `${e.target.value.length}/${KET_MAX}`;
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

    // Pemilih durasi (roda jam)
    $("kpTimeOk").addEventListener("click", () => finishTime(`${pad(wheelIndex($("kpWheelH")))}:${pad(wheelIndex($("kpWheelM")))}`));
    $("kpTimeX").addEventListener("click", () => finishTime(null));
    $("kpTime").addEventListener("click", (e) => { if (e.target === $("kpTime")) finishTime(null); });
}

// ===================================================
// KELOMPOK 5: DAFTAR KARTU
// Fungsi: kartu dikelompokkan per tanggal tugas, tanggal terbaru di atas (urutan dari
// database). Isi kartu: NIK dan nama karyawan bertugas, Area, kode shift, jam absen
// (hanya bila sudah ada), serta penanda asal data: "Dari Pengganti" (dibuat di halaman
// ini) atau "Dari Lembur" (dari Pengajuan Lembur). Baris tipe dan cara menunjukkan
// Pengganti / Casual dan Reliver / Reguler.
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
    const caraTxt = r.cara === "reliver" ? "Reliver" : (r.cara === "reguler" ? "Reguler (lembur)" : "");
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
            <div class="kp-card-meta"><i class="fa-solid fa-business-time"></i> Shift ${esc(r.kode_shift || "-")} &bull; ${esc(r.tipe || "")}${caraTxt ? " &bull; " + esc(caraTxt) : ""}</div>
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
// Data dari Pengajuan Lembur hanya bisa dilihat; diubah lewat Pengajuan Lembur.
// Isian khusus:
//   Pengganti + Karyawan Absen dipilih  -> Shift Kerja terisi otomatis dari shift karyawan
//       absen pada tanggal itu (jadwal atau pola); tetap bisa diganti lewat dropdown
//   Karyawan Reliver                    -> disimpan ke jadwal
//   Karyawan Reguler                    -> bagian "Lembur" muncul; disimpan ke lembur
// ===================================================
function setEnabled(ids, on) {
    ids.forEach((id) => {
        const el = $(id);
        if (el.classList.contains("kp-tap") || el.classList.contains("kp-seg")) el.classList.toggle("kp-off", !on);
        else el.disabled = !on;
    });
}

function applyMode() {
    const add = S.mode === "add", view = S.mode === "view", edit = S.mode === "edit";
    const locked = !!(S.cur && S.cur.ada_absen);
    const fromLembur = !!(S.cur && S.cur.asal === "lembur");
    $("kpTitle").textContent = add ? "Tambah Pengganti" : view ? "Detail Pengganti" : "Edit Pengganti";

    const allOn = add || (edit && !locked);
    setEnabled(["tapTgl", "fTipe", "tapAbsen", "fMitra", "fArea", "segCara", "tapBertugas",
                "tapObOt", "tapObBrk", "tapOaOt", "tapOaBrk", "fKet", "fFile"], allOn);
    setEnabled(["fShift"], add || edit);
    document.querySelectorAll("#fFileBox .kp-attach-add, #fFileBox .kp-attach-del").forEach((el) => { el.hidden = !allOn; });

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
    $("fShiftHint").textContent = "";
    if (S.cara === "reguler") resetBertugas();          // daftar reguler bergantung pada cost center acuan
    if (tipe === "Pengganti") autofillShift();
}

function onMitraChange() {
    if (S.cara === "reguler") resetBertugas();
}

// Pilihan jenis karyawan bertugas. Hanya mengatur tampilan dan tujuan simpan.
function setCara(cara) {
    S.cara = cara;
    document.querySelectorAll("#segCara [data-cara]").forEach((b) => b.classList.toggle("active", b.dataset.cara === cara));
    $("wrapLembur").hidden = cara !== "reguler";
    updateBertugasHint();
}

function updateBertugasHint() {
    $("fBertugasHint").textContent = S.cara === "reliver"
        ? "Karyawan Reliver di departemen Anda."
        : "Karyawan aktif di departemen Anda dengan cost center yang berbeda dari karyawan absen / Mitra yang dipilih.";
}

// Mengosongkan pilihan Karyawan Bertugas (daftarnya berubah mengikuti pilihan lain)
function resetBertugas() {
    setTap("fBertugas", "", "");
    delete S.combos.fBertugas;
    closeCombos();
}

function resetDurasi() {
    ["fObOt", "fObBrk", "fOaOt", "fOaBrk"].forEach((id) => setTap(id, "00:00", "00:00"));
}

function resetForm() {
    setMsg("");
    closeCombos();
    setTap("fTgl", S.ctx.hari_ini, fmtTglLengkap(S.ctx.hari_ini));
    $("fTipe").value = "Pengganti";
    setTap("fAbsen", "", "");
    $("fAbsen").dataset.cc = "";
    setTap("fBertugas", "", "");
    delete S.combos.fBertugas;
    $("fShift").value = "";
    $("fShiftHint").textContent = "";
    $("fMitra").value = "";
    $("fArea").value = "";
    resetDurasi();
    $("fKet").value = ""; $("fKetCnt").textContent = `0/${KET_MAX}`;
    $("fFile").value = ""; renderAttach("fFile");
    $("fFileHint").hidden = false;
    $("fFileHint").textContent = FILE_HINT;
    setCara("reliver");
    onTipeChange();
}

// Shift kerja dan daftar Mitra / Area (Mitra dan Area difilter cabang pengguna oleh database)
async function ensureLookups() {
    try {
        const [shift, mitra] = await Promise.all([
            cached("shift", "pengganti_daftar_shift"),
            cached("mitra", "pengajuan_daftar_mitra")
        ]);
        const cur = $("fShift").value, curM = $("fMitra").value, curA = $("fArea").value;
        $("fShift").innerHTML = `<option value="">Pilih Shift Kerja</option>` + shift.map(s => {
            const jam = s.jam_masuk ? ` (${s.jam_masuk} - ${s.jam_pulang})` : "";
            return `<option value="${esc(s.kode)}">${esc(s.nama + jam)}</option>`;
        }).join("");
        $("fMitra").innerHTML = `<option value="">Pilih Mitra</option>` + (mitra.costcenter || []).map(c => `<option value="${esc(c.id)}">${esc(c.nama)}</option>`).join("");
        $("fArea").innerHTML = `<option value="">Pilih Area</option>` + (mitra.area || []).map(a => `<option value="${esc(a.id)}">${esc(a.nama)}</option>`).join("");
        if (cur) $("fShift").value = cur;
        if (curM) $("fMitra").value = curM;
        if (curA) $("fArea").value = curA;
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
    $("wrapAbsen").hidden = d.tipe !== "Pengganti";
    $("wrapCasual").hidden = d.tipe !== "Casual";
    $("fShiftHint").textContent = "";
    setTap("fAbsen", d.absen_id || "", d.absen_label || "");
    $("fAbsen").dataset.cc = d.tipe === "Pengganti" && d.costcenter_id ? String(d.costcenter_id) : "";
    setTap("fBertugas", d.bertugas_id || "", d.bertugas_label || "");
    delete S.combos.fBertugas;

    // reliver = jadwal; reguler dan lembur = lembur
    setCara(d.cara === "reliver" ? "reliver" : "reguler");
    if (S.cara === "reguler") {
        setTap("fObOt", d.ot_before || "00:00", d.ot_before || "00:00");
        setTap("fObBrk", d.break_before || "00:00", d.break_before || "00:00");
        setTap("fOaOt", d.ot_after || "00:00", d.ot_after || "00:00");
        setTap("fOaBrk", d.break_after || "00:00", d.break_after || "00:00");
        $("fKet").value = d.keterangan || "";
        $("fKetCnt").textContent = `${$("fKet").value.length}/${KET_MAX}`;
        viewAttachment(d.attachment);
    }

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
    // Lampiran: tampilan baca diganti kotak unggah; lampiran lama tetap dipakai bila tidak diganti
    if (S.cara === "reguler") {
        $("fFile").value = "";
        renderAttach("fFile");
        $("fFileHint").hidden = false;
        $("fFileHint").textContent = S.cur.attachment
            ? "Lampiran sebelumnya tetap dipakai kecuali Anda memilih file baru."
            : FILE_HINT;
    }
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
    releaseAttachUrl();
    closeModal("kpModal");
    S.mode = null; S.cur = null;
    setMsg("");
}

// ===================================================
// KELOMPOK 7: PEMILIH TANGGAL
// Fungsi: kalender di atas modal. Tanggal baru: hari ini atau sesudahnya. Saat edit,
// tanggal asli tetap boleh dipilih walau sudah lewat. Database memeriksa ulang.
// Setelah tanggal dipilih (tipe Pengganti), Shift Kerja diisi ulang dari karyawan absen.
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
    if (v) { setTap("fTgl", v, fmtTglLengkap(v)); autofillShift(); }
}

// ===================================================
// KELOMPOK 8: PEMILIH DURASI (RODA JAM : MENIT)
// Fungsi: dua roda (jam : menit) untuk durasi lembur dan istirahat Karyawan Reguler,
// format hh:mm seperti jam absensi. Hasil lewat Promise (null jika ditutup tanpa Simpan).
// ===================================================
const tp = { resolve: null, built: false };

function buildWheels() {
    if (tp.built) return;
    tp.built = true;
    const fill = (el, n) => { el.innerHTML = Array.from({ length: n }, (_, i) => `<div class="kp-wheel-item" data-i="${i}">${pad(i)}</div>`).join(""); };
    fill($("kpWheelH"), 24);
    fill($("kpWheelM"), 60);
    ["kpWheelH", "kpWheelM"].forEach((id) => {
        const el = $(id);
        let t = null;
        el.addEventListener("scroll", () => { clearTimeout(t); t = setTimeout(() => markWheel(el), 90); }, { passive: true });
        el.addEventListener("click", (e) => {
            const it = e.target.closest(".kp-wheel-item");
            if (it) el.scrollTo({ top: Number(it.dataset.i) * ROW_H, behavior: "smooth" });
        });
    });
}
function wheelIndex(el) {
    const max = el.querySelectorAll(".kp-wheel-item").length - 1;
    return Math.max(0, Math.min(max, Math.round(el.scrollTop / ROW_H)));
}
function markWheel(el) {
    const i = wheelIndex(el);
    el.querySelectorAll(".kp-wheel-item").forEach(x => x.classList.toggle("sel", Number(x.dataset.i) === i));
}
function setWheel(el, i) { el.scrollTop = i * ROW_H; markWheel(el); }

function pickTime(value, title) {
    return new Promise((resolve) => {
        tp.resolve = resolve;
        buildWheels();
        $("kpTimeTitle").textContent = title || "Pilih durasi";
        openModal("kpTime");
        const [h, m] = String(value || "00:00").split(":").map(Number);
        requestAnimationFrame(() => { setWheel($("kpWheelH"), h || 0); setWheel($("kpWheelM"), m || 0); });
    });
}
function finishTime(v) {
    if (!tp.resolve) return;
    const r = tp.resolve; tp.resolve = null;
    closeModal("kpTime");
    r(v);
}

async function pickDuration(id, title) {
    const v = await pickTime(tapValue(id) || "00:00", title);
    if (v) setTap(id, v, v);
}

// ===================================================
// KELOMPOK 9: SHIFT OTOMATIS DARI KARYAWAN ABSEN
// Fungsi: untuk tipe Pengganti, setelah Karyawan Absen dan Tanggal terisi, Shift Kerja
// diisi dari shift karyawan absen pada tanggal itu (jadwal aktif, atau pola jadwal) lewat
// database. Dropdown tetap bisa diganti. Hari libur / tanpa jadwal: shift tidak diubah.
// ===================================================
async function autofillShift() {
    if (S.mode !== "add" && S.mode !== "edit") return;
    if ($("fTipe").value !== "Pengganti") return;
    const emp = tapValue("fAbsen"), tgl = tapValue("fTgl");
    const hint = $("fShiftHint");
    if (!emp || !tgl) { hint.textContent = ""; return; }
    const my = ++S.shiftReq;
    hint.textContent = "Mengambil shift karyawan absen...";
    try {
        await ensureLookups();
        const { data, error } = await hrd().rpc("pengganti_shift_karyawan", { p_emp: emp, p_tgl: tgl });
        if (my !== S.shiftReq) return;
        if (error) throw error;
        if (data && data.kode_shift && [...$("fShift").options].some(o => o.value === data.kode_shift)) {
            $("fShift").value = data.kode_shift;
            const jam = data.jam_masuk ? ` (${data.jam_masuk} - ${data.jam_pulang})` : "";
            hint.textContent = `Terisi dari shift karyawan absen: ${data.nama_shift || data.kode_shift}${jam}. Bisa diganti.`;
        } else {
            hint.textContent = "Karyawan absen tidak punya shift kerja pada tanggal ini. Pilih shift secara manual.";
        }
    } catch (err) {
        if (my !== S.shiftReq) return;
        hint.textContent = "Shift karyawan absen tidak bisa diambil: " + err.message;
    }
}

// ===================================================
// KELOMPOK 10: DROPDOWN DENGAN KOLOM CARI (Karyawan Absen, Karyawan Bertugas)
// Fungsi: diketuk membuka panel berisi kolom cari (NIK atau nama) dan daftar; memilih
// satu baris menutup panel. Daftar dimuat dari database saat pertama dibuka, semua di
// departemen yang sama dengan pengguna:
//   Karyawan Absen                  : PKWT / PKWTT
//   Karyawan Bertugas - Reliver     : karyawan Reliver
//   Karyawan Bertugas - Reguler     : karyawan aktif (bukan Reliver) dengan cost center BERBEDA
//                                     dari karyawan absen (tipe Pengganti) atau Mitra (tipe Casual)
// ===================================================
// Cost center acuan untuk filter Reguler
function refCc() {
    if ($("fTipe").value === "Pengganti") {
        const v = $("fAbsen").dataset.cc;
        return v ? Number(v) : null;
    }
    const m = $("fMitra").value;
    return m ? Number(m) : null;
}

// Menentukan permintaan daftar; null = belum bisa (butuh pilihan lain dulu)
function comboRequest(id) {
    if (id === "fAbsen") return { key: "kar_absen", args: { p_jenis: "absen" } };
    if (S.cara === "reliver") return { key: "kar_reliver", args: { p_jenis: "reliver" } };
    const cc = refCc();
    if (!cc) return null;
    return { key: "kar_reguler_" + cc, args: { p_jenis: "reguler", p_cc: cc } };
}

async function ensureCombo(id) {
    const req = comboRequest(id);
    if (!req) {
        S.combos[id] = { items: [], loading: false, need: $("fTipe").value === "Pengganti" ? "Pilih Karyawan Absen terlebih dahulu." : "Pilih Mitra terlebih dahulu." };
        renderComboList(id);
        return;
    }
    S.combos[id] = { items: [], loading: true };
    renderComboList(id);
    try {
        const list = await cached(req.key, "pengganti_daftar_karyawan", req.args);
        S.combos[id] = { items: list.map(k => ({ value: k.id, text: `${k.nik} - ${k.nama}`, cc: k.cc })), loading: false };
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
        : `<div class="kp-combo-empty">${c.loading ? "Memuat..." : (c.need || "Tidak ada hasil")}</div>`;
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
    $(id + "Search").focus();
    panel.scrollIntoView({ block: "nearest" });
}

function pickComboItem(el) {
    const id = el.dataset.combo;
    const it = S.combos[id] && S.combos[id].items.find(x => x.value === el.dataset.v);
    if (it) {
        setTap(id, it.value, it.text);
        if (id === "fAbsen") {
            $("fAbsen").dataset.cc = it.cc ? String(it.cc) : "";
            if (S.cara === "reguler") resetBertugas();     // cost center acuan berubah
            autofillShift();
        }
    }
    closeCombos();
}

// ===================================================
// KELOMPOK 11: LAMPIRAN (Karyawan Reguler)
// Fungsi: foto maksimal 10 MB, dikecilkan di HP (sisi terpanjang 1600 px, JPEG) sebelum
// diunggah ke bucket "hrd". Jalur: {id_pengguna}/pengajuan/pengganti/{waktu}_{acak}.jpg
// Satu file per data. Di mode detail, lampiran dibuka lewat signed URL.
// ===================================================
let attachUrl = null;
function releaseAttachUrl() { if (attachUrl) { URL.revokeObjectURL(attachUrl); attachUrl = null; } }

function renderAttach(id) {
    const box = $(id + "Box");
    releaseAttachUrl();
    const f = $(id).files[0];
    const hidden = $("kpBtnSimpan").hidden ? " hidden" : "";
    if (!f) {
        box.innerHTML = `<button type="button" class="kp-attach-add" data-attach-add="${id}" aria-label="Tambah file"${hidden}><i class="fa-solid fa-plus"></i></button>`;
        return;
    }
    attachUrl = URL.createObjectURL(f);
    box.innerHTML = `<div class="kp-attach-item"><img src="${attachUrl}" alt="Lampiran"><button type="button" class="kp-attach-del" data-attach-del="${id}" aria-label="Hapus file"><i class="fa-solid fa-xmark"></i></button></div>`;
}

// Mode detail: tampilkan lampiran yang tersimpan (atau keterangan bila kosong)
async function viewAttachment(path) {
    const box = $("fFileBox");
    $("fFileHint").hidden = true;
    if (!path) { box.innerHTML = '<div class="kp-hint">Tidak ada lampiran.</div>'; return; }
    box.innerHTML = '<div class="kp-hint">Memuat lampiran...</div>';
    try {
        const { data, error } = await supabaseClient.storage.from(BUCKET).createSignedUrl(path, 3600);
        if (error || !data || !data.signedUrl) throw (error || new Error("alamat lampiran tidak tersedia"));
        const url = data.signedUrl;
        box.innerHTML = /\.pdf$/i.test(path)
            ? `<a class="kp-file-link" href="${esc(url)}" target="_blank" rel="noopener"><i class="fa-regular fa-file-pdf"></i> Buka lampiran (PDF)</a>`
            : `<a href="${esc(url)}" target="_blank" rel="noopener"><img class="kp-attach-img" src="${esc(url)}" alt="Lampiran"></a>`;
    } catch (err) {
        box.innerHTML = `<div class="kp-hint">Lampiran gagal dimuat: ${esc(err && err.message ? err.message : err)}</div>`;
    }
}

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

async function uploadFile(file) {
    if (file.size > MAX_FILE_BYTES) throw new Error(`File terlalu besar (maksimal ${MAX_FILE_BYTES / 1024 / 1024} MB).`);
    if (!/^image\//i.test(file.type)) throw new Error("File harus berupa foto.");
    const blob = await compressImage(file);
    const path = `${S.ctx.employee_id}/pengajuan/pengganti/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`;
    const { error } = await supabaseClient.storage.from(BUCKET).upload(path, blob, { contentType: "image/jpeg", upsert: false });
    if (error) throw new Error("File gagal diunggah: " + error.message);
    return path;
}

// ===================================================
// KELOMPOK 12: VALIDASI & SIMPAN
// Fungsi: memeriksa isian di layar lalu memanggil hrd.pengganti_simpan (satu transaksi).
// Di belakang layar (diisi database): supervisor_id, departemen / cost center / area,
// is_active, source "delegasi", status "approved", petugas_id, FK karyawan_pengganti_id,
// dan penonaktifan data lama. Pesan error dari database ditampilkan apa adanya.
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

    const payload = { tipe, cara: S.cara, tanggal: tgl, kode_shift: shift, bertugas_id: bertugas };
    if (tipe === "Pengganti") payload.absen_id = tapValue("fAbsen");
    else { payload.costcenter_id = Number($("fMitra").value); payload.area_id = Number($("fArea").value); }

    if (S.cara === "reguler") {
        const ob = tapValue("fObOt") || "00:00", bb = tapValue("fObBrk") || "00:00";
        const oa = tapValue("fOaOt") || "00:00", ba = tapValue("fOaBrk") || "00:00";
        if (toMenit(ob) === 0 && toMenit(oa) === 0) errs.push("Isi durasi lembur sebelum atau setelah shift.");
        if (toMenit(ob) > OT_MAX_MENIT || toMenit(oa) > OT_MAX_MENIT) errs.push(`Durasi lembur maksimal ${OT_MAX_MENIT / 60} jam.`);
        if (toMenit(bb) > BREAK_MAX_MENIT || toMenit(ba) > BREAK_MAX_MENIT) errs.push(`Durasi istirahat maksimal ${BREAK_MAX_MENIT / 60} jam.`);
        if (toMenit(ob) === 0 && toMenit(bb) > 0) errs.push("Istirahat sebelum shift tidak boleh diisi tanpa durasi lembur.");
        if (toMenit(oa) === 0 && toMenit(ba) > 0) errs.push("Istirahat setelah shift tidak boleh diisi tanpa durasi lembur.");
        if (toMenit(bb) >= toMenit(ob) && toMenit(bb) > 0) errs.push("Istirahat sebelum shift harus lebih kecil dari durasi lembur.");
        if (toMenit(ba) >= toMenit(oa) && toMenit(ba) > 0) errs.push("Istirahat setelah shift harus lebih kecil dari durasi lembur.");
        Object.assign(payload, { ot_before: ob, break_before: bb, ot_after: oa, break_after: ba, keterangan: $("fKet").value.trim() });
    }
    if (errs.length) throw new Error(`Belum bisa disimpan. Perbaiki dulu:\n${errs.join("\n")}`);
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
    let path = null;
    try {
        const file = S.cara === "reguler" ? $("fFile").files[0] : null;
        if (file) {
            setBusy(btn, true, "Mengunggah...");
            path = await uploadFile(file);
            payload.attachment = path;                       // kosong = lampiran lama tetap dipakai
        }
        setBusy(btn, true, "Menyimpan...");
        const { error } = await hrd().rpc("pengganti_simpan", { p: payload });
        if (error) throw error;
        S.saving = false;
        closeForm();
        showToast(edited ? "Perubahan tersimpan." : "Data pengganti tersimpan.");
        loadList(true);
    } catch (err) {
        console.error("Gagal menyimpan:", err);
        if (path) supabaseClient.storage.from(BUCKET).remove([path]).catch(() => {});   // bersihkan file yatim
        setMsg(`Tidak ada data yang tersimpan.\n${err.message}`, "danger");
    } finally {
        S.saving = false;
        setBusy(btn, false);
    }
}