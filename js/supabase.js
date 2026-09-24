// js/supabase.js
// Inisialisasi client Supabase untuk WEB ERP.
// Dimuat via <script> biasa (bukan ES module) supaya konsisten
// dengan pola yang sudah dipakai di seluruh halaman ERP.
// HANYA berisi anon key -- JANGAN PERNAH taruh service_role key di sini.

const SUPABASE_URL = "https://gkqxzxwiawfpjtnzexvq.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdrcXh6eHdpYXdmcGp0bnpleHZxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ2MzI0MzksImV4cCI6MjEwMDIwODQzOX0.tFjGOY1z35tMZi0re-oYlIF9yXxa9-8uYtKBBYmwpm8";

if (!window.supabaseClient) {
    window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}