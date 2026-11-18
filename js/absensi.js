// ===================================================
// js/absensi.js
// Absensi PWA: kartu absen per tanggal jadwal (bisa digeser), layar absen
// (selfie kamera depan, lokasi/peta opsional) dan pengiriman Clock In / Clock Out.
// Dimuat di index.html SETELAH js/supabase.js dan SEBELUM skrip inline beranda.
// Fungsi yang dipanggil beranda: muatStatusAbsen().
// Data dari database (time_modul1g_kartu_absen.sql): hrd.status_absen_saya
// dan hrd.catat_absen_online. "supabaseClient" dipakai lewat window.supabaseClient
// (tidak dideklarasikan ulang di sini).
// ===================================================

// ===================================================
// KELOMPOK 1: PENGATURAN
// Fungsi: nilai tetap yang mudah diubah.
//  ABSEN_FOTO_*   : ukuran dan kompresi foto selfie
//  ABSEN_PETA_AWAL: pusat peta bila belum ada titik/posisi
//  ABSEN_DEVICE_KEY: nama penyimpanan kode device di perangkat
//  ABSEN_REFRESH_MS: seberapa sering status kartu dimuat ulang otomatis
// ===================================================
const ABSEN_BUCKET = "absensi";
const ABSEN_FOTO_LEBAR = 360;
const ABSEN_FOTO_KUALITAS = 0.6;
const ABSEN_FOTO_MAKS_BYTE = 60000;
const ABSEN_PETA_AWAL = [-2.5, 118];
const ABSEN_LEAFLET_CSS = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
const ABSEN_LEAFLET_JS = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
const ABSEN_DEVICE_KEY = "dmb_device_id";
const ABSEN_REFRESH_MS = 5 * 60 * 1000;

// ===================================================
// KELOMPOK 2: STATE
// ===================================================
const absen = {
  status: null,        // hasil hrd.status_absen_saya()
  offsetMs: 0,         // selisih jam server terhadap jam perangkat
  tglDipilih: null,    // tanggal jadwal pada kartu yang sedang terlihat
  tipe: null,          // 'clock_in' / 'clock_out' pada layar absen yang dibuka
  kartuModal: null,    // data kartu yang sedang diabsen
  modalTerbuka: false,
  stream: null,        // aliran kamera
  kameraSiap: false,
  map: null, layer: null, lingkaran: [], saya: null,
  petaTerbuka: false, sudahFit: false,
  posisi: null,        // { lat, lng, akurasi }
  watchId: null,
  mengirim: false,
  janjiStatus: null    // janji pemuatan status terakhir (dipakai menu beranda)
};

// ===================================================
// KELOMPOK 3: FUNGSI BANTU
// ===================================================
function absenEl(id) { return document.getElementById(id); }

function absenEsc(t) {
  return String(t == null ? "" : t).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function absenDb() {
  if (!window.supabaseClient) throw new Error("Koneksi database belum siap.");
  return window.supabaseClient.schema("hrd");
}

// Jam sekarang menurut server (jam perangkat bisa salah)
function absenSekarang() { return Date.now() + absen.offsetMs; }
function absenZona() { return (absen.status && absen.status.zona_waktu) || "Asia/Jakarta"; }

// Tanggal hari ini (YYYY-MM-DD) menurut zona waktu karyawan
function absenTglHariIni() {
  return new Date(absenSekarang()).toLocaleDateString("en-CA", { timeZone: absenZona() });
}

function absenParseTgl(s) {
  const [y, m, d] = String(s).split("-").map(Number);
  return new Date(y, m - 1, d);
}

// Selisih hari antara tanggal jadwal dan hari ini (0 = hari ini, 1 = besok)
function absenBedaHari(tgl) {
  const u = (s) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((u(tgl) - u(absenTglHariIni())) / 86400000);
}

function absenTglPanjang(tgl) {
  return absenParseTgl(tgl).toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "short", year: "numeric" });
}

function absenTglRingkas(tgl) {
  return absenParseTgl(tgl).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
}

function absenJam(iso) {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: absenZona() });
}

function absenFormatWaktu(iso) {
  const tgl = new Date(iso).toLocaleDateString("en-CA", { timeZone: absenZona() });
  const jam = absenJam(iso);
  return tgl === absenTglHariIni()
    ? `pukul ${jam}`
    : `${absenParseTgl(tgl).toLocaleDateString("id-ID", { day: "2-digit", month: "short" })} pukul ${jam}`;
}

function absenAngka(n) { return String(Number(n)).replace(".", ","); }

