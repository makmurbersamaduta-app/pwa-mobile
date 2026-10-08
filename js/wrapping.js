// File: js/wrapping.js
// Modul Sisa Wrapping - Barang IN, Barang OUT (scan QR), Cari/Cek Stok

const STORAGE_BUCKET = "wrapping-photos";

// Format Kode Artikel WAJIB: B1-B1C007-0002A
//  (B1|L1|P1) = awalan, boleh B1 / L1 / P1
//  -B1        = tetap
//  C007       = kode customer: 1 huruf + 3 angka
//  -          = strip pemisah
//  0002A      = kode design: 4 angka + 1 huruf
const KODE_ARTIKEL_REGEX = /^(B1|L1|P1)-B1[A-Z][0-9]{3}-[0-9]{4}[A-Z]$/;
const KODE_ARTIKEL_MAXLEN = 15;

let searchResultsCache = [];       // hasil pencarian terakhir (dipakai modal detail)
let detailContext = { row: null }; // baris yang sedang dibuka di modal detail
let detailReq = 0;                 // penanda permintaan terbaru modal detail

let currentActiveUser = null;      // data user aktif dari sesi (bukan dummy)
let selectedArtikelData = null;    // data artikel terpilih dari auto-suggest saat Barang IN
let html5QrCodeInstance = null;    // instance scanner, dipakai untuk start/stop

document.addEventListener("DOMContentLoaded", () => {
  // ============================================================
  // 1. AUTH GUARD LAPIS KEDUA
  // auth.js sudah menjalankan guard global-nya sendiri lebih dulu.
  // Blok ini pengaman tambahan khusus modul ini: pastikan
  // currentActiveUser TERISI VALID sebelum form apapun bisa dipakai.
  // Tidak ada fallback dummy sama sekali -- kalau sesi kosong,
  // langsung tendang ke login, titik.
  // ============================================================
  const sessionDataRaw = localStorage.getItem("pwa_mobile_session") || sessionStorage.getItem("pwa_mobile_session");
  if (!sessionDataRaw) {
    window.location.replace("../login.html");
    return;
  }
  currentActiveUser = JSON.parse(sessionDataRaw);

  // Isi field readonly Petugas & Tanggal begitu sesi valid didapat
  const inPetugas = document.getElementById("inPetugas");
  if (inPetugas) inPetugas.value = currentActiveUser.fullName || currentActiveUser.username;

  const inTanggalMasuk = document.getElementById("inTanggalMasuk");
  if (inTanggalMasuk) inTanggalMasuk.value = new Date().toLocaleDateString("id-ID");

  // ============================================================
  // 2. TOMBOL BUKA MODAL
  // ============================================================
  document.getElementById("btnOpenModalIn")?.addEventListener("click", () => openModal("modalIn"));
  document.getElementById("btnOpenModalSearch")?.addEventListener("click", () => openModal("modalSearch"));
  document.getElementById("btnOpenScannerOut")?.addEventListener("click", openModalOut);

  // ============================================================
  // 3. AUTO-SUGGEST KODE ARTIKEL (Form Barang IN)
  // ============================================================
  const inKodeArtikel = document.getElementById("inKodeArtikel");
  if (inKodeArtikel) {
    inKodeArtikel.addEventListener("input", debounce(handleArtikelSuggest, 350));
  }

  // ============================================================
  // 4. SUBMIT FORM BARANG IN & FORM KONFIRMASI BARANG OUT
  // ============================================================
  document.getElementById("formBarangIn")?.addEventListener("submit", handleSubmitBarangIn);
  document.getElementById("formConfirmOut")?.addEventListener("submit", handleSubmitBarangOut);

  // ============================================================
  // 5. SEARCH / CEK STOK
  // ============================================================
  document.getElementById("btnExecuteSearch")?.addEventListener("click", handleExecuteSearch);
  const searchKeyword = document.getElementById("searchKeyword");
  if (searchKeyword) {
    searchKeyword.addEventListener("input", debounce(handleSearchSuggest, 350));
  }

  // TAMBAHKAN di dalam DOMContentLoaded:
  const inQty = document.getElementById("inQty");
  if (inQty) {
    inQty.addEventListener("input", handleQtyAutoSeparator);
  }

  setupKodeArtikelRule();
  setupDetailModal();
});

