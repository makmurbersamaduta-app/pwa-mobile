// ===================================================================
// FILE: js/organization-data.js
// DATA "STRUKTUR ORGANISASI" DMB ERP  (hanya DATA, tanpa logika)
// ===================================================================
//
// ---------- PENJELASAN (untuk Claude di chat lain) ----------
// Jika pengguna menyebut "struktur organisasi", "penanggung jawab",
// "eskalasi jabatan", atau "organization.js / ORG_DATA", yang dimaksud
// adalah file ini + js/organization.js (helper-nya).
//
// ATURAN BISNIS:
// 1. Hierarki dibaca dari ATAS ke BAWAH. Angka `level` KECIL = jabatan LEBIH TINGGI.
//    Level hanya bisa dibandingkan DI DALAM satu departemen.
// 2. `jabatan_id` = kolom id pada tabel `jabatans` di Supabase.
//    ID yang sama (mis. 3 = Manager) muncul di banyak departemen,
//    jadi identitas posisi = (departemen + jabatan_id), BUKAN jabatan_id saja.
// 3. Direktur (1) dan General Manager (2) level PERUSAHAAN, tidak
//    milik departemen mana pun. Disimpan di `company`.
// 4. Jabatan dengan `level` sama = sejajar (contoh: Cleaner & Gondola).
// 5. ATURAN ESKALASI: tidak semua departemen lengkap. Penanggung jawab
//    seorang karyawan = jabatan terdekat di ATASNYA yang MASIH ADA
//    karyawan aktifnya. Jika satu level kosong, naik ke level berikutnya.
//    Jika seluruh level departemen kosong, naik ke General Manager (2),
//    lalu Direktur (1).
//    Contoh: Departemen Security tidak punya Manager -> penanggung jawab
//    Head Supervisor = General Manager.
// 6. "Ada/kosong" TIDAK disimpan di sini. Itu data dinamis yang dicek
//    ke hrd.employee_assignments saat dijalankan (lihat organization.js).
//
// ASUMSI URUTAN (konfirmasi ke pemilik kalau ada yang salah):
// - Urutan daftar yang diberikan pemilik = urutan hierarki atas -> bawah.
// - Cleaner & Gondola dianggap sejajar (level sama).
//
// CARA MENGISI `departemen_id` (WAJIB, sekali saja):
// Jalankan di Supabase SQL Editor:
//     select id, department_name from departments order by id;
// lalu salin id-nya ke field `departemen_id` di bawah.
// ===================================================================

window.ORG_DATA = {
    version: 1,

    // ---- Level perusahaan (di atas semua departemen) ----
    company: [
        { jabatan_id: 1, name: "Direktur",         level: 1 },
        { jabatan_id: 2, name: "General Manager",  level: 2 }
    ],

    // ---- Departemen ----
    departments: [
        {
            key: "security",
            name: "Departemen Security",
            departemen_id: 1, // <- ISI dari tabel departments
            positions: [
                { jabatan_id: 3,  name: "Manager",             level: 1 },
                { jabatan_id: 4,  name: "Head Supervisor",     level: 2 },
                { jabatan_id: 5,  name: "Supervisor",          level: 3 },
                { jabatan_id: 6,  name: "Assisten Supervisor", level: 4 },
                { jabatan_id: 10, name: "DANRU",               level: 5 },
                { jabatan_id: 17, name: "Wakil DANRU",         level: 6 },
                { jabatan_id: 11, name: "Anggota Security",    level: 7 }
            ]
        },
        {
            key: "cleaning",
            name: "Departemen Cleaning Service",
            departemen_id: 2,
            positions: [
                { jabatan_id: 3,  name: "Manager",             level: 1 },
                { jabatan_id: 4,  name: "Head Supervisor",     level: 2 },
                { jabatan_id: 5,  name: "Supervisor",          level: 3 },
                { jabatan_id: 6,  name: "Assisten Supervisor", level: 4 },
                { jabatan_id: 7,  name: "Pengawas",            level: 5 },
                { jabatan_id: 8,  name: "Assisten Pengawas",   level: 6 },
                { jabatan_id: 12, name: "Cleaner",             level: 7 },
                { jabatan_id: 15, name: "Gondola",             level: 7 }
            ]
        },
        {
            key: "labour_supply",
            name: "Department Labour Supply",
            departemen_id: 5,
            positions: [
                { jabatan_id: 3,  name: "Manager",           level: 1 },
                { jabatan_id: 5,  name: "Supervisor",        level: 2 },
                { jabatan_id: 7,  name: "Pengawas",          level: 3 },
                { jabatan_id: 8,  name: "Assisten Pengawas", level: 4 },
                { jabatan_id: 13, name: "Helper",            level: 5 }
            ]
        },
        {
            key: "resepsionis",
            name: "Departemen Resepsionis",
            departemen_id: 3,
            positions: [
                { jabatan_id: 3,  name: "Manager",             level: 1 },
                { jabatan_id: 4,  name: "Head Supervisor",     level: 2 },
                { jabatan_id: 5,  name: "Supervisor",          level: 3 },
                { jabatan_id: 6,  name: "Assisten Supervisor", level: 4 },
                { jabatan_id: 7,  name: "Pengawas",            level: 5 },
                { jabatan_id: 8,  name: "Assisten Pengawas",   level: 6 },
                { jabatan_id: 14, name: "Resepsionis",         level: 7 }
            ]
        },
        {
            key: "hrga",
            name: "Department Human Resource & General Affair",
            departemen_id: 4,
            positions: [
                { jabatan_id: 3, name: "Manager",    level: 1 },
                { jabatan_id: 5, name: "Supervisor", level: 2 },
                { jabatan_id: 9, name: "Admin",      level: 3 }
            ]
        }
    ]
};