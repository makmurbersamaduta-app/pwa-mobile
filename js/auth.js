// File: js/auth.js

const SESSION_KEY = "pwa_mobile_session";
const REMEMBER_KEY = "pwa_mobile_remember";
const SYNTHETIC_DOMAIN = "@supabase.mail";

document.addEventListener("DOMContentLoaded", () => {
    // ---------------------------------------------------------
    // 1. REVERSE GUARD & PATH CHECKING (Diperketat untuk GitHub Pages)
    // ---------------------------------------------------------
    const activeSession = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY);
    const currentPath = window.location.pathname.toLowerCase();
    
    // Deteksi jika user berada di halaman root ("/") atau folder pwa-mobile tanpa file HTML
    const isLoginPage = currentPath.endsWith("login.html");

    if (!activeSession) {
        // Jika tidak ada sesi dan bukan di halaman login -> Tendang paksa ke login.html
        if (!isLoginPage) {
            window.location.replace("login.html");
            return; 
        }
    } else {
        // Jika sudah login dan mencoba buka halaman login lagi -> Tendang ke dashboard (Home)
        if (isLoginPage) {
            window.location.replace("index.html");
            return; 
        }
    }

    // ---------------------------------------------------------
    // 2. TOGGLE LIHAT PASSWORD UTAMA
    // ---------------------------------------------------------
    const togglePasswordBtn = document.getElementById("togglePassword");
    const passwordInput = document.getElementById("passwordInput");
    
    if (togglePasswordBtn && passwordInput) {
        togglePasswordBtn.addEventListener("click", function () {
            const type = passwordInput.getAttribute("type") === "password" ? "text" : "password";
            passwordInput.setAttribute("type", type);
            this.classList.toggle("fa-eye");
            this.classList.toggle("fa-eye-slash");
        });
    }

    // ---------------------------------------------------------
    // 3. FITUR TOGGLE LIHAT PASSWORD (MODAL GANTI PASSWORD)
    // ---------------------------------------------------------
    const toggleNewPasswordBtn = document.getElementById("toggleNewPassword");
    const newPasswordInput = document.getElementById("newPasswordInput");
    if (toggleNewPasswordBtn && newPasswordInput) {
        toggleNewPasswordBtn.addEventListener("click", function () {
            const type = newPasswordInput.getAttribute("type") === "password" ? "text" : "password";
            newPasswordInput.setAttribute("type", type);
            this.classList.toggle("fa-eye");
            this.classList.toggle("fa-eye-slash");
        });
    }

    const toggleConfirmPasswordBtn = document.getElementById("toggleConfirmPassword");
    const confirmPasswordInput = document.getElementById("confirmPasswordInput");
    if (toggleConfirmPasswordBtn && confirmPasswordInput) {
        toggleConfirmPasswordBtn.addEventListener("click", function () {
            const type = confirmPasswordInput.getAttribute("type") === "password" ? "text" : "password";
            confirmPasswordInput.setAttribute("type", type);
            this.classList.toggle("fa-eye");
            this.classList.toggle("fa-eye-slash");
        });
    }

    // ---------------------------------------------------------
    // 4. EVENT LISTENER FORM LOGIN
    // ---------------------------------------------------------
    const formLogin = document.getElementById("formLogin");
    if (formLogin) {
        // Auto-fill Remember Me
        const savedUsername = localStorage.getItem(REMEMBER_KEY);
        if (savedUsername) {
            const userField = document.getElementById("usernameInput") || document.getElementById("nikInput");
            if (userField) userField.value = savedUsername;
            const rememberCheck = document.getElementById("rememberMeCheck") || document.getElementById("rememberMe");
            if (rememberCheck) rememberCheck.checked = true;
        }

        formLogin.addEventListener("submit", async (e) => {
            e.preventDefault();
            const usernameField = document.getElementById("usernameInput") || document.getElementById("nikInput");
            const username = usernameField.value.trim();
            const password = passwordInput.value;
            const rememberCheck = document.getElementById("rememberMeCheck") || document.getElementById("rememberMe");
            const isRemember = rememberCheck ? rememberCheck.checked : false;
            
            await handleLogin(username, password, isRemember);
        });
    }

    // ---------------------------------------------------------
    // 5. EVENT LISTENER MODAL PASSWORD & BANTUAN
    // ---------------------------------------------------------
    const btnSubmitChangePassword = document.getElementById("btnSubmitChangePassword");
    if (btnSubmitChangePassword) {
        btnSubmitChangePassword.addEventListener("click", handleForceChangePassword);
    }
    
    // Fitur Buka/Tutup Modal Help (Lupa Password)
    const btnOpenHelpModal = document.getElementById("btnOpenHelpModal");
    const btnCloseHelpModal = document.getElementById("btnCloseHelpModal");
    const helpModal = document.getElementById("helpModal");
    
    if (btnOpenHelpModal && helpModal) {
        btnOpenHelpModal.addEventListener("click", () => helpModal.classList.add("show"));
    }
    if (btnCloseHelpModal && helpModal) {
        btnCloseHelpModal.addEventListener("click", () => helpModal.classList.remove("show"));
    }
  // TAMBAHKAN di dalam DOMContentLoaded, dekat listener modal help yang sudah ada:
    const btnCheckForgotStatus = document.getElementById("btnCheckForgotStatus");
    if (btnCheckForgotStatus) {
        btnCheckForgotStatus.addEventListener("click", handleRequestReset);
    }  
});