// ===================================================
// AUTO SEPARATOR RIBUAN UNTUK INPUT QTY (Barang IN)
// Tampilan: "12.000" -- Nilai asli yang dikirim ke DB tetap angka murni
// ===================================================
function handleQtyAutoSeparator(e) {
  const input = e.target;
  const rawDigitsOnly = input.value.replace(/\D/g, ""); // buang semua kecuali angka

  if (!rawDigitsOnly) {
    input.value = "";
    return;
  }

  input.value = Number(rawDigitsOnly).toLocaleString("id-ID");
}

// Helper: ambil angka murni dari input yang sudah berformat "12.000"
function parseQtyValue(formattedValue) {
  return Number(formattedValue.replace(/\D/g, ""));
}

// ===================================================
// UTILITAS: DEBOUNCE
// Menunda eksekusi fungsi sampai user berhenti mengetik selama
// `delay` ms -- supaya tidak query ke database di setiap ketukan huruf.
// ===================================================
function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

// ===================================================
// UTILITAS: BUKA / TUTUP MODAL (dipanggil juga langsung dari HTML onclick)
// ===================================================
function openModal(modalId) {
  document.getElementById(modalId)?.classList.add("show");
}
function closeModal(modalId) {
  document.getElementById(modalId)?.classList.remove("show");
}

// ===================================================
// 2. AUTO-SUGGEST KODE ARTIKEL
// Query ke stg_public.artikel, tampilkan daftar di #suggestionBox
// ===================================================
async function handleArtikelSuggest() {
  const keyword = document.getElementById("inKodeArtikel").value.trim();
  const suggestionBox = document.getElementById("suggestionBox");

  if (!keyword) {
    suggestionBox.style.display = "none";
    suggestionBox.innerHTML = "";
    return;
  }

  const { data, error } = await window.supabaseClient
    .schema("stg_public")
    .from("artikel")
    .select("kode_artikel, nama_barang, customer")
    .ilike("kode_artikel", `%${keyword}%`)
    .limit(8);

  if (error || !data || data.length === 0) {
    suggestionBox.style.display = "none";
    suggestionBox.innerHTML = "";
    return;
  }

  suggestionBox.innerHTML = data.map(item => `
    <div class="suggestion-item" data-kode="${item.kode_artikel}" data-nama="${item.nama_barang || ''}" data-customer="${item.customer || ''}">
      <strong>${item.kode_artikel}</strong> - ${item.nama_barang || '(tanpa nama)'}
    </div>
  `).join("");
  suggestionBox.style.display = "block";

  // Klik salah satu saran -> isi form otomatis
  suggestionBox.querySelectorAll(".suggestion-item").forEach(el => {
    el.addEventListener("click", () => selectArtikel(el.dataset));
  });
}

async function selectArtikel(dataset) {
  document.getElementById("inKodeArtikel").value = dataset.kode;
  document.getElementById("inNamaBarang").value = dataset.nama;
  document.getElementById("inCustomer").value = dataset.customer;
  document.getElementById("suggestionBox").style.display = "none";
  selectedArtikelData = dataset;
  updateKodeArtikelHint();

  // Cek duplikasi aktif -> tampilkan sticky warning banner kalau ada
  await checkDuplicateAndWarnBanner(dataset.kode);
}

// ===================================================
// C.4: CEK DUPLIKASI (PERINGATAN, BUKAN HARD BLOCK)
// ===================================================
async function checkDuplicateAndWarnBanner(kodeArtikel) {
  const { data } = await window.supabaseClient
    .schema("stg_public")
    .from("sisa_wrapping")
    .select("id")
    .eq("kode_artikel", kodeArtikel)
    .eq("is_active", true);

  const banner = document.getElementById("stickyWarningBanner");
  if (data && data.length > 0) {
    banner.style.display = "flex";
  } else {
    banner.style.display = "none";
  }
  return data ? data.length : 0;
}

// ===================================================
// C.3: GENERATE ID HEX 12 KARAKTER + INSERT DENGAN RETRY
// ===================================================
function generateShortId(length = 12) {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').slice(0, length);
}

