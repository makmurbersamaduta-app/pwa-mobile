// ===================================================================
// FILE: js/organization.js
// HELPER STRUKTUR ORGANISASI (pola non-module, seperti supabase.js)
// Memakai data dari js/organization-data.js (window.ORG_DATA).
// Hasil akhir: window.OrgStructure
//
// URUTAN LOAD DI HTML (urutan penting):
//   <script src="../../js/supabase.js"></script>
//   <script src="../../js/organization-data.js"></script>
//   <script src="../../js/organization.js"></script>
//
// CONTOH PEMAKAIAN di skrip lain:
//   const filled = await OrgStructure.getFilledJabatanIds(5 /*departemen_id*/);
//   const pj = OrgStructure.resolveResponsible("security", 4, filled);
//   // pj = { scope: "company", jabatanIds: [2], names: ["General Manager"] }
// ===================================================================

(function () {
    const DATA = window.ORG_DATA;
    if (!DATA) {
        console.error("OrgStructure: ORG_DATA belum dimuat. Cek urutan <script>.");
        return;
    }

    // ---------------------------------------------------------------
    // 1. PENCARIAN DEPARTEMEN
    //    Mengambil data departemen berdasarkan key ("security", dst)
    //    atau berdasarkan id departemen dari database.
    // ---------------------------------------------------------------
    function getDepartment(key) {
        return DATA.departments.find(d => d.key === key) || null;
    }

    function getDepartmentById(departemenId) {
        return DATA.departments.find(d => d.departemen_id === departemenId) || null;
    }

    // ---------------------------------------------------------------
    // 2. PENCARIAN POSISI
    //    Mengambil satu posisi (jabatan) di dalam departemen tertentu.
    // ---------------------------------------------------------------
    function getPosition(deptKey, jabatanId) {
        const dept = getDepartment(deptKey);
        if (!dept) return null;
        return dept.positions.find(p => p.jabatan_id === jabatanId) || null;
    }

    // ---------------------------------------------------------------
    // 3. DAFTAR HIERARKI
    //    Mengembalikan posisi satu departemen, urut atas -> bawah.
    // ---------------------------------------------------------------
    function getChain(deptKey) {
        const dept = getDepartment(deptKey);
        if (!dept) return [];
        return [...dept.positions].sort((a, b) => a.level - b.level);
    }

    // ---------------------------------------------------------------
    // 4. ESKALASI PENANGGUNG JAWAB (inti aturan "naik level")
    //    Parameter:
    //      deptKey          : key departemen, mis. "security"
    //      jabatanId        : jabatan karyawan yang dicari atasannya
    //      filledJabatanIds : Set berisi jabatan_id yang ADA karyawan
    //                         aktifnya di departemen itu
    //      companyFilledIds : (opsional) Set jabatan perusahaan yang terisi.
    //                         Kalau tidak diisi, GM (2) & Direktur (1)
    //                         dianggap ada.
    //    Hasil: { scope, level, jabatanIds, names } atau null.
    // ---------------------------------------------------------------
    function resolveResponsible(deptKey, jabatanId, filledJabatanIds, companyFilledIds) {
        const filled = filledJabatanIds instanceof Set ? filledJabatanIds : new Set(filledJabatanIds || []);
        const companyFilled = companyFilledIds
            ? (companyFilledIds instanceof Set ? companyFilledIds : new Set(companyFilledIds))
            : new Set(DATA.company.map(c => c.jabatan_id));

        const dept = getDepartment(deptKey);
        let startCompanyLevel = Infinity; // dari posisi mana pencarian level perusahaan dimulai

        if (dept) {
            const me = dept.positions.find(p => p.jabatan_id === jabatanId);
            if (!me) return null;

            // Naik satu per satu level di dalam departemen
            for (let lvl = me.level - 1; lvl >= 1; lvl--) {
                const found = dept.positions.filter(p => p.level === lvl && filled.has(p.jabatan_id));
                if (found.length > 0) {
                    return {
                        scope: "department",
                        level: lvl,
                        jabatanIds: found.map(p => p.jabatan_id),
                        names: found.map(p => p.name)
                    };
                }
            }
        } else {
            // Bukan jabatan departemen: mungkin jabatan perusahaan (GM / Direktur)
            const c = DATA.company.find(x => x.jabatan_id === jabatanId);
            if (!c) return null;
            startCompanyLevel = c.level;
        }

        // Semua level departemen kosong -> naik ke GM lalu Direktur
        const companyChain = [...DATA.company].sort((a, b) => b.level - a.level); // GM dulu
        for (const c of companyChain) {
            if (c.level < startCompanyLevel && companyFilled.has(c.jabatan_id)) {
                return { scope: "company", level: c.level, jabatanIds: [c.jabatan_id], names: [c.name] };
            }
        }
        return null; // tidak ada atasan (mis. Direktur)
    }

    // ---------------------------------------------------------------
    // 5. AMBIL JABATAN YANG TERISI DARI DATABASE
    //    Mengecek hrd.employee_assignments (assignment aktif) untuk satu
    //    departemen, opsional dibatasi per branch. Hasilnya dipakai
    //    sebagai `filledJabatanIds` di resolveResponsible().
    // ---------------------------------------------------------------
    async function getFilledJabatanIds(departemenId, branchId = null) {
        let query = window.supabaseClient
            .schema("hrd")
            .from("employee_assignments")
            .select("jabatan_id")
            .eq("departemen_id", departemenId)
            .eq("is_active", true);

        if (branchId) query = query.eq("branch_id", branchId);

        const { data, error } = await query;
        if (error) {
            console.error("OrgStructure: gagal membaca assignment:", error);
            return new Set();
        }
        return new Set((data || []).map(r => r.jabatan_id));
    }

    // ---------------------------------------------------------------
    // 6. EKSPOR KE GLOBAL
    // ---------------------------------------------------------------
    window.OrgStructure = {
        data: DATA,
        getDepartment,
        getDepartmentById,
        getPosition,
        getChain,
        resolveResponsible,
        getFilledJabatanIds
    };
})();