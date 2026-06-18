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

function detectExamKey() {
  const p = pathname.replace(/\\/g, '/');
  const match = p.match(/(\d{4}-\d{2}-n[1-5])/i);
  if (match) return match[1].toLowerCase();
  const alt = p.match(/(n[1-5]-\d{4}-\d{2})/i);
  if (alt) {
    const parts = alt[1].toLowerCase().split('-');
    if (parts.length === 3) return `${parts[1]}-${parts[2]}-${parts[0]}`;
  }
  return '';
}

async function readSettingsMap(table) {
  try {
    const { data, error } = await supabase.from(table).select('*');
    if (error) throw error;
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function readCurrentLockState(examKey) {
  const [systemRows, examRows] = await Promise.all([
    readSettingsMap('system_settings'),
    examKey ? readSettingsMap('exam_settings') : Promise.resolve([])
  ]);

  const system = Object.fromEntries(systemRows.map((r) => [String(r.key || '').toLowerCase(), String(r.value ?? '')]));
  const examRow = examRows.find((r) => String(r.exam_key || '').toLowerCase() === examKey);

  return {
    globalLocked: ['1', 'true', 'yes', 'on'].includes(String(system.exam_locked || '').toLowerCase()),
    lockReason: String(system.exam_lock_reason || system.lock_reason || ''),
    liveEnabled: !['0', 'false', 'no', 'off'].includes(String(system.exam_live_enabled || '').toLowerCase()),
    examLocked: !!examRow?.locked,
    examLockReason: String(examRow?.lock_reason || ''),
    examRow: examRow || null
  };
}

async function loadActiveUser() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { session: null, userDb: null, role: null };

  const email = (session.user.email || '').trim().toLowerCase();
  const roleFromEmail = ROOT_ADMIN_EMAILS.has(email) ? 'admin' : 'user';

  const { data: userDb } = await supabase
    .from('users')
    .select('status, full_name, display_name, avatar_url, role')
    .eq('id', session.user.id)
    .maybeSingle();

  const dbRole = String(userDb?.role || '').trim().toLowerCase();
  const roleFromDb = ['admin', 'super admin', 'super_admin'].includes(dbRole) ? 'admin' : 'user';

  return { session, userDb, role: roleFromEmail === 'admin' || roleFromDb === 'admin' ? 'admin' : 'user' };
}

(async () => {
  try {
    document.documentElement.style.visibility = 'hidden';

    const kind = detectPageKind();
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
      if (kind === 'exam') {
        // Admin can open exam pages for QA/testing.
        document.documentElement.style.visibility = 'visible';
      } else {
        window.JLPT_AUTH_READY = true;
      }

      if (kind === 'index') {
        document.documentElement.style.visibility = 'visible';
      }
      if (kind === 'admin') {
        document.documentElement.style.visibility = 'visible';
      }
      return;
    }

    if (!userDb || userDb.status !== 'active') {
      await supabase.auth.signOut();
      safeRedirect(base + 'auth.html');
      return;
    }

    if (kind === 'exam') {
      const examKey = detectExamKey();
      const locks = await readCurrentLockState(examKey);
      if (locks.globalLocked || locks.examLocked) {
        // Hard block direct access even if the user knows the HTML path.
        safeRedirect(base + 'index.html?locked=1');
        return;
      }
      window.__JLPT_EXAM_KEY__ = examKey;
      window.__JLPT_LOCK_STATE__ = locks;
    }

    document.documentElement.style.visibility = 'visible';
    window.JLPT_AUTH_READY = true;
  } catch (error) {
    console.error('Auth guard error:', error);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) safeRedirect(base + 'auth.html');
      else document.documentElement.style.visibility = 'visible';
    } catch {
      safeRedirect(base + 'auth.html');
    }
  }
})();