async function insertBarangInWithRetry(basePayload, maxRetry = 3) {
  for (let attempt = 0; attempt < maxRetry; attempt++) {
    const payload = { ...basePayload, id: generateShortId(12) };
    const { error } = await window.supabaseClient
      .schema("stg_public")
      .from("sisa_wrapping")
      .insert([payload]);

    if (!error) return { success: true, id: payload.id };
    if (error.code !== '23505') throw error; // bukan tabrakan ID -> lempar ke pemanggil
  }
  throw new Error("Gagal membuat ID unik setelah beberapa percobaan, coba submit ulang.");
}

// ===================================================
// UTILITAS: KOMPRESI FOTO SEBELUM UPLOAD
// Resize ke maksimal 1024px di sisi terpanjang, kualitas JPEG 70%
// -- supaya ukuran file kecil, hemat kuota data & Storage.
// ===================================================
function compressImage(fileInput) {
  return new Promise((resolve, reject) => {
    const file = fileInput.files[0];
    if (!file) return reject(new Error("Tidak ada foto dipilih."));

    const img = new Image();
    const reader = new FileReader();

    reader.onload = (e) => { img.src = e.target.result; };
    reader.onerror = () => reject(new Error("Gagal membaca file foto."));

    img.onload = () => {
      const maxSize = 1024;
      let { width, height } = img;
      if (width > height && width > maxSize) {
        height *= maxSize / width;
        width = maxSize;
      } else if (height > maxSize) {
        width *= maxSize / height;
        height = maxSize;
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);

      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error("Gagal kompresi foto.")),
        "image/jpeg",
        0.7
      );
    };

    reader.readAsDataURL(file);
  });
}

// ===================================================
// 3. SUBMIT FORM BARANG IN
// ===================================================
async function handleSubmitBarangIn(e) {
  e.preventDefault();

  const btnSubmitIn = document.getElementById("btnSubmitIn");
  const btnSubmitInText = document.getElementById("btnSubmitInText");
  const btnSubmitInSpinner = document.getElementById("btnSubmitInSpinner");

  const kodeArtikel = document.getElementById("inKodeArtikel").value.trim().toUpperCase();
  const batchNumber = document.getElementById("inBatchNumber").value.trim().toUpperCase();
  const qty = parseQtyValue(document.getElementById("inQty").value);
  const shift = document.getElementById("inShift").value;
  const fotoInput = document.getElementById("inFotoInput");

  if (!kodeArtikel || !batchNumber || !qty || !shift || !fotoInput.files[0]) {
    alert("Semua field wajib diisi, termasuk foto barang.");
    return;
  }

  // Hard lock: format Kode Artikel harus sesuai aturan
  if (!KODE_ARTIKEL_REGEX.test(kodeArtikel)) {
    alert(
      "FORMAT KODE ARTIKEL TIDAK SESUAI.\n\n" +
      "Format wajib: B1-B1C007-0002A\n" +
      "• Awalan: B1, L1, atau P1\n" +
      "• Lalu \"-B1\" (tetap)\n" +
      "• Kode customer: 1 huruf + 3 angka (contoh C007)\n" +
      "• Strip \"-\"\n" +
      "• Kode design: 4 angka + 1 huruf (contoh 0002A)\n\n" +
      "Data tidak disimpan."
    );
    return;
  }

  // C.4: Peringatan duplikasi -- confirm(), bukan hard block
  const duplicateCount = await checkDuplicateAndWarnBanner(kodeArtikel);
  if (duplicateCount > 0) {
    const lanjut = confirm(`PERINGATAN: Kode artikel "${kodeArtikel}" masih memiliki ${duplicateCount} barang berstatus AKTIF di gudang. Tetap lanjutkan input?`);
    if (!lanjut) return;
  }

  btnSubmitInText.innerText = "Menyimpan...";
  btnSubmitInSpinner.style.display = "inline-block";
  btnSubmitIn.disabled = true;

  let uploadedFileName = null; // terisi setelah foto berhasil diunggah
  let insertDone = false;      // true setelah data berhasil masuk ke tabel

  try {
    const compressedBlob = await compressImage(fotoInput);
    const fileName = `Foto_Barang/IN_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`;

    // LANGKAH 1: unggah foto ke Storage
    const { error: uploadErr } = await window.supabaseClient.storage
      .from(STORAGE_BUCKET)
      .upload(fileName, compressedBlob, { contentType: "image/jpeg" });

    if (uploadErr) throw new Error("Gagal upload foto ke Storage: " + uploadErr.message);
    uploadedFileName = fileName;

    const { data: publicUrlData } = window.supabaseClient.storage.from(STORAGE_BUCKET).getPublicUrl(fileName);
    const fotoPublicUrl = publicUrlData.publicUrl;

    const basePayload = {
      kode_artikel: kodeArtikel,
      batch_number: batchNumber,
      tanggal_masuk: new Date().toISOString().split("T")[0],
      qty: qty,
      shift_in: shift,
      petugas_in: currentActiveUser.fullName || currentActiveUser.username,
      foto_path: fotoPublicUrl,
      is_active: true
    };

    // LANGKAH 2: simpan data. Jika gagal, foto dari langkah 1 dibatalkan (lihat catch).
    await insertBarangInWithRetry(basePayload);
    insertDone = true;

    alert("✅ Barang IN berhasil disimpan.");
    document.getElementById("formBarangIn").reset();
    updateKodeArtikelHint();
    document.getElementById("inNamaBarang").value = "";
    document.getElementById("inCustomer").value = "";
    document.getElementById("inPetugas").value = currentActiveUser.fullName || currentActiveUser.username;
    document.getElementById("inTanggalMasuk").value = new Date().toLocaleDateString("id-ID");
    document.getElementById("stickyWarningBanner").style.display = "none";
    selectedArtikelData = null;
    closeModal("modalIn");

  } catch (err) {
    let pesan = "BARANG IN DIBATALKAN. Tidak ada data yang tersimpan.\n\nPenyebab: " + err.message;

    // Foto sudah terunggah tapi data gagal masuk -> hapus fotonya
    if (uploadedFileName && !insertDone) {
      const terhapus = await rollbackUploadedPhoto(uploadedFileName);
      if (!terhapus) {
        pesan += "\n\nPERINGATAN: foto sempat terunggah dan GAGAL dihapus otomatis (" + uploadedFileName + "). Mohon laporkan ke admin.";
      }
    }
    alert(pesan);
  } finally {
    btnSubmitInText.innerText = "Simpan Barang IN";
    btnSubmitInSpinner.style.display = "none";
    btnSubmitIn.disabled = false;
  }
}