function absenFormatDurasi(menit) {
  if (menit < 60) return `${menit} menit`;
  const j = Math.floor(menit / 60), m = menit % 60;
  return m ? `${j} jam ${m} menit` : `${j} jam`;
}

// ===================================================
// KELOMPOK 4: STATUS DAN KARTU ABSEN DI BERANDA
// Fungsi: memuat daftar kartu dari database. Tiap kartu = satu tanggal jadwal.
// Kartu digeser ke samping untuk memilih tanggal yang akan diabsen. Tanpa jadwal
// (Reliver tanpa jadwal assignment, atau tanpa jadwal sama sekali) = tanpa kartu.
// Kartu yang sudah Clock Out hilang dari daftar. Setelah jadwal berakhir kartu
// tetap tampil sampai batas waktunya; hanya tombol Clock In yang terkunci, dan
// Clock Out tetap boleh walau belum/lupa Clock In.
// ===================================================
function muatStatusAbsen() {
  absen.janjiStatus = absenMuatStatus();
  return absen.janjiStatus;
}

// Dipakai menu beranda: menunggu status selesai dimuat, lalu cek apakah karyawan Reliver
function absenTungguStatus() { return absen.janjiStatus || Promise.resolve(); }
function absenModeReliver() { return !!(absen.status && absen.status.mode_jadwal === "reliver"); }

async function absenMuatStatus() {
  if (absen.mengirim) return;
  try {
    const { data, error } = await absenDb().rpc("status_absen_saya");
    if (error) throw error;
    absen.status = data;
    absen.offsetMs = new Date(data.waktu_server).getTime() - Date.now();
    absenRenderKartu();
  } catch (err) {
    console.error("Gagal memuat status absen:", err);
    absen.status = null;
    absenRenderGagal();
  }
}

function absenRenderGagal() {
  absenEl("absenKartuWadah").hidden = false;
  absenEl("absenDots").innerHTML = "";
  const track = absenEl("absenTrack");
  track.classList.remove("absen-banyak");
  track.innerHTML = `<div class="shift-widget absen-kartu"><div class="absen-info absen-info-gagal" data-retry="1">Status absen gagal dimuat. Ketuk di sini untuk mencoba lagi.</div></div>`;
}

function absenHtmlKartu(k) {
  const s = absen.status;
  const label = ({ "-1": "Kemarin", "0": "Hari Ini", "1": "Besok" })[String(absenBedaHari(k.tanggal_kerja))] || "";
  const judul = label ? `Jadwal Shift · ${label}` : "Jadwal Shift";
  const pulang = k.jam_pulang + (k.lintas_hari ? " (+1)" : "");
  const adaSetting = !!s.ada_setting;

  const ob = Number(k.ot_sebelum_jam) || 0, oa = Number(k.ot_sesudah_jam) || 0;
  let lembur = "";
  if (ob > 0 || oa > 0) {
    const bagian = [];
    if (ob > 0) bagian.push(`+${absenAngka(ob)} jam sebelum shift (mulai ${absenJam(k.mulai_efektif)})`);
    if (oa > 0) bagian.push(`+${absenAngka(oa)} jam setelah shift (sampai ${absenJam(k.selesai_efektif)})`);
    lembur = `<div class="absen-lembur"><i class="fa-solid fa-business-time"></i> Lembur ${absenEsc(bagian.join(", "))}</div>`;
  }

  let info = "";
  if (!adaSetting) info = "Anda belum memiliki setting lokasi absen. Hubungi admin.";
  else if (k.sudah_masuk) info = `Clock In tercatat ${absenFormatWaktu(k.waktu_masuk)}.`;
  else if (!k.boleh_clock_in) info = "Waktu Clock In sudah ditutup (jadwal berakhir). Anda masih bisa Clock Out.";

  return `<div class="shift-widget absen-kartu" data-tgl="${absenEsc(k.tanggal_kerja)}">
    <div class="shift-info">
      <div>
        <div class="shift-title">${absenEsc(judul)}</div>
        <div class="shift-time">${absenEsc(absenTglPanjang(k.tanggal_kerja))}</div>
        <div class="absen-detail">${absenEsc(k.nama_shift)} · ${absenEsc(k.jam_masuk)} - ${absenEsc(pulang)}</div>
        ${lembur}
      </div>
      <span class="shift-badge" data-badge></span>
    </div>
    <div class="clock-actions">
      <button type="button" class="btn-clock btn-clock-in" data-aksi="clock_in" ${(!adaSetting || !k.boleh_clock_in) ? "disabled" : ""}><i class="fa-solid fa-right-to-bracket"></i> Clock In</button>
      <button type="button" class="btn-clock btn-clock-out" data-aksi="clock_out" ${(!adaSetting || !k.boleh_clock_out) ? "disabled" : ""}><i class="fa-solid fa-right-from-bracket"></i> Clock Out</button>
    </div>
    <div class="absen-info">${absenEsc(info)}</div>
  </div>`;
}

