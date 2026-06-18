// auth-guard.js — shared auth gate for all JLPT pages
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

const SUPABASE_URL  = 'https://uincqpdexdenjcmwdfsv.supabase.co';
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
  if (location.href !== new URL(url, location.href).href) {
    window.location.replace(url);
  }
}

async function loadActiveUser() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { session: null, userDb: null, role: null };

  const email = (session.user.email || '').trim().toLowerCase();
  const role = ROOT_ADMIN_EMAILS.has(email) ? 'admin' : 'user';

  const { data: userDb } = await supabase
    .from('users')
    .select('status, full_name, display_name, avatar_url, role')
    .eq('id', session.user.id)
    .maybeSingle();

  return { session, userDb, role };
}

(async () => {
  try {
    const { session, userDb, role } = await loadActiveUser();

    if (!session) {
      safeRedirect(base + 'auth.html');
      return;
    }

    window._session = session;
    window._userDb = userDb || null;
    window._isAdmin = role === 'admin';
    window._role = role;

    if (role === 'admin') {
      if (!location.pathname.endsWith('/admin.html') && !location.pathname.endsWith('admin.html')) {
        safeRedirect(base + 'admin.html');
      }
      return;
    }

    if (!userDb || userDb.status !== 'active') {
      await supabase.auth.signOut();
      safeRedirect(base + 'auth.html');
      return;
    }

    window.JLPT_AUTH_READY = true;
  } catch (error) {
    console.error('Auth guard error:', error);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) safeRedirect(base + 'auth.html');
      else window.JLPT_AUTH_READY = true;
    } catch {
      safeRedirect(base + 'auth.html');
    }
  }
})();