// ===================================================
// BARANG OUT: SCANNER QR
// ===================================================
function openModalOut() {
  openModal("modalOut");
  document.getElementById("scannerSection").style.display = "block";
  document.getElementById("formConfirmOut").style.display = "none";

  html5QrCodeInstance = new Html5Qrcode("qr-reader");
  html5QrCodeInstance.start(
    { facingMode: "environment" },
    { fps: 10, qrbox: 250 },
    onScanSuccess,
    () => { /* error per-frame diabaikan, normal saat kamera belum fokus */ }
  ).catch(err => {
    alert("Gagal membuka kamera: " + err);
    closeModalOut();
  });
}

function closeModalOut() {
  if (html5QrCodeInstance) {
    html5QrCodeInstance.stop()
      .then(() => html5QrCodeInstance?.clear())
      .catch(() => {}) // scanner mungkin sudah berhenti duluan -- aman diabaikan
      .finally(() => { html5QrCodeInstance = null; });
  }
  closeModal("modalOut");
  document.getElementById("formConfirmOut").reset();
  document.getElementById("formConfirmOut").style.display = "none";
  document.getElementById("scannerSection").style.display = "block";
}

async function onScanSuccess(decodedText) {
  // Hentikan kamera segera setelah dapat hasil, supaya tidak scan berkali-kali
  if (html5QrCodeInstance) {
    await html5QrCodeInstance.stop().catch(() => {});
    html5QrCodeInstance = null; // tandai sudah berhenti, supaya closeModalOut() tidak stop() lagi
  }

  const { data: rowData, error } = await window.supabaseClient
    .schema("stg_public")
    .from("sisa_wrapping")
    .select("id, kode_artikel, batch_number, qty, foto_path")
    .eq("id", decodedText)
    .eq("is_active", true)
    .maybeSingle();

  if (error || !rowData) {
    alert("QR tidak dikenali atau barang sudah tidak aktif (mungkin sudah di-OUT sebelumnya).");
    closeModalOut();
    return;
  }

  const { data: artikelData } = await window.supabaseClient
    .schema("stg_public")
    .from("artikel")
    .select("nama_barang, customer")
    .eq("kode_artikel", rowData.kode_artikel)
    .maybeSingle();

  document.getElementById("outRowId").value = rowData.id;
  document.getElementById("outKodeArtikel").value = rowData.kode_artikel;
  document.getElementById("outNamaCustomer").value = `${artikelData?.nama_barang || '-'} / ${artikelData?.customer || '-'}`;
  document.getElementById("outBatchQty").value = `${rowData.batch_number} / ${rowData.qty} pcs`;
  document.getElementById("outPetugas").value = currentActiveUser.fullName || currentActiveUser.username;
  document.getElementById("outPreviewImg").src = rowData.foto_path || "";

  document.getElementById("scannerSection").style.display = "none";
  document.getElementById("formConfirmOut").style.display = "block";
}