function absenRenderKartu() {
  const wadah = absenEl("absenKartuWadah");
  const track = absenEl("absenTrack");
  const kartu = (absen.status && absen.status.kartu) || [];

  if (kartu.length === 0) {
    // Tanpa jadwal yang bisa diabsen: kartu tidak ditampilkan
    wadah.hidden = true;
    track.innerHTML = "";
    absenEl("absenDots").innerHTML = "";
    absen.tglDipilih = null;
    return;
  }
  wadah.hidden = false;

  // Pertahankan kartu yang sedang dilihat; bila tidak ada, pilih yang perlu Clock Out
  let idx = kartu.findIndex(k => k.tanggal_kerja === absen.tglDipilih);
  if (idx < 0) idx = kartu.findIndex(k => k.sudah_masuk);
  if (idx < 0) idx = 0;
  absen.tglDipilih = kartu[idx].tanggal_kerja;

  track.classList.toggle("absen-banyak", kartu.length > 1);
  track.innerHTML = kartu.map(absenHtmlKartu).join("");
  absenPerbaruiBadge();

  requestAnimationFrame(() => {
    const kids = Array.from(track.children);
    if (kids[idx]) track.scrollLeft = kids[idx].offsetLeft - kids[0].offsetLeft;
    absenPerbaruiDots();
  });
}

// Keterangan di sudut kartu, dihitung dari jam mulai jadwal (termasuk lembur sebelum shift):
//  - belum Clock In : "Tepat Waktu" selama belum melewati jam mulai + toleransi,
//                     setelah itu "Terlambat N menit" (hidup, mengikuti jam)
//  - sudah Clock In : berdasarkan jam Clock In yang tercatat
function absenHitungBadge(k) {
  if (!k.sudah_masuk && k.boleh_clock_in === false) {
    return { kelas: "telat", ikon: "fa-lock", teks: "Clock In Ditutup" };
  }
  const mulai = new Date(k.mulai_efektif).getTime();
  const batas = mulai + (Number(k.toleransi_menit) || 0) * 60000;
  const acuan = k.sudah_masuk ? new Date(k.waktu_masuk).getTime() : absenSekarang();
  if (acuan <= batas) {
    return { kelas: "ok", ikon: "fa-circle-check", teks: k.sudah_masuk ? "Masuk Tepat Waktu" : "Tepat Waktu" };
  }
  const menit = Math.max(1, Math.round((acuan - mulai) / 60000));
  return { kelas: "telat", ikon: "fa-triangle-exclamation", teks: `Terlambat ${absenFormatDurasi(menit)}` };
}

function absenPerbaruiBadge() {
  const kartu = (absen.status && absen.status.kartu) || [];
  absenEl("absenTrack").querySelectorAll(".absen-kartu[data-tgl]").forEach(el => {
    const k = kartu.find(x => x.tanggal_kerja === el.dataset.tgl);
    const badge = el.querySelector("[data-badge]");
    if (!k || !badge) return;
    // Jadwal baru saja berakhir selagi kartu terbuka: kunci Clock In sekarang juga
    // (database tetap menolak bila ada yang lolos)
    if (!k.sudah_masuk && k.boleh_clock_in && absenSekarang() > new Date(k.selesai_efektif).getTime()) {
      k.boleh_clock_in = false;
      const btnIn = el.querySelector('[data-aksi="clock_in"]');
      const info = el.querySelector(".absen-info");
      if (btnIn) btnIn.disabled = true;
      if (info) info.textContent = "Waktu Clock In sudah ditutup (jadwal berakhir). Anda masih bisa Clock Out.";
    }
    const b = absenHitungBadge(k);
    badge.className = "shift-badge " + b.kelas;
    badge.innerHTML = `<i class="fa-solid ${b.ikon} me-1"></i>${absenEsc(b.teks)}`;
  });
}

// Kartu yang paling dekat dengan posisi gulir saat ini
function absenIdxTerlihat() {
  const track = absenEl("absenTrack");
  const kids = Array.from(track.children);
  if (kids.length === 0) return 0;
  let best = 0, jarak = Infinity;
  kids.forEach((c, i) => {
    const d = Math.abs((c.offsetLeft - kids[0].offsetLeft) - track.scrollLeft);
    if (d < jarak) { jarak = d; best = i; }
  });
  return best;
}

