// File: js/wrapping.js
// Modul Sisa Wrapping - Barang IN, Barang OUT (scan QR), Cari/Cek Stok

const STORAGE_BUCKET = "wrapping-photos";

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

  // C.4: Peringatan duplikasi -- confirm(), bukan hard block
  const duplicateCount = await checkDuplicateAndWarnBanner(kodeArtikel);
  if (duplicateCount > 0) {
    const lanjut = confirm(`PERINGATAN: Kode artikel "${kodeArtikel}" masih memiliki ${duplicateCount} barang berstatus AKTIF di gudang. Tetap lanjutkan input?`);
    if (!lanjut) return;
  }

  btnSubmitInText.innerText = "Menyimpan...";
  btnSubmitInSpinner.style.display = "inline-block";
  btnSubmitIn.disabled = true;

  try {
    const compressedBlob = await compressImage(fotoInput);
    const fileName = `Foto_Barang/IN_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`;

    const { error: uploadErr } = await window.supabaseClient.storage
      .from(STORAGE_BUCKET)
      .upload(fileName, compressedBlob, { contentType: "image/jpeg" });

    if (uploadErr) throw new Error("Gagal upload foto ke Storage: " + uploadErr.message);

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

    await insertBarangInWithRetry(basePayload);

    alert("✅ Barang IN berhasil disimpan.");
    document.getElementById("formBarangIn").reset();
    document.getElementById("inNamaBarang").value = "";
    document.getElementById("inCustomer").value = "";
    document.getElementById("inPetugas").value = currentActiveUser.fullName || currentActiveUser.username;
    document.getElementById("inTanggalMasuk").value = new Date().toLocaleDateString("id-ID");
    document.getElementById("stickyWarningBanner").style.display = "none";
    selectedArtikelData = null;
    closeModal("modalIn");

  } catch (err) {
    alert("Gagal menyimpan Barang IN: " + err.message);
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

  const { data } = await window.supabaseClient
    .schema("stg_public")
    .from("artikel")
    .select("kode_artikel, nama_barang")
    .ilike("kode_artikel", `%${keyword}%`)
    .limit(8);

  if (!data || data.length === 0) {
    box.style.display = "none";
    return;
  }

  box.innerHTML = data.map(item => `
    <div class="suggestion-item" data-kode="${item.kode_artikel}">
      <strong>${item.kode_artikel}</strong> - ${item.nama_barang || ''}
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
    container.innerHTML = `<p style="text-align:center;color:var(--text-muted);font-size:0.8rem;">Masukkan kode artikel untuk mencari.</p>`;
    return;
  }

  const { data, error } = await window.supabaseClient
    .schema("stg_public")
    .from("sisa_wrapping")
    .select("id, kode_artikel, batch_number, qty, tanggal_masuk, foto_path")
    .ilike("kode_artikel", `%${keyword}%`)
    .eq("is_active", true)
    .order("tanggal_masuk", { ascending: false });

  if (error || !data || data.length === 0) {
    container.innerHTML = `<p style="text-align:center;color:var(--text-muted);font-size:0.8rem;">Tidak ada stok aktif ditemukan.</p>`;
    return;
  }

  container.innerHTML = data.map(row => `
    <div class="result-item-card" style="display:flex; gap:10px; align-items:center;">
      <img src="${row.foto_path || ''}" class="item-thumbnail" onclick="previewImage('${row.foto_path}')">
      <div>
        <strong>${row.kode_artikel}</strong> - Batch ${row.batch_number}<br>
        <span style="font-size:0.75rem;color:var(--text-muted);">Qty: ${row.qty} | Masuk: ${row.tanggal_masuk}</span>
      </div>
    </div>
  `).join("");
}

function previewImage(url) {
  if (!url) return;
  document.getElementById("fullImageTarget").src = url;
  openModal("modalImagePreview");
}