async function handleSubmitBarangOut(e) {
  e.preventDefault();

  const btnSubmitOut = document.getElementById("btnSubmitOut");
  const btnSubmitOutText = document.getElementById("btnSubmitOutText");
  const btnSubmitOutSpinner = document.getElementById("btnSubmitOutSpinner");

  const rowId = document.getElementById("outRowId").value;
  const shiftOut = document.getElementById("outShift").value;

  if (!shiftOut) {
    alert("Pilih Shift Keluar terlebih dahulu.");
    return;
  }

  btnSubmitOutText.innerText = "Memproses...";
  btnSubmitOutSpinner.style.display = "inline-block";
  btnSubmitOut.disabled = true;

  try {
    const { error } = await window.supabaseClient
      .schema("stg_public")
      .from("sisa_wrapping")
      .update({
        is_active: false,
        tanggal_out: new Date().toISOString().split("T")[0],
        petugas_out: currentActiveUser.fullName || currentActiveUser.username,
        shift_out: shiftOut,
        update_at: new Date().toISOString()
      })
      .eq("id", rowId)
      .eq("is_active", true); // jaga-jaga: tidak proses ulang barang yang sudah OUT duluan

    if (error) throw new Error(error.message);

    alert("✅ Barang OUT berhasil diproses.");
    closeModalOut();

  } catch (err) {
    alert("Gagal memproses Barang OUT: " + err.message);
  } finally {
    btnSubmitOutText.innerText = "Proses Barang OUT";
    btnSubmitOutSpinner.style.display = "none";
    btnSubmitOut.disabled = false;
  }
}

// ===================================================
// CARI / CEK STOK
// ===================================================
async function handleSearchSuggest() {
  const keyword = document.getElementById("searchKeyword").value.trim();
  const box = document.getElementById("searchSuggestionBox");

  if (!keyword) {
    box.style.display = "none";
    box.innerHTML = "";
    return;
  }

  // Saran HANYA dari kode artikel yang masih punya stok aktif (is_active = true)
  const { data: activeRows, error } = await window.supabaseClient
    .schema("stg_public")
    .from("sisa_wrapping")
    .select("kode_artikel")
    .eq("is_active", true)
    .ilike("kode_artikel", `%${keyword}%`)
    .order("kode_artikel")
    .limit(100);

  if (error || !activeRows || activeRows.length === 0) {
    box.style.display = "none";
    box.innerHTML = "";
    return;
  }

  // Satu kode artikel bisa punya banyak baris aktif -> ambil yang unik, maksimal 8
  const codes = [...new Set(activeRows.map(r => r.kode_artikel))].slice(0, 8);

  // Nama barang diambil dari tabel artikel (tabel sisa_wrapping tidak menyimpannya)
  const { data: artikelRows } = await window.supabaseClient
    .schema("stg_public")
    .from("artikel")
    .select("kode_artikel, nama_barang")
    .in("kode_artikel", codes);

  const namaByKode = {};
  (artikelRows || []).forEach(a => { namaByKode[a.kode_artikel] = a.nama_barang; });

  box.innerHTML = codes.map(kode => `
    <div class="suggestion-item" data-kode="${escapeHtml(kode)}">
      <strong>${escapeHtml(kode)}</strong> - ${escapeHtml(namaByKode[kode] || '')}
    </div>
  `).join("");
  box.style.display = "block";

  box.querySelectorAll(".suggestion-item").forEach(el => {
    el.addEventListener("click", () => {
      document.getElementById("searchKeyword").value = el.dataset.kode;
      box.style.display = "none";
      handleExecuteSearch();
    });
  });
}

