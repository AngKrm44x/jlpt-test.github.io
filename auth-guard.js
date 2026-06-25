// auth-guard.js — taruh di root repo, panggil dari semua halaman soal

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

const SUPABASE_URL  = 'https://uincqpdexdenjcmwdfsv.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVpbmNxcGRleGRlbmpjbXdkZnN2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5MjM4ODEsImV4cCI6MjA5NTQ5OTg4MX0.Lf1N_P_iiNQ2hnRJhd-Quy9MLKlZFSzbnXtXCnmRCS0';

// PENTING: simpan ke window SEBELUM dipakai di bawah, dan SEBELUM await apapun.
// jlpt-sync.js (dan script lain di halaman ini) menunggu window._supabase ini
// supaya semua script berbagi SATU client yang sama — kalau tidak, browser akan
// membuat lebih dari satu GoTrueClient yang membaca/menulis token auth yang sama
// secara bersamaan ("Multiple GoTrueClient instances" → perilaku tidak menentu,
// termasuk fullscreen guard / exit warning / sync progress yang kadang gagal).
const supabase = window._supabase || createClient(SUPABASE_URL, SUPABASE_ANON);
window._supabase = supabase;

const { data: { session } } = await supabase.auth.getSession();
window._session = session;

const depth = location.pathname.split('/').filter(Boolean).length;
const base  = '../'.repeat(Math.max(depth - 2, 1)); // sesuaikan path relatif

if (!session) {
  window.location.replace(base + 'auth.html');
} else {
  const { data: usr } = await supabase
    .from('users').select('status').eq('id', session.user.id).single();

  if (!usr || usr.status !== 'active') {
    await supabase.auth.signOut();
    window.location.replace(base + 'auth.html');
  }
}

// Beri tanda bahwa auth-guard sudah selesai memverifikasi sesi, supaya script
// lain (jlpt-sync.js) yang menunggu tidak perlu menunggu penuh sampai timeout.
window.__AUTH_GUARD_READY__ = true;