function absenPerbaruiDots() {
  const kartu = (absen.status && absen.status.kartu) || [];
  const dots = absenEl("absenDots");
  if (kartu.length < 2) { dots.innerHTML = ""; return; }
  const idx = absenIdxTerlihat();
  absen.tglDipilih = kartu[idx] ? kartu[idx].tanggal_kerja : absen.tglDipilih;
  dots.innerHTML = kartu.map((_, i) => `<span class="absen-dot${i === idx ? " aktif" : ""}"></span>`).join("");
}

// ===================================================
// KELOMPOK 5: LAYAR ABSEN (BUKA / TUTUP)
// Fungsi: tombol di kartu membuka layar penuh untuk tanggal jadwal kartu itu.
// ===================================================
function bukaModalAbsen(tipe, tanggal) {
  const s = absen.status;
  if (!s || !s.ada_setting || absen.mengirim) return;
  const k = (s.kartu || []).find(x => x.tanggal_kerja === tanggal);
  if (!k) return;
  if (tipe === "clock_in" && !k.boleh_clock_in) return;
  if (tipe === "clock_out" && !k.boleh_clock_out) return;

  absen.tipe = tipe;
  absen.kartuModal = k;
  absen.posisi = null;
  absen.kameraSiap = false;
  absen.modalTerbuka = true;

  absenEl("absenJudul").textContent = tipe === "clock_in" ? "Clock In" : "Clock Out";
  absenEl("absenShiftNama").textContent = k.nama_shift;
  absenEl("absenShiftDetail").textContent = `${absenTglRingkas(k.tanggal_kerja)} (${k.jam_masuk} - ${k.jam_pulang})`;
  absenTampilError("");
  // Clock Out tanpa Clock In diizinkan, tetapi karyawan diingatkan karena tanggal ini langsung selesai
  absenEl("absenPeringatan").hidden = !(tipe === "clock_out" && !k.sudah_masuk);
  absenPerbaruiStatus();
  absenPerbaruiTombol();

  absenEl("absenModal").classList.add("show");
  absenEl("absenModal").setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";

  mulaiKameraAbsen();
  mulaiPosisiAbsen();
}

function tutupModalAbsen() {
  if (absen.mengirim) return;
  tutupPetaAbsen();
  absenHentikanKamera();
  if (absen.watchId !== null) {
    navigator.geolocation.clearWatch(absen.watchId);
    absen.watchId = null;
  }
  if (absen.saya) { absen.saya.remove(); absen.saya = null; }
  absen.modalTerbuka = false;
  absenEl("absenModal").classList.remove("show");
  absenEl("absenModal").setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

function absenTampilError(teks, tampilCoba) {
  absenEl("absenError").hidden = !teks;
  absenEl("absenErrorTeks").textContent = teks || "";
  absenEl("btnAbsenCoba").hidden = !(teks && tampilCoba);
}

// Tombol Kirim aktif hanya bila kamera siap DAN posisi GPS sudah terbaca
function absenPerbaruiTombol() {
  absenEl("btnAbsenKirim").disabled = !(absen.kameraSiap && absen.posisi && !absen.mengirim);
}

// ===================================================
// KELOMPOK 6: KAMERA DEPAN (SELFIE)
// Wajib kamera depan: facingMode 'exact: user' (bila perangkat tidak punya kamera
// depan, kamera tidak dibuka). Resolusi diminta rendah (480x640).
// ===================================================
async function mulaiKameraAbsen() {
  absenHentikanKamera();
  absen.kameraSiap = false;
  absenPerbaruiTombol();
  absenKameraPesan("Membuka kamera depan...", false);

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    absenKameraPesan("Browser ini tidak mendukung kamera, sehingga absen tidak bisa dikirim.", false);
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { exact: "user" },
        width: { ideal: 480 },
        height: { ideal: 640 },
        frameRate: { ideal: 15, max: 24 }
      },
      audio: false
    });
    const track = stream.getVideoTracks()[0];
    const set = track && track.getSettings ? track.getSettings() : {};
    if (set.facingMode && set.facingMode !== "user") {
      stream.getTracks().forEach(t => t.stop());
      const e = new Error("bukan kamera depan"); e.name = "BukanKameraDepan"; throw e;
    }
    // Layar mungkin sudah ditutup selagi menunggu izin kamera
    if (!absen.modalTerbuka) {
      stream.getTracks().forEach(t => t.stop());
      return;
    }
    absen.stream = stream;
    track.addEventListener("ended", () => {
      absen.kameraSiap = false;
      absenPerbaruiTombol();
      absenKameraPesan("Kamera terhenti. Ketuk Coba lagi.", true);
    });
    const v = absenEl("absenVideo");
    v.srcObject = stream;
    await new Promise(res => { if (v.readyState >= 2) res(); else v.onloadeddata = res; });
    await v.play();
    absen.kameraSiap = true;
    absenEl("absenKameraPesan").hidden = true;
    absenPerbaruiTombol();
  } catch (err) {
    console.error("Kamera gagal dibuka:", err);
    const pesan = {
      NotAllowedError: "Izin kamera ditolak. Aktifkan izin kamera untuk aplikasi/browser ini di pengaturan perangkat, lalu ketuk Coba lagi.",
      SecurityError: "Izin kamera ditolak. Aktifkan izin kamera untuk aplikasi/browser ini di pengaturan perangkat, lalu ketuk Coba lagi.",
      NotFoundError: "Kamera depan tidak ditemukan. Absen wajib memakai kamera depan.",
      OverconstrainedError: "Kamera depan tidak ditemukan. Absen wajib memakai kamera depan.",
      BukanKameraDepan: "Yang terbuka bukan kamera depan. Absen wajib memakai kamera depan.",
      NotReadableError: "Kamera sedang dipakai aplikasi lain. Tutup aplikasi tersebut lalu ketuk Coba lagi."
    }[err.name] || "Kamera tidak dapat dibuka.";
    absenKameraPesan(pesan, true);
  }
}