async function handleExecuteSearch() {
  const keyword = document.getElementById("searchKeyword").value.trim();
  const container = document.getElementById("searchResultsContainer");

  if (!keyword) {
    searchResultsCache = [];
    container.innerHTML = `<p style="text-align:center;color:var(--text-muted);font-size:0.8rem;">Masukkan kode artikel untuk mencari.</p>`;
    return;
  }

  const { data, error } = await window.supabaseClient
    .schema("stg_public")
    .from("sisa_wrapping")
    .select("id, kode_artikel, batch_number, qty, tanggal_masuk, petugas_in, foto_path")
    .ilike("kode_artikel", `%${keyword}%`)
    .eq("is_active", true)
    .order("tanggal_masuk", { ascending: false });

  if (error || !data || data.length === 0) {
    searchResultsCache = [];
    container.innerHTML = `<p style="text-align:center;color:var(--text-muted);font-size:0.8rem;">Tidak ada stok aktif ditemukan.</p>`;
    return;
  }

  searchResultsCache = data; // disimpan agar modal detail tidak perlu query ulang

  // Setiap kartu bisa diklik -> modal detail. Klik pada foto kecil -> preview foto.
  container.innerHTML = data.map(row => `
    <div class="result-item-card result-clickable" data-id="${escapeHtml(row.id)}" style="display:flex; gap:10px; align-items:center; cursor:pointer;">
      <img src="${escapeHtml(row.foto_path || '')}" class="item-thumbnail" data-foto="${escapeHtml(row.foto_path || '')}">
      <div style="flex:1;">
        <strong>${escapeHtml(row.kode_artikel)}</strong> - Batch ${escapeHtml(row.batch_number)}<br>
        <span style="font-size:0.75rem;color:var(--text-muted);">Qty: ${escapeHtml(row.qty)} | Masuk: ${escapeHtml(row.tanggal_masuk)}</span>
      </div>
      <i class="fa-solid fa-chevron-right" style="color:var(--text-muted); font-size:0.8rem;"></i>
    </div>
  `).join("");
}

function previewImage(url) {
  if (!url) return;
  document.getElementById("fullImageTarget").src = url;
  openModal("modalImagePreview");
}


// ===================================================
// ROLLBACK FOTO (dipakai saat simpan Barang IN gagal)
// Mengembalikan true hanya jika file benar-benar terhapus.
// ===================================================
async function rollbackUploadedPhoto(fileName) {
  try {
    const { data, error } = await window.supabaseClient.storage
      .from(STORAGE_BUCKET)
      .remove([fileName]);
    // Jika tidak punya izin hapus, Storage mengembalikan daftar kosong TANPA error
    if (error || !data || data.length === 0) return false;
    return true;
  } catch (e) {
    return false;
  }
}

// ===================================================
// UTILITAS: escape teks sebelum disisipkan ke HTML
// ===================================================
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ===================================================
// ATURAN INPUT KODE ARTIKEL (Barang IN)
// - Otomatis huruf besar, hanya huruf/angka/strip, maksimal 15 karakter
// - Peringatan langsung di bawah kolom; simpan diblokir jika tidak sesuai
// ===================================================
function setupKodeArtikelRule() {
  const input = document.getElementById("inKodeArtikel");
  if (!input) return;

  input.addEventListener("input", () => {
    const clean = input.value.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, KODE_ARTIKEL_MAXLEN);
    if (clean !== input.value) input.value = clean;
    updateKodeArtikelHint();
  });
}

