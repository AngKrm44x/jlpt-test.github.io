// auth-guard.js — shared auth and access gate for all JLPT pages
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

const SUPABASE_URL = 'https://uincqpdexdenjcmwdfsv.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVpbmNxcGRleGRlbmpjbXdkZnN2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5MjM4ODEsImV4cCI6MjA5NTQ5OTg4MX0.Lf1N_P_iiNQ2hnRJhd-Quy9MLKlZFSzbnXtXCnmRCS0';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);
window._supabase = supabase;

const SUPER_ADMIN_EMAIL = 'sidiqangga44@gmail.com';
const ADMIN_EMAIL = 'admin@example.com';
const ROOT_ADMIN_EMAILS = new Set([SUPER_ADMIN_EMAIL.toLowerCase(), ADMIN_EMAIL.toLowerCase()]);

const pathname = location.pathname.replace(/\\/g, '/');
const isNested = pathname.includes('/jlpt/');
const base = isNested ? '../../' : './';

function safeRedirect(url) {
  const next = new URL(url, location.href).href;
  if (location.href !== next) window.location.replace(url);
}

function detectPageKind() {
  const p = pathname.toLowerCase();
  if (p.endsWith('/admin.html') || p.endsWith('admin.html')) return 'admin';
  if (p.endsWith('/index.html') || p.endsWith('index.html')) return 'index';
  if (/\/jlpt\/n[1-5]\/.*\.html$/i.test(p) || /n[1-5]\.html$/i.test(p)) return 'exam';
  return 'other';
}

async function loadUserContext(session) {
  const { data: usr } = await supabase
    .from('users')
    .select('status, full_name, display_name, avatar_url, role')
    .eq('id', session.user.id)
    .maybeSingle();

  window._session = session;
  window._userDb = usr || null;
  window._userRole = String(usr?.role || '').trim().toLowerCase();
  window._authReady = true;
  return usr || null;
}

(async () => {
  try {
    document.documentElement.style.visibility = 'hidden';

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      safeRedirect(base + 'auth.html');
      return;
    }

    const email = (session.user.email || '').trim().toLowerCase();
    const isRootAdmin = ROOT_ADMIN_EMAILS.has(email);
    const userDb = await loadUserContext(session);

    if (!userDb || userDb.status !== 'active') {
      await supabase.auth.signOut();
      safeRedirect(base + 'auth.html');
      return;
    }

    // expose role-ish flags for any page script that needs them
    window._isAdmin = isRootAdmin || ['admin', 'super admin', 'super_admin'].includes(String(userDb?.role || '').trim().toLowerCase());

    if (detectPageKind() === 'admin' && !window._isAdmin) {
      alert('⛔ Akses ditolak. Halaman ini khusus admin.');
      safeRedirect(base + 'index.html');
      return;
    }

    document.documentElement.style.visibility = 'visible';
  } catch (e) {
    console.error('Auth guard error:', e);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) window.location.replace(base + 'auth.html');
      else document.documentElement.style.visibility = 'visible';
    } catch {
      window.location.replace(base + 'auth.html');
    }
  }
})();