function absenKameraPesan(teks, tampilCoba) {
  absenEl("absenKameraPesan").hidden = false;
  absenEl("absenKameraTeks").textContent = teks;
  absenEl("btnAbsenKameraCoba").hidden = !tampilCoba;
}

function absenHentikanKamera() {
  if (absen.stream) {
    absen.stream.getTracks().forEach(t => t.stop());
    absen.stream = null;
  }
  absenEl("absenVideo").srcObject = null;
  absen.kameraSiap = false;
}

function absenToBlob(canvas, kualitas) {
  return new Promise(res => canvas.toBlob(res, "image/jpeg", kualitas));
}

// Mengambil gambar persis seperti yang terlihat di bidang kamera (potong tengah),
// diperkecil ke ABSEN_FOTO_LEBAR piksel, lalu dikompres JPEG. Foto tidak dibalik.
async function absenAmbilFoto() {
  const v = absenEl("absenVideo");
  const kotak = absenEl("absenKamera");
  const vw = v.videoWidth, vh = v.videoHeight;
  const cw = kotak.clientWidth, ch = kotak.clientHeight;
  if (!vw || !vh || !cw || !ch) throw new Error("Kamera belum siap.");

  const skala = Math.max(cw / vw, ch / vh);        // sama dengan object-fit: cover
  const sw = cw / skala, sh = ch / skala;
  const sx = (vw - sw) / 2, sy = (vh - sh) / 2;
  const W = ABSEN_FOTO_LEBAR;
  const H = Math.round(W * ch / cw);

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  canvas.getContext("2d").drawImage(v, sx, sy, sw, sh, 0, 0, W, H);

  let kualitas = ABSEN_FOTO_KUALITAS;
  let blob = await absenToBlob(canvas, kualitas);
  while (blob && blob.size > ABSEN_FOTO_MAKS_BYTE && kualitas > 0.35) {
    kualitas -= 0.1;
    blob = await absenToBlob(canvas, kualitas);
  }
  if (!blob) throw new Error("Foto gagal diproses.");
  return blob;
}

// ===================================================
// KELOMPOK 7: POSISI GPS
// ===================================================
function mulaiPosisiAbsen() {
  if (absen.watchId !== null) {
    navigator.geolocation.clearWatch(absen.watchId);
    absen.watchId = null;
  }
  if (!navigator.geolocation) {
    absenTampilError("Perangkat ini tidak mendukung GPS, sehingga absen tidak bisa dikirim.", false);
    return;
  }
  absenTampilError("");
  absenPerbaruiStatus();
  absen.watchId = navigator.geolocation.watchPosition(onPosisiAbsen, onPosisiAbsenError, {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 30000
  });
}

function onPosisiAbsen(pos) {
  absen.posisi = { lat: pos.coords.latitude, lng: pos.coords.longitude, akurasi: pos.coords.accuracy };
  absenTampilError("");
  absenPerbaruiMarkerSaya();
  absenPerbaruiStatus();
  absenPerbaruiTombol();
}

