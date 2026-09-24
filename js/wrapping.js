// File: js/wrapping.js

const STORAGE_BUCKET = "wrapping-photos";
const SESSION_KEY = "pwa_mobile_session";

let html5QrCodeScanner = null;
let currentActiveUser = null;

document.addEventListener("DOMContentLoaded", () => {
  const sessionRaw = localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY);
  if (sessionRaw) {
    currentActiveUser = JSON.parse(sessionRaw);
  } else {
    currentActiveUser = { fullName: "Petugas Operator", username: "DMB11001" };
  }
  initModuleEventListeners();
});

function formatTanggalIndo(dateObj) {
  const d = dateObj ? new Date(dateObj) : new Date();
  const months = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
  const day = String(d.getDate()).padStart(2, '0');
  const month = months[d.getMonth()];
  const year = d.getFullYear();
  return `${day} ${month} ${year}`;
}

function initModuleEventListeners() {
  document.getElementById("btnOpenModalIn")?.addEventListener("click", openModalIn);
  document.getElementById("btnOpenScannerOut")?.addEventListener("click", openScannerOut);
  document.getElementById("btnOpenModalSearch")?.addEventListener("click", () => openModal("modalSearch"));

  // Event Auto-Suggest
  document.getElementById("inKodeArtikel")?.addEventListener("input", (e) => {
    handleAutoSuggest(e.target.value, "suggestionBox", "in");
  });
  document.getElementById("searchKeyword")?.addEventListener("input", (e) => {
    handleAutoSuggest(e.target.value, "searchSuggestionBox", "search");
  });

  // Event Auto-Separator Ribuan Qty
  document.getElementById("inQty")?.addEventListener("input", (e) => {
    let value = e.target.value.replace(/[^0-9]/g, ""); 
    if (value) {
      e.target.value = parseInt(value, 10).toLocaleString("id-ID");
    } else {
      e.target.value = "";
    }
  });

  // Peringatan Pertama: Saat user menutup keyboard / pindah dari kolom Qty
  document.getElementById("inQty")?.addEventListener("blur", (e) => {
    // Timeout kecil mencegah bentrok jika user langsung klik tombol Submit
    setTimeout(() => { validatePcsPalletWarning(false); }, 150);
  });

  document.getElementById("formBarangIn")?.addEventListener("submit", handleSubmitBarangIn);
  document.getElementById("formConfirmOut")?.addEventListener("submit", handleSubmitBarangOut);
  document.getElementById("btnExecuteSearch")?.addEventListener("click", handleSearchExecute);
}

function openModal(modalId) { document.getElementById(modalId)?.classList.add("show"); }
function closeModal(modalId) { document.getElementById(modalId)?.classList.remove("show"); }

// Fungsi Logika Validasi Pcs/Pallet
function validatePcsPalletWarning(isSubmitContext) {
  const rawQty = document.getElementById("inQty")?.value.replace(/\./g, "");
  if (!rawQty) return true; 

  const qtyValue = parseInt(rawQty, 10);
  const pcsPalletRaw = document.getElementById("inKodeArtikel")?.dataset.pcsPallet;

  if (!pcsPalletRaw || pcsPalletRaw === "null" || pcsPalletRaw === "undefined" || pcsPalletRaw === "") {
    const msg = "Artikel ini tidak memiliki Qty Pcs/Pallet pada database, pastikan Qty barang yg anda masukkan dibawah 50%";
    if (isSubmitContext) {
      return confirm(msg + "\n\nApakah Anda yakin ingin tetap melanjutkan submit?");
    } else {
      alert(msg);
      return true; // Tetap izinkan lanjut jika dari event blur
    }
  } else {
    const pcsPallet = parseFloat(pcsPalletRaw);
    
    // PERBAIKAN: 50% dari pcs/pallet sama dengan dikali 0.5 (dibagi 2)
    const threshold = pcsPallet * 0.5; 
    
    if (qtyValue < threshold) {
      const msg = "Barang dibawah stock minimum penyimpanan!!";
      if (isSubmitContext) {
        return confirm(msg + "\n\nApakah Anda yakin ingin tetap melanjutkan submit?");
      } else {
        alert(msg);
        return true; 
      }
    }
  }
  return true;
}