// ===================================================
// FUNGSI AJUKAN RESET PASSWORD (form "Lupa Password")
// Menggantikan handleCheckForgotStatus lama yang HANYA membaca
// must_change_password langsung dari tabel (celah: anon bisa baca
// kolom status akun orang lain). Sekarang SEMUA baca+tulis status
// lewat Edge Function sync-auth (action "request_reset"), yang
// jalan pakai service_role di server, bukan client anon key.
//
// 3 kemungkinan balasan server (field "status"):
//   'close' TIDAK PERNAH dikembalikan di sini -- kalau masih close,
//           server sudah mengubahnya jadi 'open' di baris yg sama
//   'open'     -> baru diajukan ATAU sudah pernah diajukan sebelumnya,
//                 keduanya sama-sama tampilkan alert utk hubungi admin
//   'progress' -> admin sudah approve -> langsung buka modal ganti password
// ===================================================
async function handleRequestReset() {
    const usernameInput = document.getElementById("forgotUsernameInput");
    const username = usernameInput?.value.trim();
    const btnText = document.getElementById("btnCheckForgotText");
    const btnSpinner = document.getElementById("btnCheckForgotSpinner");
    const btnCheck = document.getElementById("btnCheckForgotStatus");

    if (!username) {
        alert("Masukkan Username / NIK terlebih dahulu.");
        return;
    }

    if (btnText) btnText.innerText = "Memproses...";
    if (btnSpinner) btnSpinner.style.display = "inline-block";
    if (btnCheck) btnCheck.disabled = true;

    try {
        const { data, error } = await window.supabaseClient.functions.invoke("sync-auth", {
            body: { action: "request_reset", username: username }
        });

        if (error || !data?.success) {
            alert(data?.message || error?.message || "Username / NIK tidak ditemukan.");
            return;
        }

        // Admin sudah approve (status 'progress') -- langsung ke modal
        // ganti password, tidak perlu ajukan ulang.
        if (data.status === "progress") {
            const helpModal = document.getElementById("helpModal");
            const forceChangeModal = document.getElementById("forceChangeModal");
            if (helpModal) helpModal.classList.remove("show");
            if (forceChangeModal) {
                forceChangeModal.dataset.userId = data.user_id;
                forceChangeModal.dataset.mode = "forgot";
                forceChangeModal.classList.add("show");
            }
            return;
        }

        // status 'open' -- baru diajukan atau memang masih menunggu admin
        alert(data.message);

    } catch (err) {
        alert("Terjadi kesalahan: " + err.message);
    } finally {
        if (btnText) btnText.innerText = "Ajukan Reset Password";
        if (btnSpinner) btnSpinner.style.display = "none";
        if (btnCheck) btnCheck.disabled = false;
    }
}

