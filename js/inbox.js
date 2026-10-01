// File: js/inbox.js
// Placeholder Inbox: switch tab Notifikasi/Persetujuan.
// Pengambilan data sungguhan menyusul setelah tabel notifications
// dan approval_requests dirancang (lihat Mini Project Zona & Approval).

document.addEventListener("DOMContentLoaded", () => {
  const sessionRaw = localStorage.getItem("pwa_mobile_session") || sessionStorage.getItem("pwa_mobile_session");
  if (!sessionRaw) {
    window.location.replace("../login.html");
    return;
  }

  document.querySelectorAll(".tab-item").forEach(tab => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });
});

function switchTab(tabName) {
  document.querySelectorAll(".tab-item").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));

  document.querySelector(`.tab-item[data-tab="${tabName}"]`).classList.add("active");
  document.getElementById(`tab${tabName.charAt(0).toUpperCase() + tabName.slice(1)}`).classList.add("active");
}