async function handleAutoSuggest(keyword, boxId, mode) {
  const suggestionBox = document.getElementById(boxId);
  keyword = keyword.trim().toUpperCase();

  if (keyword.length < 2) {
    suggestionBox.style.display = "none";
    return;
  }

  try {
    // Menambahkan field pcs_pallet ke dalam tarikan query
    const { data: artikelList, error } = await window.supabaseClient
      .schema("stg_public")
      .from("artikel")
      .select("kode_artikel, nama_barang, customer, pcs_pallet")
      .ilike("kode_artikel", `%${keyword}%`)
      .limit(6);

    if (error) throw error;

    if (artikelList && artikelList.length > 0) {
      let html = "";
      artikelList.forEach(item => {
        html += `
          <div class="suggestion-item" onclick="selectArtikel('${item.kode_artikel}', '${item.nama_barang}', '${item.customer || '-'}', '${item.pcs_pallet || ''}', '${boxId}', '${mode}')">
            <strong>[${item.kode_artikel}]</strong>, ${item.nama_barang}
          </div>
        `;
      });
      suggestionBox.innerHTML = html;
      suggestionBox.style.display = "block";
    } else {
      suggestionBox.style.display = "none";
    }
  } catch (err) {
    console.error("Error auto-suggest:", err);
  }
}

function selectArtikel(kode, nama, customer, pcsPallet, boxId, mode) {
  document.getElementById(boxId).style.display = "none";
  if (mode === "in") {
    const inputKode = document.getElementById("inKodeArtikel");
    inputKode.value = kode;
    
    // Simpan pcs_pallet ke dataset secara tersembunyi
    inputKode.dataset.pcsPallet = pcsPallet;

    document.getElementById("inNamaBarang").value = nama;
    document.getElementById("inCustomer").value = customer;
    checkDuplicateStock(kode);
  } else if (mode === "search") {
    document.getElementById("searchKeyword").value = kode;
  }
}

function openModalIn() {
  const form = document.getElementById("formBarangIn");
  form.reset();
  document.getElementById("inTanggalMasuk").value = formatTanggalIndo();
  document.getElementById("inPetugas").value = currentActiveUser.fullName || currentActiveUser.username;
  document.getElementById("stickyWarningBanner").style.display = "none";
  document.getElementById("suggestionBox").style.display = "none";
  document.getElementById("inKodeArtikel").dataset.pcsPallet = ""; // Reset dataset
  openModal("modalIn");
}

async function checkDuplicateStock(kodeArtikel) {
  const banner = document.getElementById("stickyWarningBanner");
  const bannerText = document.getElementById("lblWarningText");

  const { count, error } = await window.supabaseClient
    .schema("stg_public")
    .from("sisa_wrapping")
    .select("id", { count: "exact", head: true })
    .eq("kode_artikel", kodeArtikel)
    .eq("is_active", true);

  if (!error && count > 0) {
    bannerText.innerText = `⚠️ PERINGATAN: Kode artikel ini masih memiliki ${count} barang berstatus AKTIF di gudang!`;
    banner.style.display = "flex";
    banner.dataset.hasDuplicate = "true";
  } else {
    banner.style.display = "none";
    banner.dataset.hasDuplicate = "false";
  }
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target.result;
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const MAX_WIDTH = 800;
        let scaleSize = 1;
        if (img.width > MAX_WIDTH) scaleSize = MAX_WIDTH / img.width;
        canvas.width = img.width * scaleSize;
        canvas.height = img.height * scaleSize;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.65);
      };
    };
    reader.onerror = (err) => reject(err);
  });
}