function onPosisiAbsenError(err) {
  // Waktu tunggu habis setelah posisi sudah pernah didapat: abaikan, pakai posisi terakhir
  if (err.code === 3 && absen.posisi) return;
  const pesan = {
    1: "Izin lokasi ditolak. Aktifkan izin lokasi untuk aplikasi/browser ini di pengaturan perangkat, lalu ketuk Coba lagi.",
    2: "Lokasi tidak tersedia. Pastikan GPS aktif dan sinyal baik, lalu ketuk Coba lagi.",
    3: "Pencarian lokasi terlalu lama. Pindah ke tempat terbuka lalu ketuk Coba lagi."
  }[err.code] || "Lokasi tidak dapat dibaca.";
  absenTampilError(pesan, true);
}

function absenJarakMeter(lat1, lon1, lat2, lon2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Keterangan jarak hanya membantu karyawan. Penilaian sah/tidaknya lokasi
// tetap dihitung di database saat absen dikirim.
function absenPerbaruiStatus() {
  const p = absen.posisi, s = absen.status;
  const el1 = absenEl("absenStatus"), el2 = absenEl("absenStatusPeta");
  let teks = "Mencari lokasi Anda...", kelas = "";
  if (p && s) {
    const akurasi = `akurasi ±${Math.round(p.akurasi)} m`;
    const titik = s.mode === "lokasi" ? (s.titik || []) : [];
    if (titik.length === 0) {
      teks = `Lokasi Anda terdeteksi (${akurasi})`;
    } else {
      let dekat = null;
      titik.forEach(t => {
        const j = absenJarakMeter(p.lat, p.lng, Number(t.latitude), Number(t.longitude));
        const sisa = j - Number(t.radius_meter);
        if (!dekat || sisa < dekat.sisa) dekat = { nama: t.nama, jarak: j, radius: Number(t.radius_meter), sisa };
      });
      const didalam = dekat.sisa <= 0;
      kelas = didalam ? "ok" : "bad";
      teks = didalam
        ? `Di dalam range ${dekat.nama} (${Math.round(dekat.jarak)} m dari titik, ${akurasi})`
        : `Di luar range ${dekat.nama} (${Math.round(dekat.jarak)} m dari titik, radius ${dekat.radius} m, ${akurasi})`;
    }
  }
  el1.textContent = teks; el1.className = kelas;
  el2.textContent = teks; el2.className = "absen-status " + kelas;
}

// ===================================================
// KELOMPOK 8: PETA (OPSIONAL, DIMUAT SAAT DIBUKA)
// Leaflet (CSS + JS) baru diunduh saat "Lihat lokasi" pertama kali ditekan.
// Pin hijau + lingkaran = lokasi absen dan range-nya (bisa lebih dari satu);
// titik biru = posisi karyawan. Mode GPS Flexible: hanya posisi karyawan.
// ===================================================
let absenLeafletJanji = null;
function absenMuatLeaflet() {
  if (typeof L !== "undefined") return Promise.resolve();
  if (absenLeafletJanji) return absenLeafletJanji;
  absenLeafletJanji = new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = ABSEN_LEAFLET_CSS;
    const js = document.createElement("script");
    js.src = ABSEN_LEAFLET_JS;
    js.onload = resolve;
    js.onerror = () => {
      css.remove(); js.remove();
      absenLeafletJanji = null;
      reject(new Error("Peta gagal dimuat. Periksa koneksi internet lalu ketuk Coba lagi."));
    };
    document.head.appendChild(css);
    document.head.appendChild(js);
  });
  return absenLeafletJanji;
}

async function bukaPetaAbsen() {
  const s = absen.status;
  if (!s) return;
  const lokasi = s.mode === "lokasi" && (s.titik || []).length > 0;
  absenEl("absenNote").hidden = !lokasi;
  absenEl("absenLegend").hidden = !lokasi;
  absenEl("absenPetaLayar").hidden = false;
  absen.petaTerbuka = true;
  absenPerbaruiStatus();

  if (!absen.map) {
    absenPetaPesan("Memuat peta...", false);
    try {
      await absenMuatLeaflet();
    } catch (err) {
      absenPetaPesan(err.message, true);
      return;
    }
    if (!absen.petaTerbuka) return;   // pengguna sudah kembali sebelum peta selesai dimuat
    absen.map = L.map("absenMap").setView(ABSEN_PETA_AWAL, 5);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap"
    }).addTo(absen.map);
    absen.layer = L.layerGroup().addTo(absen.map);
  }
  absenEl("absenPetaPesan").hidden = true;
  absenGambarLokasi(lokasi);
  absenPerbaruiMarkerSaya();
  absen.sudahFit = false;
  setTimeout(() => { absen.map.invalidateSize(); absenFitPeta(); }, 60);
}