// ===================================================
// FUNGSI CHECK AUTH GUARD
// ===================================================
function checkAuthGuard() {
    const activeSession = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY);
    if (!activeSession) {
        window.location.replace("login.html");
    }
}

// ===================================================
// FUNGSI EKSEKUSI LOGIN UTAMA
// ===================================================
async function handleLogin(username, password, isRemember) {
    const alertContainer = document.getElementById("alertContainer");
    const btnText = document.getElementById("btnText");
    const btnSpinner = document.getElementById("btnSpinner");
    const btnLogin = document.getElementById("btnLogin");

    if (alertContainer) {
        alertContainer.style.display = "none";
        alertContainer.innerText = "";
    }
    if (btnText) btnText.innerText = "Memproses...";
    if (btnSpinner) btnSpinner.style.display = "inline-block";
    if (btnLogin) btnLogin.disabled = true;

    try {
        const syntheticEmail = `${username.toLowerCase()}${SYNTHETIC_DOMAIN}`;

        const { data: authData, error: authError } = await window.supabaseClient.auth.signInWithPassword({
            email: syntheticEmail,
            password: password
        });

        if (authError) throw new Error("Username atau Password yang Anda masukkan salah!");

        const { data: userData, error: userError } = await window.supabaseClient
            .from("users")
            .select("id, username, role_id, is_active, must_change_password")
            .ilike("username", username)
            .maybeSingle();

        if (userError || !userData) {
            throw new Error("Akun pengguna tidak ditemukan di tabel sistem ERP!");
        }

        if (userData.is_active === false) {
            throw new Error("Akun Anda telah dinonaktifkan! Hubungi Administrator.");
        }

        const { data: empData } = await window.supabaseClient.schema("hrd")
            .from("employees")
            .select("id, nik_karyawan, nama, is_active, blacklist")
            .ilike("nik_karyawan", username)
            .maybeSingle();

        if (empData) {
            if (empData.is_active === false || empData.blacklist === true) {
                throw new Error("Status Karyawan Non-Aktif / Ter-Blacklist! Akses ditolak.");
            }
        } else {
            throw new Error("Data identitas karyawan tidak ditemukan di HRD!");
        }

        const { data: assignData } = await window.supabaseClient.schema("hrd")
            .from("employee_assignments")
            .select("departemen_id, area_id, jabatan_id")
            .eq("is_active", true)
            .eq("employee_id", empData.id)
            .maybeSingle();

        let areaName = null;
        let departmentName = null;

        if (assignData?.area_id) {
            const { data: areaData } = await window.supabaseClient
                .from("areas")
                .select("area_name")
                .eq("id", assignData.area_id)
                .maybeSingle();
            areaName = areaData?.area_name || null;
        }

        if (assignData?.departemen_id) {
            const { data: deptData } = await window.supabaseClient
                .from("departments")
                .select("department_name")
                .eq("id", assignData.departemen_id)
                .maybeSingle();
            departmentName = deptData?.department_name || null;
        }

        if (userData.must_change_password === "progress") {
            const forceChangeModal = document.getElementById("forceChangeModal");
            if (forceChangeModal) {
                forceChangeModal.dataset.userId = userData.id;
                forceChangeModal.classList.add("show");
                forceChangeModal.style.display = "block"; // Safety display
            } else {
                alert("Anda diwajibkan mengganti password, namun pop-up modal tidak ditemukan di HTML.");
            }
            return; // Hentikan eksekusi login, masuk ke mode ganti password
        }

        const userSession = {
            userId: userData.id,
            username: userData.username,
            fullName: empData.nama || userData.username,
            roleId: userData.role_id,
            depId: assignData?.departemen_id || null, 
            areaId: assignData?.area_id || null,
            jabatanId: assignData?.jabatan_id || null,
            entitas: areaName,
            departemen: departmentName,
            mustChangePassword: false,
            loginTime: new Date().toISOString()
        };

        if (isRemember) {
            localStorage.setItem(SESSION_KEY, JSON.stringify(userSession));
            localStorage.setItem(REMEMBER_KEY, username);
        } else {
            sessionStorage.setItem(SESSION_KEY, JSON.stringify(userSession));
            localStorage.removeItem(REMEMBER_KEY);
        }

        window.location.replace("index.html");

    } catch (err) {
        if (alertContainer) {
            alertContainer.innerText = err.message || "Terjadi kesalahan saat proses login.";
            alertContainer.style.display = "block";
        } else {
            alert(err.message);
        }
    } finally {
        if (btnText) btnText.innerText = "Masuk Ke Sistem";
        if (btnSpinner) btnSpinner.style.display = "none";
        if (btnLogin) btnLogin.disabled = false;
    }
}

