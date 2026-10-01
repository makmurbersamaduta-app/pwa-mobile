// File: js/akun.js
// Render hub Akun: kartu profil + daftar menu dikelompokkan per category + Logout

document.addEventListener("DOMContentLoaded", async () => {
  const user = getCurrentSessionUser();
  if (!user) {
    window.location.replace("../login.html");
    return;
  }

  document.getElementById("profileName").innerText = user.fullName || user.username;
  document.getElementById("profileSub").innerText = `${user.username} - ${user.entitas || 'PT. DMB'}`;

  const allowedMenus = await fetchAllowedMenus(user);

  // Ambil hanya sub-menu Akun (kode PWA-ACCOUNT-, tapi BUKAN hub-nya sendiri PWA-ACCOUNT-01)
  const accountMenus = allowedMenus.filter(m => m.menu_code.startsWith("PWA-ACCOUNT-") && m.menu_code !== "PWA-ACCOUNT-01");

  renderGroupedMenus(accountMenus);

  document.getElementById("btnLogout").addEventListener("click", handleLogout);
});

function renderGroupedMenus(menus) {
  const container = document.getElementById("akunGroups");

  if (menus.length === 0) {
    container.innerHTML = "";
    return;
  }

  const groups = {};
  menus.forEach(menu => {
    if (!groups[menu.category]) groups[menu.category] = [];
    groups[menu.category].push(menu);
  });

  let html = "";
  Object.keys(groups).forEach(groupName => {
    const items = groups[groupName];
    html += `
      <div class="group-section">
        <div class="group-title">${groupName}</div>
        <div class="group-card">
          ${items.map(item => `
            <a href="${item.path_url}" class="menu-row">
              <i class="fa-solid ${item.icon_class}"></i>
              <span>${item.menu_name}</span>
              <i class="fa-solid fa-chevron-right chevron"></i>
            </a>
          `).join("")}
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

function handleLogout() {
  const konfirmasi = confirm("Apakah Anda yakin ingin keluar dari akun ini?");
  if (!konfirmasi) return;

  localStorage.removeItem("pwa_mobile_session");
  sessionStorage.removeItem("pwa_mobile_session");
  localStorage.removeItem("pwa_mobile_remember");

  window.supabaseClient.auth.signOut();

  window.location.replace("../login.html");
}