function updateKodeArtikelHint() {
  const input = document.getElementById("inKodeArtikel");
  const hint = document.getElementById("kodeArtikelHint");
  if (!input || !hint) return;

  const value = input.value.trim();
  if (!value) {
    hint.style.display = "none";
    input.style.borderColor = "";
    return;
  }

  hint.style.display = "block";
  if (KODE_ARTIKEL_REGEX.test(value)) {
    hint.style.color = "#15803d";
    hint.textContent = "✅ Format kode artikel sesuai.";
    input.style.borderColor = "#15803d";
  } else {
    hint.style.color = "#b91c1c";
    hint.textContent = "⚠️ Format tidak sesuai. Wajib: B1-B1C007-0002A (awalan B1/L1/P1, kode customer 1 huruf + 3 angka, strip, kode design 4 angka + 1 huruf).";
    input.style.borderColor = "#b91c1c";
  }
}

// ===================================================
// MODAL DETAIL BARANG (muncul saat kartu hasil pencarian diklik)
// Awalnya semua terkunci. Tombol "Edit" membuka Batch Number & Qty saja.
// ===================================================
function setupDetailModal() {
  document.getElementById("searchResultsContainer")?.addEventListener("click", (e) => {
    const thumb = e.target.closest(".item-thumbnail");
    if (thumb) {
      previewImage(thumb.getAttribute("data-foto"));
      return;
    }
    const card = e.target.closest(".result-item-card[data-id]");
    if (card) openDetailModal(card.getAttribute("data-id"));
  });

  document.getElementById("btnDetailEdit")?.addEventListener("click", () => setDetailEditMode(true));
  document.getElementById("btnDetailBatal")?.addEventListener("click", cancelDetailEdit);
  document.getElementById("btnDetailSimpan")?.addEventListener("click", saveDetailEdit);
  document.getElementById("dtQty")?.addEventListener("input", handleQtyAutoSeparator);
}

function formatTanggalId(isoDate) {
  if (!isoDate) return "";
  const [y, m, d] = String(isoDate).split("-");
  return (y && m && d) ? `${d}/${m}/${y}` : String(isoDate);
}

function formatQtyDisplay(qty) {
  if (qty === null || qty === undefined) return "";
  return Number(qty).toLocaleString("id-ID", { maximumFractionDigits: 3 });
}

function fillDetailModal(row) {
  document.getElementById("dtKodeArtikel").value = row.kode_artikel || "";
  document.getElementById("dtBatch").value = row.batch_number || "";
  document.getElementById("dtQty").value = formatQtyDisplay(row.qty);
  document.getElementById("dtTglMasuk").value = formatTanggalId(row.tanggal_masuk);
  document.getElementById("dtPetugas").value = row.petugas_in || "";
}

function renderDetailPhoto(url) {
  const wrap = document.getElementById("detailFotoWrapper");
  wrap.innerHTML = "";

  if (!url) {
    wrap.innerHTML = `<span style="font-size:0.78rem;color:var(--text-muted);">Tidak ada foto.</span>`;
    return;
  }

  const img = document.createElement("img");
  img.src = url;
  img.alt = "Foto barang";
  img.style.cssText = "width:100%; max-height:220px; object-fit:contain; border-radius:8px; cursor:pointer; background:#f1f5f9;";
  img.onclick = () => previewImage(url);
  img.onerror = () => { wrap.innerHTML = `<span style="font-size:0.78rem;color:var(--text-muted);">Foto tidak dapat dimuat.</span>`; };
  wrap.appendChild(img);
}

async function openDetailModal(id) {
  const row = searchResultsCache.find(r => String(r.id) === String(id));
  if (!row) return;

  detailContext = { row: row };
  const myReq = ++detailReq;

  fillDetailModal(row);
  document.getElementById("dtNamaBarang").value = "Memuat...";
  document.getElementById("dtCustomer").value = "Memuat...";
  renderDetailPhoto(row.foto_path);
  setDetailEditMode(false);
  openModal("modalDetail");

  // Nama barang & customer berasal dari tabel artikel
  const { data: artikel } = await window.supabaseClient
    .schema("stg_public")
    .from("artikel")
    .select("nama_barang, customer")
    .eq("kode_artikel", row.kode_artikel)
    .maybeSingle();

  if (myReq !== detailReq) return; // modal sudah ditutup / pindah baris
  document.getElementById("dtNamaBarang").value = artikel?.nama_barang || "-";
  document.getElementById("dtCustomer").value = artikel?.customer || "-";
}