async function handleSubmitBarangIn(e) {
  e.preventDefault();

  // Validasi 1: Duplikasi Stock Aktif
  const hasDuplicate = document.getElementById("stickyWarningBanner").dataset.hasDuplicate === "true";
  if (hasDuplicate) {
    const isConfirm = confirm("Kode artikel ini masih memiliki stok aktif di gudang. Yakin tetap menambah data baru?");
    if (!isConfirm) return;
  }

  // Validasi 2: Pcs / Pallet Minimum Warning (Peringatan Kedua / Final Confirmation)
  const isPcsPalletConfirmed = validatePcsPalletWarning(true);
  if (!isPcsPalletConfirmed) return;

  const btnText = document.getElementById("btnSubmitInText");
  const btnSpinner = document.getElementById("btnSubmitInSpinner");
  const btnSubmit = document.getElementById("btnSubmitIn");

  btnText.innerText = "Mengkompresi & Upload...";
  btnSpinner.style.display = "inline-block";
  btnSubmit.disabled = true;

  try {
    const fileInput = document.getElementById("inFotoInput").files[0];
    if (!fileInput) throw new Error("Foto barang wajib diambil via kamera!");

    const rawQty = document.getElementById("inQty").value.replace(/\./g, "");
    const qtyValue = parseInt(rawQty, 10);

    const compressedBlob = await compressImage(fileInput);
    const fileName = `Foto_Barang/IN_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`;
    
    const { error: uploadErr } = await window.supabaseClient.storage
      .from(STORAGE_BUCKET)
      .upload(fileName, compressedBlob, { contentType: "image/jpeg" });

    if (uploadErr) throw new Error("Gagal upload foto ke Storage: " + uploadErr.message);

    const { data: publicUrlData } = window.supabaseClient.storage.from(STORAGE_BUCKET).getPublicUrl(fileName);
    const fotoPublicUrl = publicUrlData.publicUrl;

    const payload = {
      kode_artikel: document.getElementById("inKodeArtikel").value.trim().toUpperCase(),
      batch_number: document.getElementById("inBatchNumber").value.trim().toUpperCase(),
      tanggal_masuk: new Date().toISOString().split("T")[0],
      qty: qtyValue,
      shift_in: document.getElementById("inShift").value,
      petugas_in: currentActiveUser.fullName || currentActiveUser.username,
      foto_path: fotoPublicUrl,
      is_active: true
    };

    const { error: insertErr } = await window.supabaseClient.schema("stg_public").from("sisa_wrapping").insert([payload]);
    if (insertErr) throw insertErr;

    alert("✅ Data Barang IN berhasil disimpan!");
    closeModal("modalIn");
  } catch (err) {
    alert("Terjadi kesalahan: " + (err.message || err));
  } finally {
    btnText.innerText = "Simpan Barang IN";
    btnSpinner.style.display = "none";
    btnSubmit.disabled = false;
  }
}

// ---------------- Scanner & OUT ---------------- //
function openScannerOut() {
  document.getElementById("scannerSection").style.display = "block";
  document.getElementById("formConfirmOut").style.display = "none";
  openModal("modalOut");

  html5QrCodeScanner = new Html5Qrcode("qr-reader");
  const config = { fps: 10, qrbox: { width: 220, height: 220 } };

  html5QrCodeScanner.start({ facingMode: "environment" }, config, onScanSuccess)
    .catch(err => {
      console.error("Gagal membuka kamera:", err);
      alert("Tidak dapat mengakses kamera ponsel.");
    });
}

function closeModalOut() {
  if (html5QrCodeScanner && html5QrCodeScanner.isScanning) {
    html5QrCodeScanner.stop().then(() => closeModal("modalOut"));
  } else {
    closeModal("modalOut");
  }
}

async function onScanSuccess(decodedText) {
  if (html5QrCodeScanner) await html5QrCodeScanner.stop();
  document.getElementById("scannerSection").style.display = "none";

  try {
    const { data: itemData, error } = await window.supabaseClient
      .schema("stg_public")
      .from("sisa_wrapping")
      .select("*")
      .eq("id", decodedText)
      .maybeSingle();

    if (error || !itemData) {
      alert("⚠️ Data barang tidak ditemukan atau QR Code tidak valid!");
      closeModal("modalOut");
      return;
    }

    if (itemData.is_active === false) {
      alert("⚠️ Barang ini sudah berstatus OUT sebelumnya!");
      closeModal("modalOut");
      return;
    }

    const formatQty = itemData.qty.toLocaleString("id-ID");

    document.getElementById("outRowId").value = itemData.id;
    document.getElementById("outKodeArtikel").value = itemData.kode_artikel;
    document.getElementById("outNamaCustomer").value = `Batch: ${itemData.batch_number}`;
    document.getElementById("outBatchQty").value = `Qty: ${formatQty}`;
    document.getElementById("outPetugas").value = currentActiveUser.fullName || currentActiveUser.username;
    document.getElementById("outPreviewImg").src = itemData.foto_path || "https://via.placeholder.com/150";

    document.getElementById("formConfirmOut").style.display = "block";
  } catch (err) {
    alert("Gagal memuat data scan: " + err.message);
    closeModal("modalOut");
  }
}

