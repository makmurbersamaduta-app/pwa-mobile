// File: js/menu-engine.js
// Logika bersama: ambil menu dari app_menus, filter role_permissions,
// filter menu_access_rules. Dipakai index.html, laporan.html, akun.html.

// ===================================================
// AMBIL SEMUA MENU PWA YANG BOLEH DILIHAT USER (role_permissions)
// ===================================================
async function fetchAllowedMenus(user) {
  let menuRows = [];

  if (user.roleId === 1) {
    const { data, error } = await window.supabaseClient
      .from("app_menus")
      .select("id, menu_code, menu_name, category, icon_class, path_url, sort_order")
      .eq("platform", "pwa")
      .eq("is_active", true)
      .order("sort_order");

    if (error) {
      console.error("[Menu Engine] Gagal load app_menus:", error);
      return [];
    }
    menuRows = data;
  } else {
    const { data, error } = await window.supabaseClient
      .from("role_permissions")
      .select("can_view, app_menus!inner(id, menu_code, menu_name, category, icon_class, path_url, sort_order, platform, is_active)")
      .eq("role_id", user.roleId)
      .eq("can_view", true)
      .eq("app_menus.platform", "pwa")
      .eq("app_menus.is_active", true);

    if (error) {
      console.error("[Menu Engine] Gagal load role_permissions:", error);
      return [];
    }
    menuRows = data.map(row => row.app_menus).sort((a, b) => a.sort_order - b.sort_order);
  }

  return filterMenusByAccessRules(menuRows, user);
}

// ===================================================
// FILTER menu_access_rules (departemen/area/jabatan)
// ===================================================
async function filterMenusByAccessRules(menuRows, user) {
  if (user.roleId === 1) return menuRows; // Maintenance bypass total
  if (menuRows.length === 0) return [];

  const menuCodes = menuRows.map(m => m.menu_code);

  const { data: rules, error } = await window.supabaseClient
    .from("menu_access_rules")
    .select("menu_code, dimension, mode, value_id, rule_group")
    .in("menu_code", menuCodes);

  if (error) {
    console.error("[Menu Engine] Gagal load menu_access_rules:", error);
    return menuRows; // fail-open
  }

  return menuRows.filter(menu => isAllowedByRules(menu.menu_code, rules, user));
}

function isAllowedByRules(menuCode, rules, user) {
  const menuRules = rules.filter(r => r.menu_code === menuCode);
  if (menuRules.length === 0) return true;

  const groupIds = [...new Set(menuRules.map(r => r.rule_group))];

  return groupIds.some(groupId => {
    const groupRules = menuRules.filter(r => r.rule_group === groupId);
    const dimensionSets = {};
    groupRules.forEach(r => {
      const key = `${r.dimension}_${r.mode}`;
      if (!dimensionSets[key]) dimensionSets[key] = { dimension: r.dimension, mode: r.mode, valueIds: [] };
      dimensionSets[key].valueIds.push(r.value_id);
    });
    return Object.values(dimensionSets).every(set => checkDimensionSet(set, user));
  });
}

function checkDimensionSet(set, user) {
  const userValue = set.dimension === "departemen" ? user.depId
                   : set.dimension === "area" ? user.areaId
                   : set.dimension === "jabatan" ? user.jabatanId
                   : null;

  return set.mode === "hanya"
    ? set.valueIds.includes(userValue)
    : !set.valueIds.includes(userValue);
}

// ===================================================
// AMBIL USER AKTIF DARI SESI (dipakai semua halaman)
// ===================================================
function getCurrentSessionUser() {
  const raw = localStorage.getItem("pwa_mobile_session") || sessionStorage.getItem("pwa_mobile_session");
  return raw ? JSON.parse(raw) : null;
}