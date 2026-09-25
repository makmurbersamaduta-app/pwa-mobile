// File: js/auth.js

const SESSION_KEY = "pwa_mobile_session";
const REMEMBER_KEY = "pwa_mobile_remember";
const SYNTHETIC_DOMAIN = "@company.internal";

document.addEventListener("DOMContentLoaded", () => {
    // ---------------------------------------------------------
    // 1. REVERSE GUARD & PATH CHECKING (Perbaikan Bug Desktop)
    // ---------------------------------------------------------
    const activeSession = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY);
    const currentPath = window.location.pathname.toLowerCase();
    
    // Mendeteksi apakah user sedang berada di halaman login (mendukung GitHub Pages sub-folder)
    const isLoginPage = currentPath.endsWith("login.html") || currentPath.endsWith("/pwa-mobile/") || currentPath === "/";

    if (isLoginPage) {
        if (activeSession) {
            // Jika sudah login tapi ada di halaman login, paksa ke dashboard
            window.location.replace("index.html");
            return;
        }
    } else {
        // Jika berada di halaman lain, pastikan sesi aktif
        checkAuthGuard();
    }

    // ---------------------------------------------------------
    // 2. TOGGLE LIHAT PASSWORD (Perbaikan Bug 1)
    // ---------------------------------------------------------
    const togglePasswordBtn = document.getElementById("togglePassword");
    const passwordInput = document.getElementById("passwordInput");
    
    if (togglePasswordBtn && passwordInput) {
        togglePasswordBtn.addEventListener("click", function () {
            const type = passwordInput.getAttribute("type") === "password" ? "text" : "password";
            passwordInput.setAttribute("type", type);
            
            // Toggle icon (Asumsi menggunakan FontAwesome fa-eye / fa-eye-slash)
            if (this.classList.contains("fa-eye")) {
                this.classList.remove("fa-eye");
                this.classList.add("fa-eye-slash");
            } else {
                this.classList.remove("fa-eye-slash");
                this.classList.add("fa-eye");
            }
        });
    }

    // =========================================================
// FITUR TOGGLE LIHAT PASSWORD (MODAL GANTI PASSWORD)
// =========================================================
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
    // 3. EVENT LISTENER FORM LOGIN
    // ---------------------------------------------------------
    const formLogin = document.getElementById("formLogin");
    if (formLogin) {
        // Auto-fill Remember Me
        const savedUsername = localStorage.getItem(REMEMBER_KEY);
        if (savedUsername) {
            const userField = document.getElementById("usernameInput") || document.getElementById("nikInput");
            if (userField) userField.value = savedUsername;
            const rememberCheck = document.getElementById("rememberMe");
            if (rememberCheck) rememberCheck.checked = true;
        }

        formLogin.addEventListener("submit", async (e) => {
            e.preventDefault();
            const usernameField = document.getElementById("usernameInput") || document.getElementById("nikInput");
            const username = usernameField.value.trim();
            const password = passwordInput.value;
            const isRemember = document.getElementById("rememberMe")?.checked || false;
            
            await handleLogin(username, password, isRemember);
        });
    }

    // ---------------------------------------------------------
    // 4. EVENT LISTENER FORCE CHANGE PASSWORD (Perbaikan Bug 2)
    // ---------------------------------------------------------
    const btnSubmitChangePassword = document.getElementById("btnSubmitChangePassword");
    if (btnSubmitChangePassword) {
        btnSubmitChangePassword.addEventListener("click", handleForceChangePassword);
    }
});

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

        // 1. Authenticate ke Supabase Auth
        const { data: authData, error: authError } = await window.supabaseClient.auth.signInWithPassword({
            email: syntheticEmail,
            password: password
        });

        if (authError) throw new Error("Username atau Password yang Anda masukkan salah!");

        // 2. Query Data Profil (Hanya Role, Status, dan Pass Indicator)
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

        // 3. Query Data Personal Karyawan dari Schema HRD
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

        // 4. Query Departemen & Area Aktif dari employee_assignments
        const { data: assignData } = await window.supabaseClient.schema("hrd")
            .from("employee_assignments")
            .select("departemen_id, area_id")
            .eq("is_active", true)
            .or(`employee_id.eq.${empData.id},employee_id.eq.${empData.nik_karyawan}`)
            .maybeSingle();

        // 5. Cek Mekanisme Force Change Password
        if (userData.must_change_password === true) {
            const forceChangeModal = document.getElementById("forceChangeModal");
            if (forceChangeModal) {
                forceChangeModal.dataset.userId = userData.id;
                forceChangeModal.classList.add("show");
                forceChangeModal.style.display = "block";
            } else {
                alert("Anda diwajibkan mengganti password, namun pop-up modal tidak ditemukan di HTML.");
            }
            return; // Hentikan eksekusi login, masuk ke mode ganti password
        }

        // 6. Simpan Session Login & Handle Remember Me
        const userSession = {
            userId: userData.id,
            username: userData.username,
            fullName: empData.nama || userData.username,
            roleId: userData.role_id,
            depId: assignData?.departemen_id || null, 
            areaId: assignData?.area_id || null,      
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

        // Redirect ke Dashboard Utama
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
    const userId = document.getElementById("forceChangeModal")?.dataset.userId;

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
        // 1. Update Password di Sistem Auth Supabase
        const { error: authError } = await window.supabaseClient.auth.updateUser({
            password: newPassword
        });

        if (authError) throw new Error("Gagal menyimpan password di sistem Auth: " + authError.message);

        // 2. Update status must_change_password di tabel public.users
        const { error: dbError } = await window.supabaseClient
            .from("users")
            .update({ 
                must_change_password: false,
                updated_at: new Date().toISOString()
            })
            .eq("id", userId);

        if (dbError) throw new Error("Gagal mengupdate status user di database: " + dbError.message);

        alert("✅ Password berhasil diperbarui! Silakan klik OK, lalu login kembali dengan password baru Anda.");
        
        // Membersihkan sesi Auth sementara dari browser
        await window.supabaseClient.auth.signOut();
        
        // Reload paksa halaman untuk mereset form login
        window.location.reload();

    } catch (err) {
        alert(err.message);
    } finally {
        if(btnText) btnText.innerText = "Simpan Password Baru";
        if(btnSpinner) btnSpinner.style.display = "none";
        if(btnSubmit) btnSubmit.disabled = false;
    }
}