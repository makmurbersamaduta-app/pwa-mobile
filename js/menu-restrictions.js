// File: js/menu-restrictions.js
// Rule pembatasan Main Menu PWA berdasarkan departemen/area (di luar role_permissions)
// Kalau menu_code tidak terdaftar di sini, menu tersebut tidak punya batasan tambahan
// (cukup mengikuti role_permissions saja)

const MENU_RESTRICTIONS = {
  "PWA-OPS-01": { departemenId: 1 },              // Patroli -> khusus departemen Security (id 1), area bebas
  "PWA-OPS-02": { departemenId: 5, areaId: 3 },   // OMS -> Labour Supply (id 5) + area STG (id 3)
  "PWA-OPS-03": { departemenId: 5, areaId: 3 }    // Sisa Wrapping -> Labour Supply (id 5) + area STG (id 3)
};

/**
 * Cek apakah user boleh melihat menu tertentu berdasarkan rule departemen/area.
 * Role ID 1 (Maintenance) selalu lolos tanpa syarat apapun.
 */
function isMenuAllowedByRestriction(menuCode, user) {
  if (user.roleId === 1) return true; // Maintenance bypass total

  const rule = MENU_RESTRICTIONS[menuCode];
  if (!rule) return true; // tidak ada rule terdaftar -> lolos otomatis

  if (rule.departemenId && user.depId !== rule.departemenId) return false;
  if (rule.areaId && user.areaId !== rule.areaId) return false;

  return true;
}