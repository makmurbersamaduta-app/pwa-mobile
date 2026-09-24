// File: js/auth.js

// ===================================================
// 1. KONFIGURASI SUPABASE CLIENT & KONSTANTA
// ===================================================
const SUPABASE_URL = "https://gkqxzxwiawfpjtnzexvq.supabase.co"; // URL Supabase Anda
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdrcXh6eHdpYXdmcGp0bnpleHZxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ2MzI0MzksImV4cCI6MjEwMDIwODQzOX0.tFjGOY1z35tMZi0re-oYlIF9yXxa9-8uYtKBBYmwpm8"; // Isi Anon Key Supabase Anda

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const SYNTHETIC_DOMAIN = "@supabase.mail";
const SESSION_KEY = "pwa_mobile_session";
const REMEMBER_KEY = "pwa_remember_username";

// ===================================================
// 2. EVENT LISTENER INITIALIZATION
// ===================================================
document.addEventListener("DOMContentLoaded", () => {
  const isLoginPage = window.location.pathname.endsWith("login.html") || window.location.pathname === "/";

  if (!isLoginPage) {
    checkAuthGuard();
  } else {
    initLoginPageListeners();
  }
});

function initLoginPageListeners() {
  const formLogin = document.getElementById("formLogin");
  const btnTogglePassword = document.getElementById("btnTogglePassword");
  const passwordInput = document.getElementById("passwordInput");
  const usernameInput = document.getElementById("usernameInput");
  const rememberMeCheck = document.getElementById("rememberMeCheck");
  
  // Load Saved Username jika Remember Me aktif
  const savedUsername = localStorage.getItem(REMEMBER_KEY);
  if (savedUsername) {
    usernameInput.value = savedUsername;
    rememberMeCheck.checked = true;
  }

  // Toggle Password Visibility
  if (btnTogglePassword && passwordInput) {
    btnTogglePassword.addEventListener("click", () => {
      const type = passwordInput.getAttribute("type") === "password" ? "text" : "password";
      passwordInput.setAttribute("type", type);
      btnTogglePassword.classList.toggle("fa-eye");
      btnTogglePassword.classList.toggle("fa-eye-slash");
    });
  }

  // Event Help Modal
  const helpModal = document.getElementById("helpModal");
  document.getElementById("btnOpenHelpModal")?.addEventListener("click", () => helpModal.classList.add("show"));
  document.getElementById("btnCloseHelpModal")?.addEventListener("click", () => helpModal.classList.remove("show"));

  // Event Submit Login Form
  if (formLogin) {
    formLogin.addEventListener("submit", async (e) => {
      e.preventDefault();
      const username = usernameInput.value.trim().toUpperCase();
      const password = passwordInput.value;
      const isRemember = rememberMeCheck.checked;

      await handleLogin(username, password, isRemember);
    });
  }

  // Event Submit Form Force Change Password
  const formForceChange = document.getElementById("formForceChange");
  if (formForceChange) {
    formForceChange.addEventListener("submit", async (e) => {
      e.preventDefault();
      await handleForceChangePassword();
    });
  }
}

// ===================================================
// 3. FUNGSI EKSEKUSI LOGIN UTAMA
// ===================================================
// File: js/auth.js (Potongan Update Fungsi Eksekusi Login)

async function handleLogin(username, password, isRemember) {
  const alertContainer = document.getElementById("alertContainer");
  const btnText = document.getElementById("btnText");
  const btnSpinner = document.getElementById("btnSpinner");
  const btnLogin = document.getElementById("btnLogin");

  // Reset State UI
  alertContainer.style.display = "none";
  alertContainer.innerText = "";
  btnText.innerText = "Memproses...";
  btnSpinner.style.display = "inline-block";
  btnLogin.disabled = true;

  try {
    const syntheticEmail = `${username.toLowerCase()}${SYNTHETIC_DOMAIN}`;

    // 1. Authenticate ke Supabase Auth
    const { data: authData, error: authError } = await supabaseClient.auth.signInWithPassword({
      email: syntheticEmail,
      password: password
    });

    if (authError) throw new Error("Username atau Password yang Anda masukkan salah!");

    // 2. Query Data Profil (Hanya Role, Status, dan Pass Indicator)
    const { data: userData, error: userError } = await supabaseClient
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
    const { data: empData } = await supabaseClient.schema("hrd")
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
    // Kita gunakan .or untuk mencocokkan id UUID atau NIK (karena relasi terkadang bervariasi)
    const { data: assignData } = await supabaseClient.schema("hrd")
      .from("employee_assignments")
      .select("departemen_id, area_id")
      .eq("is_active", true)
      .or(`employee_id.eq.${empData.id},employee_id.eq.${empData.nik_karyawan}`)
      .maybeSingle();

    // 5. Cek Mekanisme Force Change Password
    if (userData.must_change_password === true) {
      document.getElementById("forceChangeModal").dataset.userId = userData.id;
      document.getElementById("forceChangeModal").classList.add("show");
      return; 
    }

    // 6. Simpan Session Login & Handle Remember Me
    const userSession = {
      userId: userData.id,
      username: userData.username,
      fullName: empData.nama || userData.username,
      roleId: userData.role_id,
      depId: assignData?.departemen_id || null, // Diambil dari Assignment Aktif
      areaId: assignData?.area_id || null,      // Diambil dari Assignment Aktif
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

    // Redirect ke Dashboard Utama (index.html)
    window.location.href = "index.html";

  } catch (err) {
    alertContainer.innerText = err.message || "Terjadi kesalahan saat proses login.";
    alertContainer.style.display = "block";
  } finally {
    btnText.innerText = "Masuk Ke Sistem";
    btnSpinner.style.display = "none";
    btnLogin.disabled = false;
  }
}

// ===================================================
// 4. PENANGANAN FORCE CHANGE PASSWORD
// ===================================================
async function handleForceChangePassword() {
  const newPassword = document.getElementById("newPasswordInput").value;
  const confirmPassword = document.getElementById("confirmPasswordInput").value;
  const btnSaveText = document.getElementById("btnSaveText");
  const btnSaveSpinner = document.getElementById("btnSaveSpinner");
  const userId = document.getElementById("forceChangeModal").dataset.userId;

  if (newPassword !== confirmPassword) {
    alert("Konfirmasi password tidak cocok!");
    return;
  }

  btnSaveText.innerText = "Menyimpan...";
  btnSaveSpinner.style.display = "inline-block";

  try {
    // 1. Update Password di Supabase Auth Client
    const { error: updateAuthErr } = await supabaseClient.auth.updateUser({
      password: newPassword
    });

    if (updateAuthErr) throw updateAuthErr;

    // 2. Update must_change_password = false di public.users
    const { error: updateDbErr } = await supabaseClient
      .from("users")
      .update({ must_change_password: false })
      .eq("id", userId);

    if (updateDbErr) throw updateDbErr;

    alert("✅ Password baru berhasil disimpan! Silakan login kembali.");
    document.getElementById("forceChangeModal").classList.remove("show");
    window.location.reload();

  } catch (err) {
    alert("Gagal memperbarui password: " + err.message);
  } finally {
    btnSaveText.innerText = "Simpan Password Baru";
    btnSaveSpinner.style.display = "none";
  }
}

// ===================================================
// 5. PROTEKSI HALAMAN (AUTH GUARD) & LOGOUT
// ===================================================
function checkAuthGuard() {
  const sessionData = localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY);
  if (!sessionData) {
    window.location.href = "login.html";
  }
}

async function handleLogout() {
  await supabaseClient.auth.signOut();
  localStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(SESSION_KEY);
  window.location.href = "login.html";
}