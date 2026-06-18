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

// IMPORTANT: this MUST produce the exact same key format as
// examMetaFromPath()/getExamCatalog() in jlpt-sync.js, which is the
// canonical key format used by exam_settings.exam_key everywhere:
//   n{level}-{year}-{month}   e.g. "n3-2025-12"
// If this ever drifts out of sync with jlpt-sync.js, admin lock/unlock
// actions will silently stop affecting direct-path access.
function detectExamKey() {
  const p = pathname.toLowerCase();

  // Pattern A: filename like 2025-12-n3.html (also matches 2025-12-n3-something.html)
  let m = p.match(/(\d{4})-(\d{2})-n([1-5])/i);
  if (m) return `n${m[3]}-${m[1]}-${m[2]}`;

  // Pattern B: filename like n3-2025-12.html
  m = p.match(/n([1-5])-(\d{4})-(\d{2})/i);
  if (m) return `n${m[1]}-${m[2]}-${m[3]}`;

  // Pattern C (legacy): files like jlpt/n2/2025-12-jlpt.html that don't carry
  // the level in the filename itself. Pull year/month from the filename and
  // the level from the /jlpt/nX/ folder segment.
  m = p.match(/(\d{4})-(\d{2})-jlpt/i);
  if (m) {
    const levelMatch = p.match(/\/jlpt\/n([1-5])\//i) || p.match(/\/n([1-5])\//i);
    if (levelMatch) return `n${levelMatch[1]}-${m[1]}-${m[2]}`;
  }

  return '';
}

async function readSettingsMap(table) {
  try {
    const rpcName = table === 'system_settings'
      ? 'jlpt_get_system_settings'
      : table === 'exam_settings'
        ? 'jlpt_get_exam_settings'
        : null;

    if (rpcName) {
      const { data, error } = await supabase.rpc(rpcName);
      if (!error && Array.isArray(data) && data.length) return data;
    }

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
    liveEnabled: String(system.exam_live_enabled ?? 'true').trim().toLowerCase() !== 'false',
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

      // Keep enforcing after load: if admin locks this exam (or locks
      // everything) while the user is already on the page, kick them out
      // for real instead of relying only on the in-page visual shield.
      const recheck = async () => {
        try {
          const fresh = await readCurrentLockState(examKey);
          window.__JLPT_LOCK_STATE__ = fresh;
          if (fresh.globalLocked || fresh.examLocked) {
            safeRedirect(base + 'index.html?locked=1');
          }
        } catch (e) {
          console.warn('Lock re-check failed:', e);
        }
      };
      setInterval(recheck, 6000);

      try {
        supabase
          .channel('auth-guard-lock-watch')
          .on('postgres_changes', { event: '*', schema: 'public', table: 'system_settings' }, recheck)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'exam_settings' }, recheck)
          .subscribe();
      } catch (e) {
        console.warn('Realtime lock watch failed to subscribe:', e);
      }
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