// ===================================================
// FUNGSI HANDLE FORCE CHANGE PASSWORD
// ===================================================
async function handleForceChangePassword(e) {
    e.preventDefault();
    
    const newPassword = document.getElementById("newPasswordInput")?.value;
    const confirmPassword = document.getElementById("confirmPasswordInput")?.value;
    const forceChangeModal = document.getElementById("forceChangeModal");
    const userId = forceChangeModal?.dataset.userId;
    const mode = forceChangeModal?.dataset.mode;

    if (!newPassword || newPassword.length < 6) {
        alert("Password baru minimal 6 karakter!");
        return;
    }

    if (confirmPassword && newPassword !== confirmPassword) {
        alert("Konfirmasi password tidak cocok!");
        return;
    }

    const btnText = document.getElementById("btnSubmitChangeText");
    const btnSpinner = document.getElementById("btnSubmitChangeSpinner");
    const btnSubmit = document.getElementById("btnSubmitChangePassword");

    if(btnText) btnText.innerText = "Menyimpan...";
    if(btnSpinner) btnSpinner.style.display = "inline-block";
    if(btnSubmit) btnSubmit.disabled = true;

    try {
        if (mode === "forgot") {
            // Alur Lupa Password: TIDAK ada Auth session, wajib lewat Edge Function service_role
            const { data, error } = await window.supabaseClient.functions.invoke("sync-auth", {
                body: {
                    action: "self_reset_password",
                    user_id: Number(userId),
                    new_password: newPassword
                }
            });

            if (error || !data?.success) {
                throw new Error(data?.message || error?.message || "Gagal memperbarui password.");
            }

            alert("✅ Password berhasil diperbarui! Silakan login dengan password baru Anda.");
            forceChangeModal.classList.remove("show");
            delete forceChangeModal.dataset.mode;
            window.location.reload();
            return;
        }

        // Alur lama: dipicu saat login, sudah ada Auth session aktif
        const { error: authError } = await window.supabaseClient.auth.updateUser({
            password: newPassword
        });

        if (authError) throw new Error("Gagal menyimpan password di sistem Auth: " + authError.message);

        const { error: dbError } = await window.supabaseClient
            .from("users")
            .update({ 
                must_change_password: "close",
                updated_at: new Date().toISOString()
            })
            .eq("id", userId);

        if (dbError) throw new Error("Gagal mengupdate status user di database: " + dbError.message);

        alert("✅ Password berhasil diperbarui! Silakan klik OK, lalu login kembali dengan password baru Anda.");
        
        await window.supabaseClient.auth.signOut();
        window.location.reload();

    } catch (err) {
        alert(err.message);
    } finally {
        if(btnText) btnText.innerText = "Simpan Password Baru";
        if(btnSpinner) btnSpinner.style.display = "none";
        if(btnSubmit) btnSubmit.disabled = false;
    }
}