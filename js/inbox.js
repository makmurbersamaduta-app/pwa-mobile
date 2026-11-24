// File: js/inbox.js
// Inbox PWA: tab Notifikasi (placeholder) dan tab Persetujuan.
//
// Tab Persetujuan menampilkan pengajuan yang menunggu keputusan Anda untuk 5 jenis
// (request_type di public.approval_requests):
//   permintaan_barang, koreksi_absensi, ubah_jadwal, lembur, ijin (cuti)
//
// Data dibaca dan ditulis HANYA lewat fungsi database:
//   approval_inbox_list : daftar pengajuan yang menunggu keputusan Anda
//   approval_detail     : isi lengkap satu pengajuan (bentuknya berbeda per request_type)
//   approval_decide     : Disetujui / Koreksi / Ditolak
// Siapa yang boleh memutuskan dicek di database, bukan di file ini.
// Lampiran (bucket "hrd") dibuka lewat signed URL; izin bacanya diatur kebijakan storage
// hrd_pengajuan_baca_approver (lihat pengajuan.sql).
//
// Seluruh isi dibungkus (function () { ... })() supaya nama variabel di sini
// tidak bentrok dengan file lain (auth.js, supabase.js).

(function () {
  "use strict";

  // ===================================================
  // KELOMPOK 1: PENGATURAN
  // Fungsi: koneksi Supabase, nama jenis pengajuan, dan nilai tetap.
  // ===================================================
  const supabaseClient = window.supabaseClient;
  const SESSION_KEY = "pwa_mobile_session";   // sesi login PWA
  const LAMPIRAN_BUCKET = "hrd";              // bucket lampiran pengajuan HRD

  // request_type -> judul. Harus sama dengan data-type pada baris di inbox.html.
  const TIPE = {
    permintaan_barang: "Permintaan Barang",
    koreksi_absensi: "Koreksi Absensi",
    ubah_jadwal: "Ubah Jadwal",
    lembur: "Lembur",
    ijin: "Ijin (Cuti)"
  };

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
    currentKode: "",  // teks pendek pengajuan yang sedang dibuka (untuk pesan)
    action: null,     // aksi yang sedang dikonfirmasi
    busy: false,      // true saat menunggu jawaban database
    attachReq: 0      // penanda pemuatan lampiran terbaru
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

  // "2026-10-05" -> "05 Okt 2026"
  function formatTanggalPendek(s) {
    if (!s) return "-";
    const [y, m, d] = String(s).slice(0, 10).split("-").map(Number);
    return `${pad2(d)} ${BULAN[(m || 1) - 1]} ${y}`;
  }

  // "2026-11-19 08:00" -> "19 Nov 2026, 08:00" (waktu sudah dalam jam setempat karyawan)
  function formatWaktuStr(s) {
    if (!s) return "-";
    return `${formatTanggalPendek(s)}, ${String(s).slice(11, 16)}`;
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

  // "Pagi (07:00 - 15:00)", atau nama saja untuk shift libur (tanpa jam)
  function shiftTxt(s) {
    if (!s) return "Tidak ada jadwal";
    return s.jam_masuk ? `${s.nama_shift || s.nama} (${s.jam_masuk} - ${s.jam_pulang})` : String(s.nama_shift || s.nama || s.kode_shift || "-");
  }

  function pemohonTxt(d) {
    return d.pemohon_nama ? `${d.pemohon_nama}${d.pemohon_nik ? " (" + d.pemohon_nik + ")" : ""}` : (d.pemohon_nik || "-");
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
  // di tiap baris jenis dan isi daftar tiap jenis.
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
    let total = 0;

    Object.keys(TIPE).forEach((tipe) => {
      const rows = state.pending.filter(p => p.request_type === tipe);
      total += rows.length;

      const group = document.querySelector(`.ap-group[data-type="${tipe}"]`);
      if (!group) return;

      // Jumlah di baris jenis
      const badge = group.querySelector(".ap-count");
      badge.textContent = rows.length;
      badge.hidden = rows.length === 0;

      // Isi daftar
      const list = group.querySelector(".ap-list");
      if (rows.length === 0) {
        list.innerHTML = `<div class="ap-empty">Tidak ada pengajuan yang menunggu persetujuan.</div>`;
        return;
      }
      list.innerHTML = rows.map(p => `
        <button class="ap-item" type="button" data-id="${esc(p.approval_id)}" data-type="${esc(p.request_type)}" data-kode="${esc(p.ref_label || "")}">
          <div class="ap-item-main">
            <div class="ap-item-title">${esc(p.ref_label || "-")}</div>
            <div class="ap-item-sub">${esc(p.requester_nama || "-")} &bull; ${esc(formatWaktu(p.diajukan_at))}</div>
          </div>
          <i class="fa-solid fa-chevron-right ap-chevron"></i>
        </button>`).join("");
    });

    // Jumlah di tab
    const tabBadge = $("badgePersetujuan");
    tabBadge.textContent = total;
    tabBadge.style.display = total > 0 ? "inline-block" : "none";
  }

  // ===================================================
  // KELOMPOK 5: MODAL DETAIL PENGAJUAN
  // Fungsi: membuka modal, mengambil isi lengkap dari database (approval_detail),
  // lalu menggambarnya sesuai request_type. Tiap jenis punya "pembangun" sendiri
  // (BUILDERS) yang mengembalikan:
  //   fields : daftar [label, nilai] untuk kotak info ringkas
  //   extra  : potongan HTML khusus jenis itu (tabel barang, perbandingan jam, dst)
  // Jenis baru cukup menambah satu pembangun di sini + satu baris di inbox.html.
  // ===================================================
  function fotoHtml(url) {
    // Hanya alamat http/https yang ditampilkan (menghindari alamat berbahaya)
    if (!url || !/^https?:\/\//i.test(String(url))) return `<span class="ap-dash">-</span>`;
    return `<a href="${esc(url)}" target="_blank" rel="noopener"><img class="ap-thumb" src="${esc(url)}" alt="Foto barang" loading="lazy"></a>`;
  }

  const DASH = `<span class="ap-dash">-</span>`;

  // Durasi "02:00" (+ istirahat "00:30") untuk lembur
  function durasiTxt(ot, brk) {
    if (!ot) return "-";
    return brk ? `${ot} (istirahat ${brk})` : ot;
  }

  const BUILDERS = {
    permintaan_barang(d) {
      const items = Array.isArray(d.items) ? d.items : [];
      const rows = items.length === 0
        ? `<tr><td colspan="5" class="ap-dash" style="text-align:center">Tidak ada barang.</td></tr>`
        : items.map(it => `
          <tr>
            <td>${esc(it.kode_barang)}</td>
            <td>${it.nama_barang ? esc(it.nama_barang) : DASH}</td>
            <td class="num">${esc(formatQty(it.qty))}</td>
            <td>${it.satuan ? esc(it.satuan) : DASH}</td>
            <td>${fotoHtml(it.photo_path)}</td>
          </tr>`).join("");
      return {
        kode: d.kode_batch,
        fields: [
          ["Kode Batch", d.kode_batch || "-"],
          ["Tanggal", formatTanggal(d.tanggal)],
          ["Periode Permintaan", d.periode_permintaan || "-"],
          ["Pemohon", pemohonTxt(d)]
        ],
        extra: `
          <div class="ap-table-wrap">
            <table class="ap-table">
              <thead><tr><th>Kode Barang</th><th>Nama Barang</th><th class="num">Qty</th><th>Satuan</th><th>Foto Barang</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>`
      };
    },

    // Approver melihat Clock In DAN Clock Out; yang diproses hanya yang berstatus "Diajukan"
    koreksi_absensi(d) {
      const baris = (nama, x) => {
        const diajukan = x && x.diajukan;
        return `
          <tr class="${diajukan ? "ap-diff" : "ap-muted"}">
            <td>${nama}${diajukan ? '<span class="ap-tag">Diajukan</span>' : ""}</td>
            <td>${x && x.saat_ini ? esc(formatWaktuStr(x.saat_ini)) : DASH}</td>
            <td>${diajukan ? esc(formatWaktuStr(diajukan)) : DASH}</td>
          </tr>`;
      };
      return {
        kode: "Koreksi absensi " + formatTanggalPendek(d.tanggal_kerja),
        fields: [
          ["Pemohon", pemohonTxt(d)],
          ["Tanggal Kerja", formatTanggal(d.tanggal_kerja)],
          ["Shift", shiftTxt(d.shift)],
          ["Alasan", d.keterangan || "-"]
        ],
        extra: `
          <div class="ap-section-title">Waktu absen</div>
          <div class="ap-table-wrap">
            <table class="ap-table" style="min-width:300px">
              <thead><tr><th>Jenis</th><th>Saat ini</th><th>Diajukan</th></tr></thead>
              <tbody>${baris("Clock In", d.clock_in)}${baris("Clock Out", d.clock_out)}</tbody>
            </table>
          </div>
          <div class="ap-note">Yang diproses hanya baris bertanda Diajukan. Baris lain hanya sebagai pembanding. Keputusan berlaku untuk semua baris yang diajukan sekaligus.</div>`
      };
    },

    ubah_jadwal(d) {
      return {
        kode: "Ubah shift " + formatTanggalPendek(d.tanggal),
        fields: [
          ["Pemohon", pemohonTxt(d)],
          ["Tanggal", formatTanggal(d.tanggal)],
          ["Shift Saat Ini", shiftTxt(d.shift_saat_ini)],
          ["Shift Baru", shiftTxt(d.shift_baru)],
          ["Alasan", d.keterangan || "-"]
        ],
        extra: ""
      };
    },

    lembur(d) {
      const fields = [
        ["Pemohon", pemohonTxt(d)],
        ["Tanggal", formatTanggal(d.tanggal)],
        ["Shift", shiftTxt(d.shift)],
        ["Jenis Lembur", d.type_ot || "-"],
        ["Sebelum Shift", durasiTxt(d.ot_before, d.break_before)],
        ["Setelah Shift", durasiTxt(d.ot_after, d.break_after)]
      ];
      if (d.menggantikan) fields.push(["Menggantikan", `${d.menggantikan.nama} (${d.menggantikan.nik})`]);
      if (d.mitra) fields.push(["Mitra", d.mitra]);
      if (d.area) fields.push(["Area", d.area]);
      fields.push(["Keterangan", d.keterangan || "-"]);
      return { kode: "Lembur " + formatTanggalPendek(d.tanggal), fields, extra: "" };
    },

    ijin(d) {
      const fields = [
        ["Pemohon", pemohonTxt(d)],
        ["Jenis", d.jenis || "-"],
        ["Tanggal", d.start_date === d.end_date
          ? formatTanggalPendek(d.start_date)
          : `${formatTanggalPendek(d.start_date)} - ${formatTanggalPendek(d.end_date)}`],
        ["Jumlah", `${d.jumlah_hari} hari`]
      ];
      if (d.saldo_tipe === "limit" && d.saldo_jumlah_hari != null) {
        fields.push(["Jatah per Tahun", `${formatQty(d.saldo_jumlah_hari)} hari`]);
        fields.push(["Terpakai Tahun Ini", `${formatQty(d.terpakai_tahun_ini)} hari`]);
      }
      fields.push(["Alasan", d.keterangan || "-"]);
      return { kode: (d.jenis || "Ijin") + " " + formatTanggalPendek(d.start_date), fields, extra: "" };
    }
  };

  // Lampiran dibuka lewat signed URL (bucket private)
  async function loadAttachment(path) {
    const my = ++state.attachReq;
    const box = $("apAttach");
    box.innerHTML = `<div class="ap-section-title">Lampiran</div><div class="ap-dash">Memuat lampiran...</div>`;
    try {
      const { data, error } = await supabaseClient.storage.from(LAMPIRAN_BUCKET).createSignedUrl(path, 3600);
      if (my !== state.attachReq) return;
      if (error || !data || !data.signedUrl) throw (error || new Error("alamat lampiran tidak tersedia"));
      const url = data.signedUrl;
      const isPdf = /\.pdf$/i.test(path);
      box.innerHTML = `<div class="ap-section-title">Lampiran</div>` + (isPdf
        ? `<a class="ap-attach-link" href="${esc(url)}" target="_blank" rel="noopener"><i class="fa-regular fa-file-pdf"></i> Buka lampiran (PDF)</a>`
        : `<a href="${esc(url)}" target="_blank" rel="noopener"><img class="ap-attach-img" src="${esc(url)}" alt="Lampiran"></a>`);
    } catch (err) {
      if (my !== state.attachReq) return;
      box.innerHTML = `<div class="ap-section-title">Lampiran</div><div class="ap-modal-msg">Lampiran gagal dimuat: ${esc(err && err.message ? err.message : err)}</div>`;
    }
  }

  // Mengembalikan modal ke keadaan awal (sebelum data tiba)
  function resetModal() {
    $("apModalLoading").hidden = false;
    $("apModalLoading").textContent = "Memuat data...";
    $("apModalContent").hidden = true;
    $("apInfo").innerHTML = "";
    $("apExtra").innerHTML = "";
    $("apAttach").innerHTML = "";
    $("apFootMain").hidden = true;
    $("apFootConfirm").hidden = true;
    $("apNoteWrap").hidden = true;
    $("apConfirmText").hidden = true;
    $("apNote").value = "";
    setModalMsg("", "");
    state.action = null;
    state.attachReq++;
  }

  async function openModal(id, kode, tipe) {
    state.currentId = id;
    state.currentKode = kode || "";
    resetModal();
    $("apModalTitle").textContent = TIPE[tipe] || "Pengajuan";
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
    const build = BUILDERS[d.request_type];
    if (!build) {
      $("apModalLoading").textContent = `Jenis pengajuan "${d.request_type}" belum didukung di aplikasi ini.`;
      return;
    }
    const out = build(d);
    state.currentKode = out.kode || state.currentKode;
    $("apModalTitle").textContent = TIPE[d.request_type] || "Pengajuan";
    $("apInfo").innerHTML = out.fields.map(([label, nilai]) =>
      `<div><dt>${esc(label)}</dt><dd>${esc(nilai)}</dd></div>`).join("");
    $("apExtra").innerHTML = out.extra || "";
    if (d.attachment) loadAttachment(d.attachment);

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
    state.attachReq++;
  }

  // ===================================================
  // KELOMPOK 6: KEPUTUSAN (Disetujui / Koreksi / Tolak)
  // Fungsi: dua langkah supaya tidak terpencet tanpa sengaja.
  //   Langkah 1: pilih tombol -> tampil konfirmasi (dan kolom alasan
  //              untuk Koreksi dan Tolak, wajib diisi).
  //   Langkah 2: "Kirim" -> database memutuskan (approval_decide).
  // ===================================================
  const CONFIRM = {
    Disetujui: { teks: "Setujui pengajuan ini?", tombol: "Ya, Setujui", kelas: "is-approve", alasan: false },
    Koreksi:   { teks: "Pemohon akan diminta memperbaiki pengajuan ini.", tombol: "Kirim Koreksi", kelas: "is-correct", alasan: true },
    Ditolak:   { teks: "Pengajuan ini akan ditolak dan tidak bisa diubah pemohon.", tombol: "Ya, Tolak", kelas: "is-reject", alasan: true }
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
    showToast(`Pengajuan ${kode} ${HASIL_LABEL[action] || "diproses"}.`);
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

    // Baris jenis pengajuan: buka/tutup daftar
    document.querySelectorAll(".ap-group").forEach(group => {
      group.querySelector(".ap-group-head").addEventListener("click", () => {
        const list = group.querySelector(".ap-list");
        const open = !group.classList.contains("open");
        group.classList.toggle("open", open);
        list.hidden = !open;
      });
    });

    // Klik satu pengajuan di daftar mana pun -> buka modal
    document.querySelectorAll(".ap-group .ap-list").forEach(list => {
      list.addEventListener("click", (e) => {
        const item = e.target.closest(".ap-item");
        if (item) openModal(item.dataset.id, item.dataset.kode, item.dataset.type);
      });
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