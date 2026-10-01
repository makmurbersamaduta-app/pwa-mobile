// File: js/laporan.js
// Render hub Laporan: daftar menu dikelompokkan per category (Grup -> Item)

document.addEventListener("DOMContentLoaded", async () => {
  const user = getCurrentSessionUser();
  if (!user) {
    window.location.replace("../login.html");
    return;
  }

  const allowedMenus = await fetchAllowedMenus(user);

  // Ambil hanya sub-menu Laporan (kode PWA-REPORT-, tapi BUKAN hub-nya sendiri PWA-REPORT-01)
  const reportMenus = allowedMenus.filter(m => m.menu_code.startsWith("PWA-REPORT-") && m.menu_code !== "PWA-REPORT-01");

  renderGroupedMenus(reportMenus);
});

function renderGroupedMenus(menus) {
  const container = document.getElementById("laporanGroups");

  if (menus.length === 0) {
    container.innerHTML = `<div class="empty-state">Belum ada menu Laporan yang tersedia untuk akun Anda.</div>`;
    return;
  }

  // Kelompokkan berdasarkan category, urutan grup mengikuti sort_order item pertama di grup itu
  const groups = {};
  menus.forEach(menu => {
    if (!groups[menu.category]) groups[menu.category] = [];
    groups[menu.category].push(menu);
  });

  let html = "";
  Object.keys(groups).forEach(groupName => {
    const items = groups[groupName];
    // Grup kosong tidak mungkin muncul di sini karena hanya dibuat saat ada item -- aman.
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