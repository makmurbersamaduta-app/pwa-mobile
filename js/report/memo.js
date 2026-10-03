// File: js/report/memo.js
// Hub Persetujuan Memo: list memo status=pending, modal detail+approval.

const ROLES_LIHAT_SEMUA = [1, 2, 4]; // Maintenance, Superadmin, Supervisor
const ROLE_KARU_STG = 8;

let currentActiveUser = null;
let selectedMemo = null; // menyimpan baris memo yang sedang dibuka di modal

document.addEventListener("DOMContentLoaded", async () => {
  // ============================================================
  // GUARD: wajib sesi valid + role yang diizinkan
  // ============================================================
  const sessionRaw = localStorage.getItem("pwa_mobile_session") || sessionStorage.getItem("pwa_mobile_session");
  if (!sessionRaw) {
    window.location.replace("../../login.html");
    return;
  }
  currentActiveUser = JSON.parse(sessionRaw);

  const rolesDiizinkan = [...ROLES_LIHAT_SEMUA, ROLE_KARU_STG];
  if (!rolesDiizinkan.includes(currentActiveUser.roleId)) {
    alert("Anda tidak memiliki akses ke halaman ini.");
    window.location.replace("../laporan.html");
    return;
  }

  await loadMemoList();

  document.getElementById("btnCloseMemoModal")?.addEventListener("click", closeMemoModal);
  document.getElementById("btnBatalMemo")?.addEventListener("click", closeMemoModal);
  document.getElementById("btnSetujuiMemo")?.addEventListener("click", handleSetujuiMemo);

  document.getElementById("memoJenisMemo")?.addEventListener("change", handleJenisMemoChange);
});

// ===================================================
// AMBIL DAFTAR MEMO STATUS = PENDING, SESUAI FILTER ROLE
// ===================================================
async function loadMemoList() {
  const listContainer = document.getElementById("memoList");

  let query = window.supabaseClient
    .schema("stg_public")
    .from("memos")
    .select("id, kode_memo, no_absen, tanggal, jam_kerja, shift_kerja, jenis_memo, jenis_pekerjaan, note_kerja, nip_karu, status")
    .ilike("status", "pending")
    .order("tanggal", { ascending: false });

  // Role 3 (KARU STG) hanya lihat memo milik timnya sendiri
  if (currentActiveUser.roleId === ROLE_KARU_STG) {
    query = query.eq("nip_karu", currentActiveUser.username);
  }
  // Role di ROLES_LIHAT_SEMUA tidak difilter -- lihat semua data pending

  const { data: memos, error } = await query;

  if (error) {
    console.error("[Memo] Gagal load data:", error);
    listContainer.innerHTML = `<div class="empty-state">Gagal memuat data memo.</div>`;
    return;
  }

  if (!memos || memos.length === 0) {
    listContainer.innerHTML = `<div class="empty-state">Tidak ada memo yang menunggu persetujuan.</div>`;
    return;
  }

  // Ambil nama karyawan untuk ditampilkan di list (supaya tidak query per-baris saat render)
  const noAbsenList = [...new Set(memos.map(m => m.no_absen))];
  const { data: employees } = await window.supabaseClient
    .schema("hrd")
    .from("employees")
    .select("nik_karyawan, nama")
    .in("nik_karyawan", noAbsenList);

  const namaMap = {};
  (employees || []).forEach(e => { namaMap[e.nik_karyawan] = e.nama; });

    listContainer.innerHTML = memos.map(memo => `
    <div class="memo-card" data-memo-id="${memo.id}">
      <div class="memo-card-top">
        <span class="memo-nama">${namaMap[memo.no_absen] || memo.no_absen}</span>
        <span class="memo-tanggal">${formatTanggalPendek(memo.tanggal)}</span>
      </div>
      <div class="memo-sub">${memo.jenis_memo || '-'} • ${memo.shift_kerja || '-'}</div>
    </div>
  `).join("");

  // Simpan data mentah di memori supaya tidak perlu query ulang saat kartu diklik
  window._memoListData = memos;

  listContainer.querySelectorAll(".memo-card").forEach(card => {
    card.addEventListener("click", () => openMemoModal(card.dataset.memoId));
  });
}

// ===================================================
// BUKA MODAL DETAIL -- ambil Nama Karyawan & Bagian via JOIN manual
// ===================================================
async function openMemoModal(memoId) {
  const memo = window._memoListData.find(m => m.id === memoId);
  if (!memo) return;
  selectedMemo = memo;

  // Nama Karyawan + id (dibutuhkan untuk lookup Bagian)
  const { data: empData } = await window.supabaseClient
    .schema("hrd")
    .from("employees")
    .select("id, nama")
    .eq("nik_karyawan", memo.no_absen)
    .maybeSingle();

  // Bagian -- lewat employee_assignments (bagian_id) -> tabel referensi nama bagian
  let bagianName = "-";
  if (empData?.id) {
    const { data: assignData } = await window.supabaseClient
      .schema("hrd")
      .from("employee_assignments")
      .select("bagian_id")
      .eq("employee_id", empData.id)
      .eq("is_active", true)
      .maybeSingle();

    if (assignData?.bagian_id) {
      const { data: bagianData } = await window.supabaseClient
        .from("bagians")
        .select("bagian_name")
        .eq("id", assignData.bagian_id)
        .maybeSingle();
      bagianName = bagianData?.bagian_name || "-";
    }
  }

  // Isi form
  document.getElementById("memoJenisMemo").value = memo.jenis_memo || "";
  document.getElementById("memoNoAbsen").value = memo.no_absen || "-";
  document.getElementById("memoNamaKaryawan").value = empData?.nama || "-";
  document.getElementById("memoBagian").value = bagianName;
  document.getElementById("memoTanggal").value = memo.tanggal || "-";
  document.getElementById("memoJamKerja").value = memo.jam_kerja ?? "";
  document.getElementById("memoShift").value = memo.shift_kerja || "-";
  document.getElementById("memoJenisPekerjaan").value = memo.jenis_pekerjaan || "";
  document.getElementById("memoNoteKerja").value = memo.note_kerja || "";

  applyJenisMemoRule(); // terapkan rule auto-readonly sesuai jenis_memo saat ini

  document.getElementById("memoModal").classList.add("show");
}