function tutupPetaAbsen() {
  absen.petaTerbuka = false;
  absenEl("absenPetaLayar").hidden = true;
}

function absenPetaPesan(teks, tampilCoba) {
  absenEl("absenPetaPesan").hidden = false;
  absenEl("absenPetaTeks").textContent = teks;
  absenEl("btnPetaCoba").hidden = !tampilCoba;
}

function absenGambarLokasi(lokasi) {
  absen.layer.clearLayers();
  absen.lingkaran = [];
  if (!lokasi) return;
  const ikon = L.divIcon({
    className: "",
    html: '<div class="pin-lokasi"><i class="fa-solid fa-location-dot"></i></div>',
    iconSize: [30, 30],
    iconAnchor: [15, 30]
  });
  absen.status.titik.forEach(t => {
    const ll = [Number(t.latitude), Number(t.longitude)];
    absen.lingkaran.push(L.circle(ll, {
      radius: Number(t.radius_meter), color: "#16a34a", weight: 2, fillOpacity: 0.15, interactive: false
    }).addTo(absen.layer));
    L.marker(ll, { icon: ikon, title: t.nama }).bindTooltip(t.nama).addTo(absen.layer);
  });
}

// Titik biru = posisi karyawan; hanya digambar bila peta sedang terbuka
function absenPerbaruiMarkerSaya() {
  if (!absen.map || !absen.petaTerbuka || !absen.posisi) return;
  const ll = [absen.posisi.lat, absen.posisi.lng];
  if (!absen.saya) {
    const ikon = L.divIcon({ className: "", html: '<div class="pin-saya"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
    absen.saya = L.marker(ll, { icon: ikon, zIndexOffset: 1000, title: "Posisi Anda" }).addTo(absen.map);
  } else {
    absen.saya.setLatLng(ll);
  }
  // Zoom menyesuaikan hanya sekali agar peta tidak melompat-lompat
  if (!absen.sudahFit) { absen.sudahFit = true; absenFitPeta(); }
}

function absenFitPeta() {
  if (!absen.map) return;
  let batas = null;
  const tambah = (x) => {
    if (batas) { batas.extend(x); return; }
    batas = x instanceof L.LatLngBounds ? L.latLngBounds(x.getSouthWest(), x.getNorthEast()) : L.latLngBounds([x, x]);
  };
  absen.lingkaran.forEach(c => tambah(c.getBounds()));
  if (absen.posisi) tambah(L.latLng(absen.posisi.lat, absen.posisi.lng));
  if (batas) absen.map.fitBounds(batas.pad(0.25), { maxZoom: 17 });
}

// ===================================================
// KELOMPOK 9: KODE DEVICE (DICATAT DI BACKGROUND SAAT ABSEN)
// Kode acak dibuat sekali lalu disimpan di perangkat. BUKAN nomor seri: berganti
// bila data situs dihapus atau PWA dipasang ulang. Hanya penanda untuk ditinjau.
// ===================================================
function absenDeviceId() {
  try {
    let id = localStorage.getItem(ABSEN_DEVICE_KEY);
    if (!id) {
      id = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : "d-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
      localStorage.setItem(ABSEN_DEVICE_KEY, id);
    }
    return id;
  } catch (e) {
    return null;
  }
}

function absenDeviceInfo() {
  let tz = "";
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) {}
  return {
    ua: (navigator.userAgent || "").slice(0, 300),
    platform: (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "",
    layar: `${screen.width}x${screen.height}`,
    dpr: window.devicePixelRatio || 1,
    bahasa: navigator.language || "",
    tz: tz,
    terpasang: !!(window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)
  };
}

// ===================================================
// KELOMPOK 10: KIRIM ABSEN
// Urutan: foto diambil dan dikompres -> diunggah ke bucket "absensi" ->
// hrd.catat_absen_online mencatat absen untuk tanggal jadwal kartu yang dipilih.
// Database menolak bila tanggal sudah selesai (sudah Clock Out), sudah Clock In,
// atau di luar batas waktu; pesan penolakan ditampilkan apa adanya.
// ===================================================
async function kirimAbsen() {
  if (absen.mengirim || !absen.kameraSiap || !absen.posisi || !absen.kartuModal) return;
  const tipe = absen.tipe;
  const kartu = absen.kartuModal;
  const btn = absenEl("btnAbsenKirim");
  absen.mengirim = true;
  btn.disabled = true;
  btn.textContent = "Mengirim...";
  absenTampilError("");

  const posisi = { lat: absen.posisi.lat, lng: absen.posisi.lng };
  try {
    const empId = absen.status && absen.status.employee_id;
    if (!empId) throw new Error("Data karyawan belum lengkap. Muat ulang halaman lalu coba lagi.");

    // 1) Ambil foto (kamera dibekukan sesaat agar jelas foto mana yang terkirim)
    const blob = await absenAmbilFoto();
    absenEl("absenVideo").pause();

    // 2) Unggah ke bucket "absensi" (folder = id karyawan, sesuai kebijakan database)
    const path = `${empId}/${kartu.tanggal_kerja}/${Date.now()}_${tipe}.jpg`;
    const up = await window.supabaseClient.storage.from(ABSEN_BUCKET)
      .upload(path, blob, { contentType: "image/jpeg", cacheControl: "3600", upsert: false });
    if (up.error) throw new Error("Foto gagal diunggah: " + up.error.message);

    // 3) Catat absen untuk tanggal jadwal yang dipilih
    const { error } = await absenDb().rpc("catat_absen_online", {
      p_type: tipe,
      p_tanggal_kerja: kartu.tanggal_kerja,
      p_lat: posisi.lat,
      p_lon: posisi.lng,
      p_foto_path: path,
      p_device_id: absenDeviceId(),
      p_device_info: absenDeviceInfo()
    });
    if (error) throw error;

    absen.mengirim = false;
    tutupModalAbsen();
    absenToast(`${tipe === "clock_in" ? "Clock In" : "Clock Out"} berhasil pukul ${absenJam(new Date().toISOString())}`);
    await muatStatusAbsen();
  } catch (err) {
    console.error("Gagal mengirim absen:", err);
    absenTampilError(err.message || "Absen gagal dikirim. Coba lagi.");
    // Penolakan karena status tanggal berubah: tampilan kartu sudah usang, segarkan
    if (/sudah|tidak tersedia|ditutup/i.test(err.message || "")) {
      absen.mengirim = false;
      muatStatusAbsen();
    }
    const v = absenEl("absenVideo");
    if (absen.stream && v.paused) v.play().catch(() => {});
  } finally {
    absen.mengirim = false;
    btn.textContent = "Kirim";
    absenPerbaruiTombol();
  }
}

function absenToast(teks) {
  const el = document.createElement("div");
  el.className = "absen-toast";
  el.textContent = teks;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ===================================================
// KELOMPOK 11: PEMASANGAN EVENT DAN PEMUAT ULANG OTOMATIS
// ===================================================
document.addEventListener("DOMContentLoaded", () => {
  const track = absenEl("absenTrack");

  // Tombol di dalam kartu (delegasi, karena kartu digambar ulang)
  track.addEventListener("click", (e) => {
    if (e.target.closest("[data-retry]")) { muatStatusAbsen(); return; }
    const btn = e.target.closest("[data-aksi]");
    if (!btn || btn.disabled) return;
    const kartu = btn.closest(".absen-kartu");
    if (kartu) bukaModalAbsen(btn.dataset.aksi, kartu.dataset.tgl);
  });

  // Titik penanda mengikuti kartu yang sedang terlihat
  let menunggu = false;
  track.addEventListener("scroll", () => {
    if (menunggu) return;
    menunggu = true;
    requestAnimationFrame(() => { menunggu = false; absenPerbaruiDots(); });
  }, { passive: true });

  // Layar absen
  absenEl("btnAbsenTutup").addEventListener("click", tutupModalAbsen);
  absenEl("btnAbsenKameraCoba").addEventListener("click", mulaiKameraAbsen);
  absenEl("btnAbsenCoba").addEventListener("click", mulaiPosisiAbsen);
  absenEl("btnAbsenKirim").addEventListener("click", kirimAbsen);
  absenEl("btnAbsenLokasi").addEventListener("click", bukaPetaAbsen);
  absenEl("btnPetaTutup").addEventListener("click", tutupPetaAbsen);
  absenEl("btnPetaCoba").addEventListener("click", bukaPetaAbsen);

  // Keterangan "Tepat Waktu / Terlambat" mengikuti jam; kartu dimuat ulang berkala
  setInterval(absenPerbaruiBadge, 30000);
  setInterval(() => {
    if (!document.hidden && !absen.modalTerbuka && !absen.mengirim) muatStatusAbsen();
  }, ABSEN_REFRESH_MS);
});