function closeDetailModal() {
  detailReq++;
  detailContext = { row: null };
  closeModal("modalDetail");
}

function showDetailMessage(text, type) {
  const el = document.getElementById("detailMessage");
  if (!text) {
    el.style.display = "none";
    el.textContent = "";
    return;
  }
  const colors = {
    danger:  { bg: "#fee2e2", fg: "#b91c1c" },
    success: { bg: "#dcfce7", fg: "#166534" },
    info:    { bg: "#e0f2fe", fg: "#075985" }
  };
  const c = colors[type] || colors.info;
  el.style.background = c.bg;
  el.style.color = c.fg;
  el.textContent = text;
  el.style.display = "block";
}

// on = true  -> Batch Number & Qty bisa diedit; muncul Batal + Simpan
// on = false -> semua terkunci; muncul Edit + Tutup
function setDetailEditMode(on) {
  const row = detailContext.row;
  const batch = document.getElementById("dtBatch");
  const qty = document.getElementById("dtQty");

  // Qty desimal tidak bisa diedit dari PWA (input PWA hanya bilangan bulat)
  const qtyEditable = row ? Number.isInteger(Number(row.qty)) : true;

  batch.readOnly = !on;
  qty.readOnly = !(on && qtyEditable);

  document.getElementById("btnDetailEdit").style.display = on ? "none" : "block";
  document.getElementById("btnDetailTutup").style.display = on ? "none" : "block";
  document.getElementById("btnDetailBatal").style.display = on ? "block" : "none";
  document.getElementById("btnDetailSimpan").style.display = on ? "block" : "none";

  showDetailMessage("", "");
  if (on && !qtyEditable) {
    showDetailMessage("Qty bernilai desimal, hanya bisa diubah dari Web ERP.", "info");
  }
  if (on) batch.focus();
}

function cancelDetailEdit() {
  if (detailContext.row) fillDetailModal(detailContext.row); // kembalikan ke nilai awal
  setDetailEditMode(false);
}

async function saveDetailEdit() {
  const row = detailContext.row;
  if (!row) return;

  const qtyEditable = Number.isInteger(Number(row.qty));
  const newBatch = document.getElementById("dtBatch").value.trim().toUpperCase();
  const newQty = qtyEditable ? parseQtyValue(document.getElementById("dtQty").value) : Number(row.qty);

  if (!newBatch || !newQty) {
    showDetailMessage("Batch Number dan Qty wajib diisi (Qty harus lebih dari 0).", "danger");
    return;
  }

  if (newBatch === (row.batch_number || "") && newQty === Number(row.qty)) {
    setDetailEditMode(false); // tidak ada perubahan
    return;
  }

  const btnSimpan = document.getElementById("btnDetailSimpan");
  const btnBatal = document.getElementById("btnDetailBatal");
  const origText = btnSimpan.textContent;
  btnSimpan.disabled = true;
  btnBatal.disabled = true;
  btnSimpan.textContent = "Menyimpan...";

  try {
    // .select("id") memastikan ada baris yang benar-benar berubah
    const { data, error } = await window.supabaseClient
      .schema("stg_public")
      .from("sisa_wrapping")
      .update({
        batch_number: newBatch,
        qty: newQty,
        update_at: new Date().toISOString()
      })
      .eq("id", row.id)
      .eq("is_active", true)
      .select("id");

    if (error) throw error;

    if (!data || data.length === 0) {
      showDetailMessage("Tidak ada data yang tersimpan. Kemungkinan barang sudah di-OUT atau dihapus, atau akun ini tidak punya izin mengubah data.", "danger");
      return;
    }

    row.batch_number = newBatch;
    row.qty = newQty;
    fillDetailModal(row);
    setDetailEditMode(false);
    showDetailMessage("Perubahan berhasil disimpan.", "success");
    await handleExecuteSearch(); // segarkan daftar hasil pencarian

  } catch (err) {
    showDetailMessage("Gagal menyimpan: " + err.message, "danger");
  } finally {
    btnSimpan.disabled = false;
    btnBatal.disabled = false;
    btnSimpan.textContent = origText;
  }
}