async function handleSubmitBarangOut(e) {
  e.preventDefault();
  const rowId = document.getElementById("outRowId").value;
  const shiftOut = document.getElementById("outShift").value;
  const btnText = document.getElementById("btnSubmitOutText");
  const btnSpinner = document.getElementById("btnSubmitOutSpinner");
  const btnSubmit = document.getElementById("btnSubmitOut");

  btnText.innerText = "Memproses...";
  btnSpinner.style.display = "inline-block";
  btnSubmit.disabled = true;

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
      .eq("id", rowId);

    if (error) throw error;
    alert("✅ Barang berhasil diproses OUT!");
    closeModal("modalOut");
  } catch (err) {
    alert("Gagal memproses Barang OUT: " + err.message);
  } finally {
    btnText.innerText = "Proses Barang OUT";
    btnSpinner.style.display = "none";
    btnSubmit.disabled = false;
  }
}

// ---------------- Search ---------------- //
async function handleSearchExecute() {
  const keyword = document.getElementById("searchKeyword").value.trim().toUpperCase();
  const container = document.getElementById("searchResultsContainer");

  if (!keyword) {
    alert("Masukkan kode artikel terlebih dahulu!");
    return;
  }

  container.innerHTML = `<p style="text-align:center;"><i class="fa-solid fa-spinner fa-spin me-2"></i>Mencari data...</p>`;
  document.getElementById("searchSuggestionBox").style.display = "none";

  try {
    const { data: results, error } = await window.supabaseClient
      .schema("stg_public")
      .from("sisa_wrapping")
      .select("*")
      .ilike("kode_artikel", `%${keyword}%`)
      .eq("is_active", true)
      .order("created_at", { ascending: false });

    if (error) throw error;

    if (!results || results.length === 0) {
      container.innerHTML = `<p style="text-align: center; color: var(--danger-color); font-size: 0.82rem;">Tidak ada stok aktif ditemukan untuk kode artikel "${keyword}".</p>`;
      return;
    }

    let html = `<div style="font-size:0.85rem; font-weight:700; margin-bottom:10px; color:var(--dark-color);">Ditemukan ${results.length} Stok Aktif:</div>`;

    results.forEach((item, index) => {
      const tanggalFormat = formatTanggalIndo(item.tanggal_masuk);
      const formatQty = item.qty.toLocaleString("id-ID");
      
      html += `
        <div class="result-item-card">
          <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
            <span style="font-weight:700; color:var(--primary-color);">Stok #${index + 1} - ${item.kode_artikel}</span>
            <span style="font-size:0.75rem; color:var(--text-muted);">${tanggalFormat}</span>
          </div>
          <div style="display:flex; gap:12px; align-items:center;">
            <img src="${item.foto_path || 'https://via.placeholder.com/60'}" class="item-thumbnail" onclick="previewImage('${item.foto_path}')">
            <div style="font-size:0.78rem; line-height:1.4;">
              <div><strong>Batch:</strong> ${item.batch_number}</div>
              <div><strong>Qty:</strong> ${formatQty} | <strong>Shift:</strong> ${item.shift_in}</div>
              <div><strong>Petugas IN:</strong> ${item.petugas_in}</div>
            </div>
          </div>
        </div>
      `;
    });
    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = `<p style="text-align:center; color:var(--danger-color);">Gagal mencari data: ${err.message}</p>`;
  }
}

function previewImage(url) {
  if (!url) return;
  document.getElementById("fullImageTarget").src = url;
  openModal("modalImagePreview");
}