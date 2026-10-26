// File: js/inbox.js
// Inbox PWA: tab Notifikasi (placeholder) dan tab Persetujuan.
//
// Tab Persetujuan saat ini aktif untuk jenis "Permintaan Barang".
// Jenis lain (Overtime, Time Off, Change Shift, Attendance) baru berupa baris
// "Segera"; aktivasinya menyusul satu per satu.
//
// Data dibaca dan ditulis HANYA lewat fungsi database (Paket A dan C):
//   approval_inbox_list : daftar pengajuan yang menunggu keputusan Anda
//   approval_detail     : isi lengkap satu pengajuan (untuk modal)
//   approval_decide     : Disetujui / Koreksi / Ditolak
// Siapa yang boleh memutuskan dicek di database, bukan di file ini.
//
// Seluruh isi dibungkus (function () { ... })() supaya nama variabel di sini
// tidak bentrok dengan file lain (auth.js, supabase.js).

(function () {
  "use strict";

  // ===================================================
  // KELOMPOK 1: PENGATURAN
  // Fungsi: koneksi Supabase dan nilai tetap.
  // ===================================================
  const supabaseClient = window.supabaseClient;
  const SESSION_KEY = "pwa_mobile_session";   // sesi login PWA

  // Label hasil keputusan untuk pesan singkat (toast)
  const HASIL_LABEL = {
    Disetujui: "disetujui",
    Koreksi: "dikembalikan untuk dikoreksi",
    Ditolak: "ditolak"
  };

  // Status layar saat ini
  const state = {
    pending: [],      // daftar pengajuan menunggu dari database
    currentId: null,  // id pengajuan yang sedang dibuka di modal
    currentKode: "",  // kode batch yang sedang dibuka (untuk pesan)
    action: null,     // aksi yang sedang dikonfirmasi
    busy: false       // true saat menunggu jawaban database
  };

  // ===================================================
  // KELOMPOK 2: FUNGSI BANTU
  // Fungsi: pengaman teks HTML, format tanggal/angka, pesan singkat.
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

  function pad2(n) { return String(n).padStart(2, "0"); }

  // "2026-10-05" -> "Senin, 05 Okt 2026" (untuk kolom tanggal tanpa jam)
  function formatTanggal(s) {
    if (!s) return "-";
    const [y, m, d] = String(s).slice(0, 10).split("-").map(Number);
    const dt = new Date(y, (m || 1) - 1, d || 1);
    if (isNaN(dt)) return "-";
    return `${HARI[dt.getDay()]}, ${pad2(dt.getDate())} ${BULAN[dt.getMonth()]} ${dt.getFullYear()}`;
  }

  // "2026-10-05T08:30:00+00:00" -> "05 Okt 2026, 15:30" (jam sesuai perangkat)
  function formatWaktu(s) {
    if (!s) return "-";
    const dt = new Date(s);
    if (isNaN(dt)) return "-";
    return `${pad2(dt.getDate())} ${BULAN[dt.getMonth()]} ${dt.getFullYear()}, ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
  }

  function formatQty(n) {
    return new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 }).format(Number(n) || 0);
  }

  function showToast(text) {
    const t = $("apToast");
    t.textContent = text;
    t.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { t.hidden = true; }, 3500);
  }

  // Pesan di atas daftar (error umum). Teks kosong = sembunyikan.
  function setMsg(text) {
    const el = $("apMsg");
    el.textContent = text || "";
    el.hidden = !text;
  }

  // Pesan di dalam modal. type "info" = biru, selain itu merah.
  function setModalMsg(text, type) {
    const el = $("apModalMsg");
    el.textContent = text || "";
    el.className = "ap-modal-msg" + (type === "info" ? " info" : "");
    el.hidden = !text;
  }

  // ===================================================
  // KELOMPOK 3: TAB (Notifikasi / Persetujuan)
  // ===================================================
  function switchTab(tabName) {
    document.querySelectorAll(".tab-item").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));

    document.querySelector(`.tab-item[data-tab="${tabName}"]`).classList.add("active");
    $(`tab${tabName.charAt(0).toUpperCase() + tabName.slice(1)}`).classList.add("active");

    if (tabName === "persetujuan") loadPending();
  }

  // ===================================================
  // KELOMPOK 4: DAFTAR PERSETUJUAN
  // Fungsi: mengambil pengajuan yang menunggu Anda, lalu menggambar jumlahnya
  // di tiap baris jenis dan isi daftar "Permintaan Barang".
  // ===================================================
  async function loadPending() {
    setMsg("");
    if (!supabaseClient) {
      setMsg("Koneksi ke server belum siap. Muat ulang halaman ini.");
      return;
    }

    // Persetujuan butuh login yang dikenali server. Jika belum, hentikan dengan pesan jelas.
    const { data: sess } = await supabaseClient.auth.getSession();
    if (!sess || !sess.session) {
      state.pending = [];
      renderGroups();
      setMsg("Sesi login belum terhubung ke server persetujuan. Keluar lalu masuk kembali. Jika pesan ini tetap muncul, hubungi admin.");
      return;
    }

    const { data, error } = await supabaseClient.rpc("approval_inbox_list");
    if (error) {
      setMsg("Gagal memuat persetujuan: " + error.message);
      return;
    }
    state.pending = data || [];
    renderGroups();
  }

  function renderGroups() {
    const barang = state.pending.filter(p => p.request_type === "permintaan_barang");

    // Jumlah di baris jenis dan di tab
    const group = document.querySelector('.ap-group[data-type="permintaan_barang"]');
    const badge = group.querySelector(".ap-count");
    badge.textContent = barang.length;
    badge.hidden = barang.length === 0;

    const tabBadge = $("badgePersetujuan");
    tabBadge.textContent = barang.length;
    tabBadge.style.display = barang.length > 0 ? "inline-block" : "none";

    // Isi daftar
    const list = group.querySelector(".ap-list");
    if (barang.length === 0) {
      list.innerHTML = `<div class="ap-empty">Tidak ada permintaan yang menunggu persetujuan.</div>`;
      return;
    }
    list.innerHTML = barang.map(p => `
      <button class="ap-item" type="button" data-id="${esc(p.approval_id)}" data-kode="${esc(p.ref_label || "")}">
        <div class="ap-item-main">
          <div class="ap-item-title">${esc(p.ref_label || "-")}</div>
          <div class="ap-item-sub">${esc(p.requester_nama || "-")} &bull; ${esc(formatWaktu(p.diajukan_at))}</div>
        </div>
        <i class="fa-solid fa-chevron-right ap-chevron"></i>
      </button>`).join("");
  }

  // ===================================================
  // KELOMPOK 5: MODAL DETAIL PENGAJUAN
  // Fungsi: membuka modal, mengambil isi lengkap dari database, dan
  // menggambar kode batch, tanggal, periode, dan tabel barang.
  // ===================================================
  function fotoHtml(url) {
    // Hanya alamat http/https yang ditampilkan (menghindari alamat berbahaya)
    if (!url || !/^https?:\/\//i.test(String(url))) return `<span class="ap-dash">-</span>`;
    return `<a href="${esc(url)}" target="_blank" rel="noopener"><img class="ap-thumb" src="${esc(url)}" alt="Foto barang" loading="lazy"></a>`;
  }

  // Mengembalikan modal ke keadaan awal (sebelum data tiba)
  function resetModal() {
    $("apModalLoading").hidden = false;
    $("apModalLoading").textContent = "Memuat data...";
    $("apModalContent").hidden = true;
    $("apFootMain").hidden = true;
    $("apFootConfirm").hidden = true;
    $("apNoteWrap").hidden = true;
    $("apConfirmText").hidden = true;
    $("apNote").value = "";
    setModalMsg("", "");
    state.action = null;
  }

  async function openModal(id, kode) {
    state.currentId = id;
    state.currentKode = kode || "";
    resetModal();
    $("apModal").hidden = false;
    document.body.style.overflow = "hidden";

    const { data, error } = await supabaseClient.rpc("approval_detail", { p_approval_id: id });
    if (state.currentId !== id) return;   // modal sudah ditutup / ganti pengajuan

    if (error) {
      $("apModalLoading").textContent = "Gagal memuat: " + error.message;
      return;
    }
    fillDetail(data);
  }

  function fillDetail(d) {
    state.currentKode = d.kode_batch || state.currentKode;
    $("apKode").textContent = d.kode_batch || "-";
    $("apTanggal").textContent = formatTanggal(d.tanggal);
    $("apPeriode").textContent = d.periode_permintaan || "-";
    $("apPemohon").textContent = d.pemohon_nama
      ? `${d.pemohon_nama}${d.pemohon_nik ? " (" + d.pemohon_nik + ")" : ""}`
      : (d.pemohon_nik || "-");

    const dash = `<span class="ap-dash">-</span>`;
    const items = Array.isArray(d.items) ? d.items : [];
    $("apItems").innerHTML = items.length === 0
      ? `<tr><td colspan="5" class="ap-dash" style="text-align:center">Tidak ada barang.</td></tr>`
      : items.map(it => `
        <tr>
          <td>${esc(it.kode_barang)}</td>
          <td>${it.nama_barang ? esc(it.nama_barang) : dash}</td>
          <td class="num">${esc(formatQty(it.qty))}</td>
          <td>${it.satuan ? esc(it.satuan) : dash}</td>
          <td>${fotoHtml(it.photo_path)}</td>
        </tr>`).join("");

    $("apModalLoading").hidden = true;
    $("apModalContent").hidden = false;

    if (d.status === "Diajukan") {
      $("apFootMain").hidden = false;
    } else {
      setModalMsg(`Pengajuan ini sudah diputuskan (status: ${d.status}).`, "info");
    }
  }

  function closeModal() {
    if (state.busy) return;
    $("apModal").hidden = true;
    document.body.style.overflow = "";
    state.currentId = null;
    state.action = null;
  }

  // ===================================================
  // KELOMPOK 6: KEPUTUSAN (Disetujui / Koreksi / Tolak)
  // Fungsi: dua langkah supaya tidak terpencet tanpa sengaja.
  //   Langkah 1: pilih tombol -> tampil konfirmasi (dan kolom alasan
  //              untuk Koreksi dan Tolak, wajib diisi).
  //   Langkah 2: "Kirim" -> database memutuskan (approval_decide).
  // ===================================================
  const CONFIRM = {
    Disetujui: { teks: "Setujui permintaan ini?", tombol: "Ya, Setujui", kelas: "is-approve", alasan: false },
    Koreksi:   { teks: "Pemohon akan diminta memperbaiki permintaan ini.", tombol: "Kirim Koreksi", kelas: "is-correct", alasan: true },
    Ditolak:   { teks: "Permintaan ini akan ditolak dan tidak bisa diubah pemohon.", tombol: "Ya, Tolak", kelas: "is-reject", alasan: true }
  };

  function startConfirm(action) {
    const c = CONFIRM[action];
    if (!c) return;
    state.action = action;
    setModalMsg("", "");

    $("apConfirmText").textContent = c.teks;
    $("apConfirmText").hidden = false;
    $("apNoteWrap").hidden = !c.alasan;

    const btn = $("apBtnConfirm");
    btn.textContent = c.tombol;
    btn.className = "ap-btn ap-btn-confirm " + c.kelas;

    $("apFootMain").hidden = true;
    $("apFootConfirm").hidden = false;
    if (c.alasan) $("apNote").focus();
  }

  function backToMain() {
    if (state.busy) return;
    state.action = null;
    $("apConfirmText").hidden = true;
    $("apNoteWrap").hidden = true;
    $("apFootConfirm").hidden = true;
    $("apFootMain").hidden = false;
    setModalMsg("", "");
  }

  function setBusy(busy) {
    state.busy = busy;
    document.querySelectorAll("#apModal .ap-btn").forEach(b => { b.disabled = busy; });
  }

  async function submitDecision() {
    if (state.busy || !state.action || !state.currentId) return;
    const action = state.action;
    const id = state.currentId;
    const kode = state.currentKode;
    const note = $("apNote").value.trim();

    if (CONFIRM[action].alasan && !note) {
      setModalMsg("Alasan wajib diisi.", "");
      $("apNote").focus();
      return;
    }

    setBusy(true);
    setModalMsg("", "");
    const { error } = await supabaseClient.rpc("approval_decide", {
      p_approval_id: id,
      p_action: action,
      p_note: note || null
    });
    setBusy(false);

    if (error) {
      setModalMsg(error.message, "");
      // Jika sudah diputuskan orang lain, sembunyikan tombol dan segarkan daftar
      if (/sudah diputuskan/i.test(error.message)) {
        $("apFootConfirm").hidden = true;
        $("apFootMain").hidden = true;
        loadPending();
      }
      return;
    }

    closeModal();
    showToast(`Permintaan ${kode} ${HASIL_LABEL[action] || "diproses"}.`);
    loadPending();
  }

  // ===================================================
  // KELOMPOK 7: PEMASANGAN KEJADIAN (EVENT)
  // Fungsi: menghubungkan klik tombol/baris ke fungsi di atas.
  // ===================================================
  document.addEventListener("DOMContentLoaded", () => {
    const sessionRaw = localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY);
    if (!sessionRaw) {
      window.location.replace("../login.html");
      return;
    }

    // Tab
    document.querySelectorAll(".tab-item").forEach(tab => {
      tab.addEventListener("click", () => switchTab(tab.dataset.tab));
    });

    // Baris jenis pengajuan: buka/tutup daftar; jenis yang belum aktif memberi pesan
    document.querySelectorAll(".ap-group").forEach(group => {
      group.querySelector(".ap-group-head").addEventListener("click", () => {
        if (group.classList.contains("is-soon")) {
          showToast("Belum tersedia. Menyusul setelah Permintaan Barang.");
          return;
        }
        const list = group.querySelector(".ap-list");
        const open = !group.classList.contains("open");
        group.classList.toggle("open", open);
        list.hidden = !open;
      });
    });

    // Klik satu pengajuan di daftar -> buka modal
    document.querySelector('.ap-group[data-type="permintaan_barang"] .ap-list')
      .addEventListener("click", (e) => {
        const item = e.target.closest(".ap-item");
        if (item) openModal(item.dataset.id, item.dataset.kode);
      });

    // Modal: tutup, tombol keputusan, konfirmasi
    $("apModal").addEventListener("click", (e) => {
      if (e.target.closest("[data-close]")) closeModal();
    });
    document.querySelectorAll("#apFootMain [data-action]").forEach(btn => {
      btn.addEventListener("click", () => startConfirm(btn.dataset.action));
    });
    $("apBtnBack").addEventListener("click", backToMain);
    $("apBtnConfirm").addEventListener("click", submitDecision);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("apModal").hidden) closeModal();
    });

    // Segarkan saat halaman kembali dibuka (misalnya dari aplikasi lain)
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && $("tabPersetujuan").classList.contains("active")) {
        loadPending();
      }
    });

    // Muat jumlah persetujuan di awal supaya badge tab langsung terisi
    loadPending();
  });
})();