// ===================================================
// FORMAT TANGGAL: "2026-10-01" -> "01 Okt 26"
// ===================================================
function formatTanggalPendek(tanggalString) {
  if (!tanggalString) return "-";

  const bulanPendek = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
  const d = new Date(tanggalString + "T00:00:00"); // paksa dibaca sebagai tanggal lokal, bukan UTC

  const tanggal = String(d.getDate()).padStart(2, "0");
  const bulan = bulanPendek[d.getMonth()];
  const tahun = String(d.getFullYear()).slice(-2);

  return `${tanggal} ${bulan} ${tahun}`;
}

function closeMemoModal() {
  document.getElementById("memoModal").classList.remove("show");
  selectedMemo = null;
}

// ===================================================
// RULE: Jenis Memo = "Tidak Ditagihkan" -> Jenis Pekerjaan otomatis
// terkunci ke "Tidak Ditagihkan" (readonly/disabled)
// ===================================================
function handleJenisMemoChange() {
  applyJenisMemoRule();
}

function applyJenisMemoRule() {
  const jenisMemo = document.getElementById("memoJenisMemo").value;
  const jenisPekerjaanSelect = document.getElementById("memoJenisPekerjaan");

  if (jenisMemo === "Tidak Ditagihkan") {
    jenisPekerjaanSelect.value = "Tidak Ditagihkan";
    jenisPekerjaanSelect.disabled = true;
  } else {
    jenisPekerjaanSelect.disabled = false;
    // Kalau sebelumnya terkunci ke "Tidak Ditagihkan" lalu user ganti jenis memo,
    // kosongkan lagi -- JANGAN diisi tebakan apapun, biarkan KARU pilih ulang
    if (jenisPekerjaanSelect.value === "Tidak Ditagihkan") {
      jenisPekerjaanSelect.value = "";
    }
  }
}

// ===================================================
// SUBMIT SETUJUI -- update status + field yang diedit
// ===================================================
async function handleSetujuiMemo() {
  if (!selectedMemo) return;

  // Validasi wajib isi -- semua field yang bisa diedit KARU, KECUALI note_kerja
  const jenisMemoValue = document.getElementById("memoJenisMemo").value;
  const jamKerjaValue = document.getElementById("memoJamKerja").value;
  const jenisPekerjaanValue = document.getElementById("memoJenisPekerjaan").value;

  if (!jenisMemoValue) {
    alert("Jenis Memo wajib dipilih.");
    return;
  }
  if (jamKerjaValue === "" || jamKerjaValue === null) {
    alert("Jam Kerja wajib diisi.");
    return;
  }
  if (!jenisPekerjaanValue) {
    alert("Jenis Pekerjaan wajib dipilih.");
    return;
  }

  const btnSetujui = document.getElementById("btnSetujuiMemo");
  const btnSetujuiText = document.getElementById("btnSetujuiText");
  const btnSetujuiSpinner = document.getElementById("btnSetujuiSpinner");

  const payload = {
    status: "Disetujui",
    jenis_memo: document.getElementById("memoJenisMemo").value,
    jam_kerja: Number(document.getElementById("memoJamKerja").value) || null,
    jenis_pekerjaan: document.getElementById("memoJenisPekerjaan").value,
    note_kerja: document.getElementById("memoNoteKerja").value.trim()
  };

  btnSetujuiText.innerText = "Memproses...";
  btnSetujuiSpinner.style.display = "inline-block";
  btnSetujui.disabled = true;

  try {
    const { error } = await window.supabaseClient
      .schema("stg_public")
      .from("memos")
      .update(payload)
      .eq("id", selectedMemo.id)
      .eq("status", "pending"); // jaga-jaga: cegah approve ganda kalau sudah diproses orang lain

    if (error) throw new Error(error.message);

    alert("✅ Memo berhasil disetujui.");
    closeMemoModal();
    await loadMemoList(); // refresh daftar, baris yang baru disetujui otomatis hilang dari list

  } catch (err) {
    alert("Gagal menyetujui memo: " + err.message);
  } finally {
    btnSetujuiText.innerText = "Setujui";
    btnSetujuiSpinner.style.display = "none";
    btnSetujui.disabled = false;
  }
}