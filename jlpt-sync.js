// jlpt-sync.js  v4  — complete bug-fixed rewrite
// Fixes:
//  1. CRITICAL – race condition creating a second GoTrueClient (console warning)
//     → jlpt-sync now waits up to 5 s for auth-guard.js to expose window._supabase
//  2. loadSystemSettings() exam_live_enabled logic bug (inverted logic)
//  3. setGlobalLock() showed success toast even when the DB write failed
//  4. setSystemSetting() called refreshAdminPanels() twice (once per key), now batched
//  5. getContext() now waits for window._session (another auth-guard race)
//  6. refreshAdminLivePanel / refreshAdminResultsPanel always call ensureAdminPanel()
//     before querying so the target elements always exist
//  7. syncSession errors now visible in console (not just warn)
//  8. ensureAdminRole() — on admin pages, upserts role='admin' in public.users so
//     the Supabase is_jlpt_admin() role-fallback path works even if JWT email
//     comparison fails for any reason

(async function () {
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm');

  const SUPABASE_URL  = 'https://uincqpdexdenjcmwdfsv.supabase.co';
  const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVpbmNxcGRleGRlbmpjbXdkZnN2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5MjM4ODEsImV4cCI6MjA5NTQ5OTg4MX0.Lf1N_P_iiNQ2hnRJhd-Quy9MLKlZFSzbnXtXCnmRCS0';

  // ── FIX 1: wait for auth-guard.js to expose its client ──────────────────────
  // auth-guard.js (loaded earlier in the page) calls createClient and stores the
  // result in window._supabase after its async auth checks complete.  If we call
  // createClient() ourselves before that happens the browser emits the dreaded
  // "Multiple GoTrueClient instances detected" warning, token-refresh conflicts
  // occur, and RLS policies see a stale/wrong JWT → all reads/writes silently fail.
  const client = await (async function waitForClient() {
    const deadline = Date.now() + 6000;       // up to 6 s
    while (!window._supabase && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 30));
    }
    if (window._supabase) {
      console.log('[jlpt-sync] Using existing Supabase client from auth-guard ✓');
      return window._supabase;
    }
    // Fallback (auth-guard not present or timed out)
    console.warn('[jlpt-sync] Auth-guard client not found – creating standalone client');
    const c = createClient(SUPABASE_URL, SUPABASE_ANON);
    window._supabase = c;
    return c;
  })();

  const ADMIN_EMAILS = new Set(['sidiqangga44@gmail.com', 'admin@example.com']);

  const state = window.__JLPT_SYNC__ = window.__JLPT_SYNC__ || {
    settings: {
      exam_locked: false,
      exam_lock_reason: '',
      exam_live_enabled: true,
      updated_at: null,
      updated_by: null,
    },
    examLocks: new Map(),
    session: null,
    userDb: null,
    isAdmin: false,
    isIndexPage: false,
    isAdminPage: false,
    isExamPage: false,
    examMeta: null,
    examRunning: false,
    lastProgressHash: '',
    lastProgressSentAt: 0,
    syncTimer: null,
    heartbeatTimer: null,
    settingsChannel: null,
    progressChannel: null,
    lockChannel: null,
    adminPanelReady: false,
    userMap: new Map(),
    resultsCache: [],
    liveTimeFilter: 'all',
    resultsTimeFilter: 'all',
    resultsSelectedUsers: null,
  };
  state.client = client;

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function pageKind() {
    const p = location.pathname.replace(/\\/g, '/').toLowerCase();
    if (p.endsWith('/admin.html') || p.endsWith('admin.html')) return 'admin';
    if (p.endsWith('/index.html') || p.endsWith('index.html')) return 'index';
    if (/\/jlpt\/n[1-5]\/.*\.html$/i.test(p) || /n[1-5]\.html$/i.test(p)) return 'exam';
    return 'other';
  }

  function toast(msg) {
    try {
      if (typeof window.showToast === 'function') return window.showToast(msg);
      if (typeof window.alert === 'function')     return window.alert(msg);
    } catch {}
    console.log('[JLPT]', msg);
  }

  function esc(v) {
    return String(v ?? '')
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;')
      .replace(/'/g,  '&#39;');
  }

  function toBool(v) {
    if (typeof v === 'boolean') return v;
    return ['1', 'true', 'yes', 'on', 'locked'].includes(String(v ?? '').trim().toLowerCase());
  }

  function fmtTime(ts) {
    if (!ts) return '—';
    try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
  }

  function fmtSec(sec) {
    if (sec == null || Number.isNaN(Number(sec))) return '—';
    const s  = Math.max(0, Math.floor(Number(sec)));
    const mm = Math.floor(s / 60);
    const ss = s % 60;
    return `${mm}:${String(ss).padStart(2, '0')}`;
  }

  function currentPath() { return location.pathname.replace(/\\/g, '/'); }

  function getTimeFilterCutoff(filter) {
    const now = Date.now();
    const map = {
      '15m':   now - 15 * 60 * 1000,
      '30m':   now - 30 * 60 * 1000,
      '1h':    now - 60 * 60 * 1000,
      'today': new Date(new Date().setHours(0,0,0,0)).getTime(),
      'week':  now - 7  * 24 * 60 * 60 * 1000,
      'month': now - 30 * 24 * 60 * 60 * 1000,
    };
    return map[filter] ?? null; // null = no cutoff (all)
  }

  function examMetaFromPath() {
    if (state.examMeta) return state.examMeta;
    const p   = currentPath();
    let key   = '', level = '', year = '', month = '';
    const m   = p.match(/(\d{4})-(\d{2})-n([1-5])/i);
    if (m) {
      year = m[1]; month = m[2]; level = `N${m[3]}`;
      key  = `n${m[3]}-${m[1]}-${m[2]}`;
    } else {
      const m2 = p.match(/n([1-5])-(\d{4})-(\d{2})/i);
      if (m2) {
        level = `N${m2[1]}`; year = m2[2]; month = m2[3];
        key   = `n${m2[1]}-${m2[2]}-${m2[3]}`;
      } else {
        const m3  = p.match(/(\d{4})-(\d{2})-jlpt/i);
        const lvl = p.match(/\/jlpt\/n([1-5])\//i) || p.match(/\/n([1-5])\//i);
        if (m3 && lvl) {
          year = m3[1]; month = m3[2]; level = `N${lvl[1]}`;
          key  = `n${lvl[1]}-${m3[1]}-${m3[2]}`;
        } else {
          const fb  = (location.pathname.split('/').pop() || document.title || 'exam').replace(/\.[^.]+$/, '');
          key       = fb.toLowerCase();
          const lv  = fb.match(/n([1-5])/i);
          level     = lv ? `N${lv[1]}` : 'N?';
        }
      }
    }
    state.examMeta = { key, level, year, month, title: (document.title || `${level} Exam`).trim(), path: p };
    window.__JLPT_EXAM_KEY__ = key;
    return state.examMeta;
  }

  function isAdminEmail(email = '') {
    return ADMIN_EMAILS.has(String(email).trim().toLowerCase());
  }

  // ── FIX 2: getContext waits for window._session (second auth-guard race) ─────
  async function getContext() {
    try {
      // Wait up to 3 s for auth-guard.js to set window._session
      if (!window._session) {
        const deadline = Date.now() + 3000;
        while (!window._session && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 25));
        }
      }
      const session = window._session || (await client.auth.getSession()).data.session;
      if (!session) return null;

      const email  = (session.user.email || '').trim().toLowerCase();
      let userDb   = window._userDb || null;
      if (!userDb) {
        const res = await client.from('users').select('*').eq('id', session.user.id).maybeSingle();
        userDb    = res.data || null;
      }
      const dbRole    = String(userDb?.role || '').trim().toLowerCase();
      const roleFromDb = ['admin', 'super admin', 'super_admin'].includes(dbRole);
      return { session, userDb, isAdmin: isAdminEmail(email) || roleFromDb };
    } catch (err) {
      console.warn('[jlpt-sync] getContext failed:', err?.message || err);
      return null;
    }
  }

  // ── FIX 3: ensure admin's role is written to public.users ───────────────────
  // is_jlpt_admin() in Supabase has two checks: JWT email OR users.role.
  // Bootstrapping the role here ensures the role-based path always works, even
  // if the JWT email comparison has any edge case (trim, encoding, etc.).
  async function ensureAdminRole(ctx) {
    if (!ctx?.isAdmin || !ctx.session) return;
    try {
      const { error } = await client.from('users').upsert(
        {
          id:       ctx.session.user.id,
          role:     'admin',
          email:    ctx.session.user.email || '',
          status:   'active',
        },
        { onConflict: 'id', ignoreDuplicates: false }
      );
      if (error) {
        console.warn('[jlpt-sync] ensureAdminRole upsert error:', error.message);
      } else {
        console.log('[jlpt-sync] Admin role ensured in public.users ✓');
      }
    } catch (err) {
      console.warn('[jlpt-sync] ensureAdminRole failed:', err?.message || err);
    }
  }

  // ── DB helpers ───────────────────────────────────────────────────────────────
  async function loadUserMap() {
    if (!state.isAdminPage) return state.userMap;
    if (state.userMap.size)  return state.userMap;
    try {
      const { data, error } = await client.from('users').select('id, full_name, display_name, email, role');
      if (error) throw error;
      const map = new Map();
      (data || []).forEach(u => map.set(u.id, u));
      state.userMap = map;
      return map;
    } catch (err) {
      console.warn('[jlpt-sync] loadUserMap failed:', err?.message || err);
      return state.userMap;
    }
  }

  // ── FIX 4: loadSystemSettings – exam_live_enabled logic was inverted ─────────
  async function loadSystemSettings() {
    try {
      const { data, error } = await client.from('system_settings').select('*');
      if (error) throw error;
      const rows = Array.isArray(data) ? data : [];
      const map  = Object.fromEntries(rows.map(r => [String(r.key || '').toLowerCase(), String(r.value ?? '')]));

      state.settings.exam_locked      = toBool(map.exam_locked);
      state.settings.exam_lock_reason = map.exam_lock_reason || '';

      // FIX: was `!toBool(v) || v === 'true'` which always returned true when v='false'
      const rawLive = String(map.exam_live_enabled ?? 'true').toLowerCase();
      state.settings.exam_live_enabled = !['0', 'false', 'no', 'off'].includes(rawLive);

      // updated_at: read from the exam_locked row specifically, not row[0]
      const lockedRow = rows.find(r => r.key === 'exam_locked');
      state.settings.updated_at  = lockedRow?.updated_at  || state.settings.updated_at;
      state.settings.updated_by  = lockedRow?.updated_by  || state.settings.updated_by;
      return state.settings;
    } catch (err) {
      console.warn('[jlpt-sync] loadSystemSettings failed:', err?.message || err);
      return state.settings;
    }
  }

  async function loadExamLocks(force = false) {
    if (!force && state.examLocks.size) return state.examLocks;
    try {
      const { data, error } = await client
        .from('exam_settings')
        .select('exam_key,title,level,locked,lock_reason,updated_at,updated_by');
      if (error) throw error;
      const map = new Map();
      (data || []).forEach(row => map.set(String(row.exam_key || '').toLowerCase(), row));
      state.examLocks = map;
      return map;
    } catch (err) {
      console.warn('[jlpt-sync] loadExamLocks failed:', err?.message || err);
      return state.examLocks;
    }
  }

  async function loadCurrentExamLock() {
    const meta = examMetaFromPath();
    if (!meta.key) return null;
    const map  = await loadExamLocks(true);
    return map.get(meta.key) || null;
  }

  // ── Write helpers ────────────────────────────────────────────────────────────
  async function setSystemSetting(key, value) {
    const ctx = await getContext();
    if (!ctx?.isAdmin) { toast('⛔ Admin only'); return false; }
    try {
      const payload = {
        key,
        value:      String(value ?? ''),
        updated_at: new Date().toISOString(),
        updated_by: ctx.session.user.id,
      };
      const { error } = await client.from('system_settings').upsert(payload, { onConflict: 'key' });
      if (error) throw error;
      return true;
    } catch (err) {
      console.error('[jlpt-sync] setSystemSetting failed:', err);
      // Show a helpful message with the actual Supabase error
      const hint = err?.message?.includes('violates row-level security')
        ? '⚠️ RLS blocked write – jalankan SQL schema terbaru di Supabase'
        : `⚠️ Gagal simpan setting: ${err?.message || err}`;
      toast(hint);
      return false;
    }
  }

  // ── FIX 5: setGlobalLock – no longer shows success toast when write failed ───
  async function setGlobalLock(locked, reason = '') {
    const ctx = await getContext();
    if (!ctx?.isAdmin) { toast('⛔ Admin only'); return false; }

    const ok1 = await setSystemSetting('exam_locked',      locked ? 'true' : 'false');
    const ok2 = await setSystemSetting('exam_lock_reason', reason || '');

    // Re-read state and refresh UI once (instead of twice inside setSystemSetting)
    await loadSystemSettings();
    renderIndexLockUI();
    renderAdminControlUI();
    await refreshAdminPanels();

    if (ok1) {
      toast(locked ? '🔒 Semua exam dikunci' : '🔓 Semua exam dibuka');
    }
    return ok1;
  }

  async function setExamLock(examKey, locked, reason = '') {
    const ctx = await getContext();
    if (!ctx?.isAdmin) { toast('⛔ Admin only'); return false; }
    const key = String(examKey || '').toLowerCase();
    if (!key) return false;
    try {
      const row         = state.examLocks.get(key) || {};
      const catalogEntry = !row.title ? getExamCatalog().find(e => e.key === key) : null;
      const payload = {
        exam_key:    key,
        title:       row.title       || catalogEntry?.title || '',
        level:       row.level       || catalogEntry?.level || '',
        locked:      !!locked,
        lock_reason: reason ?? row.lock_reason ?? '',
        updated_at:  new Date().toISOString(),
        updated_by:  ctx.session.user.id,
      };
      const { error } = await client.from('exam_settings').upsert(payload, { onConflict: 'exam_key' });
      if (error) throw error;
      await loadExamLocks(true);
      renderIndexLockUI();
      renderAdminControlUI();
      return true;
    } catch (err) {
      console.error('[jlpt-sync] setExamLock failed:', err);
      const hint = err?.message?.includes('violates row-level security')
        ? '⚠️ RLS blocked exam-lock write – jalankan SQL schema terbaru di Supabase'
        : `⚠️ Gagal menyimpan lock ujian: ${err?.message || err}`;
      toast(hint);
      return false;
    }
  }

  async function setMultipleExamLocks(examKeys, locked, reason = '') {
    const keys = Array.from(new Set((examKeys || [])
      .map(k => String(k || '').toLowerCase()).filter(Boolean)));
    if (!keys.length) { toast('Pilih minimal satu ujian'); return false; }
    let ok = 0;
    for (const key of keys) {
      if (await setExamLock(key, locked, reason)) ok++;
    }
    if (ok) {
      toast(`${locked ? '🔒' : '🔓'} ${ok} ujian diperbarui`);
      await refreshAdminPanels();
    } else {
      toast('⚠️ Tidak ada ujian yang berubah');
    }
    return ok > 0;
  }

  // ── Exam session ─────────────────────────────────────────────────────────────
  function questionGroups() {
    return [
      { label: '文字・語彙', key: 'moji',   aliases: ['文字・語彙', '文字', '語彙'] },
      { label: '文法',       key: 'bunpou', aliases: ['文法'] },
      { label: '読解',       key: 'dokkai', aliases: ['読解'] },
    ];
  }

  function sectionKeyFromLabel(sec = '') {
    const s = String(sec || '');
    if (s.includes('文字') || s.includes('語彙')) return 'moji';
    if (s.includes('文法'))                       return 'bunpou';
    if (s.includes('読解'))                       return 'dokkai';
    return 'other';
  }

  function computeStats() {
    const qs       = Array.isArray(window.questions) ? window.questions : [];
    const ans      = window.answers && typeof window.answers === 'object' ? window.answers : {};
    const answered = Object.keys(ans).length;
    const correct  = Object.values(ans).filter(a => a?.correct).length;
    const total    = qs.length || Number(window.totalQuestions || 0) || 0;
    const wrong    = Math.max(answered - correct, 0);
    const percent  = total ? Math.round((correct / total) * 10000) / 100 : 0;
    const sectionScores = {};
    for (const g of questionGroups()) {
      const items = qs.filter(q => sectionKeyFromLabel(q.sec) === g.key);
      const crt   = items.filter(q => ans[q.id]?.correct).length;
      sectionScores[g.key] = {
        label: g.label, correct: crt, total: items.length,
        percentage: items.length ? Math.round((crt / items.length) * 10000) / 100 : 0,
      };
    }
    return { answered, correct, wrong, total, percent, sectionScores };
  }

  function remainingSeconds() {
    const startTime    = Number(window.startTime    || 0);
    const totalSeconds = Number(window.totalSeconds || 0);
    if (!startTime || !totalSeconds) return null;
    return Math.max(totalSeconds - Math.floor((Date.now() - startTime) / 1000), 0);
  }

  function buildSnapshot(eventName = 'heartbeat', done = false) {
    const meta  = examMetaFromPath();
    const stats = computeStats();
    const rem   = remainingSeconds();
    const now   = new Date().toISOString();
    const startedAt = window.__JLPT_SESSION_STARTED_AT__ || window.startTimeISO || null;
    return {
      exam_key:         meta.key,
      exam_title:       meta.title,
      level:            meta.level,
      year:             meta.year   ? Number(meta.year)   : null,
      month:            meta.month  || null,
      mode:             window.mode || window.currentMode || 'all',
      started_at:       startedAt || now,
      updated_at:       now,
      last_seen_at:     now,
      current_question: Number(window.currentQ ?? 0) + 1,
      total_questions:  Number(stats.total || 0),
      timer_remaining:  rem,
      answers:          window.answers && typeof window.answers === 'object' ? window.answers : {},
      score:            stats.correct,
      correct_count:    stats.correct,
      wrong_count:      done ? Math.max(Number(stats.total || 0) - stats.correct, 0) : stats.wrong,
      percentage:       stats.percent,
      section_scores:   stats.sectionScores,
      completed:        !!done,
      completed_at:     done ? now : null,
      status:           done ? 'done' : (state.examRunning ? 'active' : 'idle'),
      last_event:       eventName,
    };
  }

  function buildLivePayload(snapshot) {
    return {
      exam_key:         snapshot.exam_key,
      exam_title:       snapshot.exam_title,
      level:            snapshot.level,
      year:             snapshot.year,
      month:            snapshot.month,
      mode:             snapshot.mode,
      status:           snapshot.status,
      current_q:        snapshot.current_question,
      total_q:          snapshot.total_questions,
      answered_count:   Object.keys(snapshot.answers || {}).length,
      correct_count:    snapshot.correct_count,
      wrong_count:      snapshot.wrong_count,
      percentage:       snapshot.percentage,
      remaining_seconds: snapshot.timer_remaining,
      last_event:       snapshot.last_event,
      client_time:      snapshot.updated_at,
      updated_at:       snapshot.updated_at,
    };
  }

  async function ensureServerSession() {
    const ctx = await getContext();
    if (!ctx || ctx.isAdmin || !state.isExamPage) return null;
    const snapshot = buildSnapshot('prime', false);
    try {
      const { data, error } = await client
        .from('exam_sessions')
        .select('*')
        .eq('user_id', ctx.session.user.id)
        .eq('exam_key', snapshot.exam_key)
        .maybeSingle();
      if (error && String(error.message || '').toLowerCase().includes('row-level security')) return null;
      if (!error && data) {
        window.__JLPT_SESSION_STARTED_AT__ = data.started_at || snapshot.started_at;
        return data;
      }
      // Insert initial row
      const { error: insErr } = await client.from('exam_sessions').insert({
        user_id:         ctx.session.user.id,
        ...snapshot,
        timer_remaining: snapshot.timer_remaining,
      });
      if (insErr) console.warn('[jlpt-sync] ensureServerSession insert error:', insErr?.message);
      return null;
    } catch (err) {
      console.warn('[jlpt-sync] ensureServerSession failed:', err?.message || err);
      return null;
    }
  }

  async function syncSession(eventName = 'heartbeat', done = false, force = false) {
    const ctx = await getContext();
    if (!ctx || ctx.isAdmin || !state.settings.exam_live_enabled) return false;

    const snapshot = buildSnapshot(eventName, done);
    const hash = JSON.stringify({
      k: snapshot.exam_key, q: snapshot.current_question,
      a: snapshot.answers,  c: snapshot.correct_count,
      w: snapshot.wrong_count, p: snapshot.percentage,
      s: snapshot.status,   r: snapshot.timer_remaining,
      d: snapshot.completed, e: snapshot.last_event,
    });
    const now = Date.now();
    if (!force && state.lastProgressHash === hash && now - state.lastProgressSentAt < 4000) return true;
    state.lastProgressHash   = hash;
    state.lastProgressSentAt = now;

    try {
      const sessionPayload = {
        user_id:          ctx.session.user.id,
        exam_key:         snapshot.exam_key,
        exam_title:       snapshot.exam_title,
        level:            snapshot.level,
        year:             snapshot.year,
        month:            snapshot.month,
        mode:             snapshot.mode,
        started_at:       snapshot.started_at,
        updated_at:       snapshot.updated_at,
        last_seen_at:     snapshot.last_seen_at,
        answers:          snapshot.answers,
        current_question: snapshot.current_question,
        total_questions:  snapshot.total_questions,
        timer_remaining:  snapshot.timer_remaining,
        score:            snapshot.score,
        correct_count:    snapshot.correct_count,
        wrong_count:      snapshot.wrong_count,
        percentage:       snapshot.percentage,
        section_scores:   snapshot.section_scores,
        completed:        snapshot.completed,
        completed_at:     snapshot.completed_at,
        status:           snapshot.status,
        last_event:       snapshot.last_event,
      };

      const [progressRes, sessionRes] = await Promise.all([
        client.from('exam_progress').upsert({
          user_id: ctx.session.user.id,
          ...buildLivePayload(snapshot),
        }, { onConflict: 'user_id,exam_key' }),
        client.from('exam_sessions').upsert(sessionPayload, { onConflict: 'user_id,exam_key' }),
      ]);

      if (progressRes.error) {
        console.error('[jlpt-sync] exam_progress upsert error:', progressRes.error.message || progressRes.error);
        // Don't throw — try to still save the session
      }
      if (sessionRes.error) {
        console.error('[jlpt-sync] exam_sessions upsert error:', sessionRes.error.message || sessionRes.error);
        throw sessionRes.error;
      }
      return true;
    } catch (err) {
      console.error('[jlpt-sync] syncSession failed:', err?.message || err);
      return false;
    }
  }

  // ── Keyboard / tab guard ─────────────────────────────────────────────────────
  function blockExamShortcuts(e) {
    if (!state.isExamPage || !state.examRunning) return;
    const blocked     = new Set(['F5','F6','F7','F11','F12','PrintScreen']);
    const ctrlBlocked = new Set(['l','n','t','w','r','u','s','p','f','j','k','h','d','g']);
    if (
      blocked.has(e.key) ||
      ((e.ctrlKey || e.metaKey) && ctrlBlocked.has((e.key || '').toLowerCase())) ||
      ((e.ctrlKey || e.metaKey) && e.shiftKey) ||
      (e.altKey && ['ArrowLeft', 'ArrowRight'].includes(e.key))
    ) {
      e.preventDefault(); e.stopPropagation();
      toast('⛔ Navigasi diblokir saat ujian');
      return false;
    }
  }

  // ── Lock shield (shown to users when admin locks an exam) ────────────────────
  function showExamLockShield(reason = '') {
    if (!state.isExamPage) return;
    let shield = document.getElementById('jlpt-exam-lock-shield');
    if (!shield) {
      shield = document.createElement('div');
      shield.id = 'jlpt-exam-lock-shield';
      shield.style.cssText = 'position:fixed;inset:0;z-index:999999;background:rgba(5,9,16,.95);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:18px;text-align:center;';
      shield.innerHTML = `
        <div style="max-width:560px;background:#111a2f;border:1px solid rgba(255,95,115,.3);border-radius:24px;padding:28px 24px;box-shadow:0 25px 80px rgba(0,0,0,.6);">
          <div style="font-size:46px;margin-bottom:10px;">🔒</div>
          <div style="font-family:'Syne',sans-serif;font-size:22px;font-weight:800;margin-bottom:8px;color:#ff9aaa;">Ujian sedang dikunci</div>
          <div id="jlpt-lock-shield-text" style="font-size:14px;color:#aab8d8;line-height:1.8;">Admin belum membuka akses ujian ini.</div>
        </div>`;
      document.body.appendChild(shield);
    }
    const txt = shield.querySelector('#jlpt-lock-shield-text');
    if (txt) txt.textContent = reason || 'Admin belum membuka akses ujian ini.';
    shield.style.display = 'flex';
  }

  function hideExamLockShield() {
    const el = document.getElementById('jlpt-exam-lock-shield');
    if (el) el.remove();
  }

  function enforceLockState() {
    if (!state.isExamPage) return;
    const locked    = !!state.settings.exam_locked;
    const rowLocked = !!state.examLocks.get(examMetaFromPath().key)?.locked;
    const isLocked  = (locked || rowLocked) && !state.isAdmin;
    if (isLocked) {
      state.examRunning = false;
      showExamLockShield(state.settings.exam_lock_reason || state.examLocks.get(examMetaFromPath().key)?.lock_reason || '');
    } else {
      hideExamLockShield();
    }
  }

  // ── Fullscreen enforcement ───────────────────────────────────────────────────
  async function requestExamFullscreen() {
    try {
      const el = document.documentElement;
      if (document.fullscreenElement) return true;
      if (el.requestFullscreen)           await el.requestFullscreen();
      else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
      else if (el.msRequestFullscreen)     await el.msRequestFullscreen();
      return true;
    } catch (err) {
      console.warn('[jlpt-sync] Fullscreen request failed:', err?.message);
      return false;
    }
  }

  async function exitExamFullscreen() {
    try {
      if (!document.fullscreenElement) return;
      if (document.exitFullscreen)           await document.exitFullscreen();
      else if (document.webkitExitFullscreen) await document.webkitExitFullscreen();
      else if (document.msExitFullscreen)     await document.msExitFullscreen();
    } catch {}
  }

  function showFullscreenPrompt() {
    if (!state.isExamPage || state.isAdmin) return;
    let prompt = document.getElementById('jlpt-fullscreen-prompt');
    if (!prompt) {
      prompt = document.createElement('div');
      prompt.id = 'jlpt-fullscreen-prompt';
      prompt.style.cssText = 'position:fixed;inset:0;z-index:999998;background:rgba(5,9,16,.92);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:18px;text-align:center;';
      prompt.innerHTML = `
        <div style="max-width:480px;background:#111a2f;border:1px solid rgba(255,181,71,.3);border-radius:24px;padding:28px 24px;box-shadow:0 25px 80px rgba(0,0,0,.6);">
          <div style="font-size:42px;margin-bottom:10px;">🖥️</div>
          <div style="font-family:'Syne',sans-serif;font-size:20px;font-weight:800;margin-bottom:8px;color:#ffd18a;">Mode layar penuh diperlukan</div>
          <div style="font-size:14px;color:#aab8d8;line-height:1.8;margin-bottom:18px;">Ujian harus dikerjakan dalam mode layar penuh.</div>
          <button id="jlpt-fullscreen-resume-btn" style="padding:12px 22px;border-radius:14px;border:none;background:linear-gradient(135deg,#4a9eff,#6c3fff);color:#fff;font-weight:800;font-size:14px;cursor:pointer;font-family:inherit;">Lanjutkan Layar Penuh</button>
        </div>`;
      document.body.appendChild(prompt);
      prompt.querySelector('#jlpt-fullscreen-resume-btn')?.addEventListener('click', async () => {
        if (await requestExamFullscreen()) hideFullscreenPrompt();
      });
    }
    prompt.style.display = 'flex';
  }

  function hideFullscreenPrompt() {
    const el = document.getElementById('jlpt-fullscreen-prompt');
    if (el) el.style.display = 'none';
  }

  function installFullscreenGuard() {
    if (!state.isExamPage) return;
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && state.examRunning && !state.isAdmin) {
        showFullscreenPrompt(); syncSession('fullscreen_exit', false, true);
      } else if (document.fullscreenElement) {
        hideFullscreenPrompt();
      }
    });
  }

  function installExamGuards() {
    if (!state.isExamPage) return;
    document.addEventListener('keydown', blockExamShortcuts, true);
    document.addEventListener('contextmenu', e => { if (state.examRunning) e.preventDefault(); }, true);
    window.addEventListener('blur', () => { if (state.examRunning) syncSession('blur', false, true); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && state.examRunning) syncSession('hidden', false, true);
      if (document.visibilityState === 'visible' && state.examRunning) syncSession('visible', false, true);
    });
    window.addEventListener('beforeunload', e => {
      if (!state.examRunning) return;
      try { syncSession('beforeunload', false, true); } catch {}
      e.preventDefault(); e.returnValue = ''; return '';
    });
    installFullscreenGuard();
  }

  function wrapFunction(name, afterHook) {
    const original = window[name];
    if (typeof original !== 'function' || original.__jlptWrapped) return false;
    const wrapped = function (...args) {
      const result = original.apply(this, args);
      afterHook?.(result, args);
      return result;
    };
    wrapped.__jlptWrapped   = true;
    wrapped.__jlptOriginal  = original;
    window[name] = wrapped;
    return true;
  }

  function observeExamFunctions() {
    if (!state.isExamPage) return;
    const timer = setInterval(() => {
      if (typeof window.startMode === 'function' && !window.startMode.__jlptWrapped) {
        const original = window.startMode;
        const wrapped  = function (...args) {
          const curLock = !!state.settings.exam_locked || !!state.examLocks.get(examMetaFromPath().key)?.locked;
          if (curLock && !state.isAdmin) {
            showExamLockShield(state.settings.exam_lock_reason || '');
            toast('🔒 Ujian sedang dikunci admin');
            return;
          }
          state.examRunning = true;
          window.__JLPT_EXAM_FINISHED__         = false;
          window.__JLPT_SESSION_STARTED_AT__ = window.__JLPT_SESSION_STARTED_AT__ || new Date().toISOString();
          requestExamFullscreen();
          const result = original.apply(this, args);
          setTimeout(() => syncSession('start', false, true), 150);
          return result;
        };
        wrapped.__jlptWrapped = true; wrapped.__jlptOriginal = original;
        window.startMode = wrapped;
      }

      wrapFunction('selectAnswer',      () => setTimeout(() => syncSession('answer'),         160));
      wrapFunction('nextQ',             () => setTimeout(() => syncSession('next'),            120));
      wrapFunction('prevQ',             () => setTimeout(() => syncSession('prev'),            120));
      wrapFunction('saveSessionManual', () => setTimeout(() => syncSession('save', false, true), 80));
      wrapFunction('loadSessionManual', () => setTimeout(() => syncSession('load', false, true), 80));

      if (typeof window.finishQuiz === 'function' && !window.finishQuiz.__jlptWrapped) {
        const original = window.finishQuiz;
        const wrapped  = function (...args) {
          const result = original.apply(this, args);
          window.__JLPT_EXAM_FINISHED__ = true;
          state.examRunning = false;
          hideFullscreenPrompt(); exitExamFullscreen();
          setTimeout(() => syncSession('done', true, true), 180);
          return result;
        };
        wrapped.__jlptWrapped = true; wrapped.__jlptOriginal = original;
        window.finishQuiz = wrapped;
      }

      wrapFunction('goHome', () => {
        state.examRunning = false; hideFullscreenPrompt(); exitExamFullscreen();
        setTimeout(() => syncSession('home', false, true), 80);
      });
      wrapFunction('openReport',  () => setTimeout(() => syncSession('report_open',  false, true), 80));
      wrapFunction('closeReport', () => setTimeout(() => syncSession('report_close', false, true), 80));

      if (window.startMode?.__jlptWrapped && window.selectAnswer?.__jlptWrapped && window.finishQuiz?.__jlptWrapped) {
        clearInterval(timer);
      }
    }, 220);
    setTimeout(() => clearInterval(timer), 15000);
  }

  // ── Index page lock UI ───────────────────────────────────────────────────────
  function examKeyFromHref(href = '') {
    const s  = String(href || '').toLowerCase().replace(/\\/g, '/');
    const m  = s.match(/(\d{4})-(\d{2})-n([1-5])/i);
    if (m)  return `n${m[3]}-${m[1]}-${m[2]}`;
    const m2 = s.match(/n([1-5])-(\d{4})-(\d{2})/i);
    if (m2) return `n${m2[1]}-${m2[2]}-${m2[3]}`;
    const m3 = s.match(/(\d{4})-(\d{2})-jlpt/i);
    if (m3) {
      const lvl = s.match(/\/jlpt\/n([1-5])\//i) || s.match(/\/n([1-5])\//i);
      if (lvl) return `n${lvl[1]}-${m3[1]}-${m3[2]}`;
    }
    return '';
  }

  function ensureIndexBanner() {
    let banner = document.getElementById('jlpt-global-banner');
    if (banner) return banner;
    banner = document.createElement('div');
    banner.id = 'jlpt-global-banner';
    banner.style.cssText = 'display:none;margin:0 0 16px 0;padding:14px 16px;border-radius:18px;border:1px solid rgba(255,181,71,.28);background:rgba(255,181,71,.10);color:#ffd18a;font-size:13px;line-height:1.6;';
    banner.innerHTML = '<strong>🔒 Ujian sedang dikunci admin.</strong><br><span id="jlpt-global-banner-text">Tunggu persetujuan admin untuk membuka kembali ujian.</span>';
    const hero    = document.querySelector('.hero');
    const content = document.querySelector('.content') || document.body;
    if (hero?.parentNode) hero.insertAdjacentElement('afterend', banner);
    else content.prepend(banner);
    return banner;
  }

  function badgeForCard(card, text, color, background, borderColor) {
    let badge = card.querySelector('.jlpt-lock-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'jlpt-lock-badge';
      badge.style.cssText = 'position:absolute;top:16px;right:16px;padding:4px 10px;border-radius:999px;font-size:10px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;z-index:5;';
      card.appendChild(badge);
    }
    badge.textContent       = text;
    badge.style.color       = color;
    badge.style.background  = background;
    badge.style.border      = `1px solid ${borderColor || color}`;
  }

  function setCardLockedState(card, locked) {
    if (!card) return;
    card.dataset.jlptLocked = locked ? '1' : '';
    card.style.opacity      = locked ? '0.72' : '';
    card.style.filter       = locked ? 'saturate(0.8)' : '';
    const btn = card.querySelector('.open-btn');
    if (btn) {
      if (locked) {
        btn.setAttribute('aria-disabled', 'true');
        btn.style.pointerEvents = 'none'; btn.style.opacity = '0.5';
        btn.style.filter = 'grayscale(0.25)'; btn.title = 'Ujian sedang dikunci admin';
        btn.onclick = e => { e.preventDefault(); e.stopPropagation(); toast('🔒 Ujian ini sedang dikunci admin'); return false; };
      } else {
        btn.removeAttribute('aria-disabled');
        btn.style.pointerEvents = ''; btn.style.opacity = ''; btn.style.filter = ''; btn.title = '';
        btn.onclick = function () { if (typeof window.recordExamOpen === 'function') window.recordExamOpen(this); };
      }
    }
    badgeForCard(card,
      locked ? 'Locked' : 'Open',
      locked ? '#ff9aaa' : '#5ff0b0',
      locked ? 'rgba(255,95,115,.12)' : 'rgba(25,195,125,.12)',
      locked ? 'rgba(255,95,115,.30)' : 'rgba(25,195,125,.30)'
    );
  }

  async function renderIndexLockUI() {
    if (!state.isIndexPage) return;
    await loadSystemSettings(); await loadExamLocks(true);
    const banner      = ensureIndexBanner();
    const globalLocked = !!state.settings.exam_locked && !state.isAdmin;
    const lockedCount  = Array.from(state.examLocks.values()).filter(r => !!r.locked).length;
    banner.style.display = (globalLocked || lockedCount > 0) ? 'block' : 'none';
    const txt = banner.querySelector('#jlpt-global-banner-text');
    if (txt) {
      if (globalLocked)      txt.textContent = state.settings.exam_lock_reason || 'Semua ujian sedang dikunci admin.';
      else if (lockedCount)  txt.textContent = `${lockedCount} ujian sedang dikunci admin. Ujian lain tetap dapat dibuka.`;
    }
    document.querySelectorAll('.card[data-examkey], .card[data-name]').forEach(card => {
      const key    = String(card.dataset.examkey || card.dataset.name || '').toLowerCase();
      const row    = state.examLocks.get(key);
      const locked = (!!state.settings.exam_locked || !!row?.locked) && !state.isAdmin;
      setCardLockedState(card, locked);
    });
    document.querySelectorAll('.open-btn').forEach(link => {
      const key    = examKeyFromHref(link.getAttribute('href') || '');
      const row    = state.examLocks.get(key);
      const locked = (!!state.settings.exam_locked || !!row?.locked) && !state.isAdmin;
      setCardLockedState(link.closest('.card'), locked);
    });
  }

  // ── Admin panel ──────────────────────────────────────────────────────────────
  function getExamCatalog() {
    const catalog = [];
    if (Array.isArray(window._examList) && window._examList.length) {
      window._examList.forEach(e => catalog.push({
        key:   String(e.key   || '').toLowerCase(),
        level: String(e.level || '').toUpperCase(),
        year:  e.year  || '',
        title: e.title || '',
        href:  e.href  || '',
        isNew: !!e.isNew,
      }));
    }
    if (!catalog.length) {
      document.querySelectorAll('.exam-card-admin').forEach(card => {
        const title = card.querySelector('.eca-title')?.textContent?.trim() || '';
        const level = card.querySelector('.eca-level')?.textContent?.trim() || '';
        const year  = card.querySelector('.eca-year') ?.textContent?.trim() || '';
        const href  = card.querySelector('.eca-path') ?.textContent?.trim() || '';
        const key   = card.dataset.examkey || examKeyFromHref(href) || '';
        catalog.push({ key: String(key).toLowerCase(), level, year, title, href, isNew: false });
      });
    }
    return catalog.filter((x, i, arr) => x.key && arr.findIndex(y => y.key === x.key) === i);
  }

  // ── FIX 6: refreshAdminLivePanel – always calls ensureAdminPanel() first ─────
  async function refreshAdminLivePanel() {
    if (!state.isAdminPage) return;
    ensureAdminPanel();   // Guarantee DOM elements exist before querying
    await loadUserMap();

    const tbody      = document.getElementById('jlpt-live-table');
    const count      = document.getElementById('jlpt-live-count');
    const countBadge = document.getElementById('jlpt-live-count-badge');

    if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="padding:16px;color:var(--muted);">Memuat data sesi...</td></tr>';

    try {
      const [progressRes, sessionRes] = await Promise.all([
        client.from('exam_progress').select('*').order('updated_at', { ascending: false }).limit(100),
        client.from('exam_sessions').select('*').order('updated_at', { ascending: false }).limit(100),
      ]);
      if (progressRes.error) throw progressRes.error;
      if (sessionRes.error)  throw sessionRes.error;

      const mergedMap = new Map();
      (Array.isArray(sessionRes.data) ? sessionRes.data : []).forEach(row => {
        mergedMap.set(`${row.user_id}::${row.exam_key}`, {
          user_id: row.user_id, exam_key: row.exam_key,
          exam_title: row.exam_title || '', level: row.level || '', mode: row.mode || 'all',
          status: row.completed ? 'done' : (row.status || 'active'),
          current_q:    row.current_question  || 0,
          total_q:      row.total_questions   || 0,
          answered_count: Object.keys(row.answers || {}).length,
          correct_count: row.correct_count  || 0, wrong_count: row.wrong_count || 0,
          percentage:    row.percentage     || 0,
          remaining_seconds: row.timer_remaining ?? null,
          updated_at: row.updated_at || row.last_seen_at || row.started_at,
        });
      });
      (Array.isArray(progressRes.data) ? progressRes.data : []).forEach(row => {
        mergedMap.set(`${row.user_id}::${row.exam_key}`, {
          user_id: row.user_id, exam_key: row.exam_key,
          exam_title: row.exam_title || '', level: row.level || '', mode: row.mode || 'all',
          status: row.status || 'active',
          current_q: row.current_q || 0, total_q: row.total_q || 0,
          answered_count: row.answered_count || 0,
          correct_count: row.correct_count || 0, wrong_count: row.wrong_count || 0,
          percentage: row.percentage || 0,
          remaining_seconds: row.remaining_seconds ?? null,
          updated_at: row.updated_at || row.client_time,
        });
      });

      const rows        = Array.from(mergedMap.values()).sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));

      // Apply time filter
      const cutoff = getTimeFilterCutoff(state.liveTimeFilter || 'all');
      const filtered = cutoff
        ? rows.filter(r => r.updated_at && new Date(r.updated_at).getTime() >= cutoff)
        : rows;

      const activeCount = filtered.filter(r => String(r.status || '').toLowerCase() === 'active').length;
      const summary     = `${activeCount} active / ${filtered.length} session${cutoff ? ` (${state.liveTimeFilter})` : ''}`;
      if (count)      count.textContent      = summary;
      if (countBadge) countBadge.textContent = summary;

      // Highlight active filter button
      document.querySelectorAll('.jlpt-live-time-btn').forEach(btn => {
        const isActive = btn.dataset.liveFilter === (state.liveTimeFilter || 'all');
        btn.style.background  = isActive ? 'rgba(74,158,255,.18)' : '';
        btn.style.borderColor = isActive ? 'rgba(74,158,255,.5)'  : '';
        btn.style.color       = isActive ? '#7cc0ff'              : '';
      });

      if (!tbody) { console.warn('[jlpt-sync] #jlpt-live-table not found in DOM'); return; }
      if (!filtered.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="padding:16px;color:var(--muted);">Belum ada sesi yang tersinkron dalam rentang waktu ini.</td></tr>';
        return;
      }
      tbody.innerHTML = filtered.map(row => {
        const user      = state.userMap.get(row.user_id) || {};
        const userLabel = user.display_name || user.full_name || user.email || row.user_id || '—';
        const status    = String(row.status || 'active');
        const badgeColor = status === 'done' ? '#5ff0b0' : status === 'active' ? '#7cc0ff' : '#ffd18a';
        const progress   = `${Number(row.current_q || 0)}/${Number(row.total_q || 0) || '—'} · ${Number(row.correct_count || 0)} benar · ${Number(row.percentage || 0).toFixed(2)}%`;
        return `<tr>
          <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);">
            <div style="font-weight:700;">${esc(userLabel)}</div>
            <div style="font-size:11px;color:var(--muted);">${esc(row.user_id || '')}</div>
          </td>
          <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);">
            <div style="font-weight:700;">${esc(row.exam_title || row.exam_key || '—')}</div>
            <div style="font-size:11px;color:var(--muted);">${esc(`${row.level || ''} ${row.mode || ''}`.trim())}</div>
          </td>
          <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);">
            <span style="padding:4px 10px;border-radius:999px;font-size:11px;font-weight:800;border:1px solid rgba(255,255,255,.12);color:${badgeColor};background:rgba(255,255,255,.04);text-transform:uppercase;">${esc(status)}</span>
            <div style="font-size:12px;color:var(--muted);margin-top:6px;">${esc(progress)}</div>
          </td>
          <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);font-weight:700;">${esc(fmtSec(row.remaining_seconds))}</td>
          <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);font-size:12px;color:var(--muted);">${esc(fmtTime(row.updated_at))}</td>
          <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);">
            <button type="button" class="act-btn delete" data-session-delete="1" data-user-id="${esc(row.user_id)}" data-exam-key="${esc(row.exam_key)}">🗑️ Delete</button>
          </td>
        </tr>`;
      }).join('');
    } catch (err) {
      console.error('[jlpt-sync] refreshAdminLivePanel failed:', err?.message || err);
      if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="padding:16px;color:#ff9aaa;">Gagal memuat live view: ${esc(err?.message || String(err))}</td></tr>`;
    }
  }

  async function refreshAdminResultsPanel() {
    if (!state.isAdminPage) return;
    ensureAdminPanel();   // Guarantee DOM elements exist
    await loadUserMap();

    const tbody      = document.getElementById('jlpt-results-table');
    const count      = document.getElementById('jlpt-results-count');
    const countBadge = document.getElementById('jlpt-results-count-badge');

    if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="padding:16px;color:var(--muted);">Memuat hasil ujian...</td></tr>';

    try {
      const { data, error } = await client
        .from('exam_sessions')
        .select('*')
        .or('completed.eq.true,status.neq.idle')
        .order('updated_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      const rows = Array.isArray(data) ? data : [];
      state.resultsCache = rows;

      // Apply time filter
      const resCutoff = getTimeFilterCutoff(state.resultsTimeFilter || 'all');
      const filteredRows = resCutoff
        ? rows.filter(r => {
            const ts = r.completed_at || r.updated_at;
            return ts && new Date(ts).getTime() >= resCutoff;
          })
        : rows;

      // Highlight active results filter button
      document.querySelectorAll('.jlpt-results-time-btn').forEach(btn => {
        const isActive = btn.dataset.resultsFilter === (state.resultsTimeFilter || 'all');
        btn.style.background  = isActive ? 'rgba(74,158,255,.18)' : '';
        btn.style.borderColor = isActive ? 'rgba(74,158,255,.5)'  : '';
        btn.style.color       = isActive ? '#7cc0ff'              : '';
      });

      if (count)      count.textContent      = `${filteredRows.length} session${resCutoff ? ` (${state.resultsTimeFilter})` : ''}`;
      if (countBadge) countBadge.textContent = `${filteredRows.length} session`;

      if (!tbody) { console.warn('[jlpt-sync] #jlpt-results-table not found in DOM'); return; }
      if (!filteredRows.length) {
        tbody.innerHTML = '<tr><td colspan="9" style="padding:16px;color:var(--muted);">Belum ada hasil ujian dalam rentang waktu ini.</td></tr>';
        return;
      }
      tbody.innerHTML = filteredRows.map(row => {
        const user  = state.userMap.get(row.user_id) || {};
        const label = user.display_name || user.full_name || user.email || row.user_id || '—';
        const pct   = Number(row.percentage || 0);
        const sec   = row.section_scores || {};
        const moji  = sec.moji?.percentage   ?? '—';
        const bun   = sec.bunpou?.percentage ?? '—';
        const dok   = sec.dokkai?.percentage ?? '—';
        return `<tr>
          <td style="padding:10px 14px;border-top:1px solid rgba(255,255,255,.04);">
            <input type="checkbox" class="jlpt-row-check" data-user-id="${esc(row.user_id)}" data-exam-key="${esc(row.exam_key)}">
          </td>
          <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);font-weight:700;">${esc(label)}</td>
          <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);">${esc(row.exam_title || row.exam_key || '—')}</td>
          <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);font-family:'JetBrains Mono',monospace;">${esc(row.score ?? 0)}</td>
          <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);font-weight:700;">${esc(String(pct.toFixed ? pct.toFixed(2) : pct))}%</td>
          <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);">${esc(`${moji}% / ${bun}% / ${dok}%`)}</td>
          <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);font-size:12px;color:var(--muted);">${esc(fmtTime(row.started_at))}</td>
          <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);font-size:12px;color:var(--muted);">${esc(fmtTime(row.completed_at || row.updated_at))}</td>
          <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);">
            <button type="button" class="act-btn delete" data-session-delete="1" data-user-id="${esc(row.user_id)}" data-exam-key="${esc(row.exam_key)}">🗑️</button>
          </td>
        </tr>`;
      }).join('');
    } catch (err) {
      console.error('[jlpt-sync] refreshAdminResultsPanel failed:', err?.message || err);
      if (tbody) tbody.innerHTML = `<tr><td colspan="8" style="padding:16px;color:#ff9aaa;">Gagal memuat hasil: ${esc(err?.message || String(err))}</td></tr>`;
    }
  }

  async function refreshAdminPanels() {
    if (!state.isAdminPage) return;
    await loadSystemSettings();
    await loadExamLocks(true);
    await refreshAdminLivePanel();
    await refreshAdminResultsPanel();
    renderAdminControlUI();
  }

  // ── ensureAdminPanel – build admin HTML into mount points once ───────────────
  function ensureAdminPanel() {
    if (document.getElementById('jlpt-sync-admin-wrap')) return document.getElementById('jlpt-sync-admin-wrap');

    const lockMount    = document.getElementById('jlpt-examlock-mount');
    const liveMount    = document.getElementById('jlpt-livemonitor-mount');
    const resultsMount = document.getElementById('jlpt-examresults-mount');
    const usingFallback = !lockMount && !liveMount && !resultsMount;
    const fallbackMount = document.getElementById('pane-dashboard') || document.querySelector('.content') || document.body;

    const wrap = document.createElement('div');
    wrap.id = 'jlpt-sync-admin-wrap';
    wrap.style.cssText = 'display:none;';

    const lockHtml = `
      <div style="display:grid;gap:16px;">
        <div id="jlpt-admin-global-card" style="background:var(--card);border:1px solid var(--border);border-radius:20px;padding:20px;">
          <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:14px;">
            <div>
              <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:800;margin-bottom:4px;">🔐 Kontrol Ujian Global</div>
              <div style="font-size:13px;color:var(--muted);line-height:1.6;">Lock / unlock semua exam dari sini.</div>
            </div>
            <div id="jlpt-lock-pill" style="padding:8px 12px;border-radius:999px;font-size:12px;font-weight:800;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);">Memuat...</div>
          </div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;">
            <button id="jlpt-lock-btn" class="topbar-btn" style="border-color:rgba(255,95,115,.35);color:#ff9aaa;background:rgba(255,95,115,.08);">🔒 Lock All Exam</button>
            <button id="jlpt-unlock-btn" class="topbar-btn primary">🔓 Unlock All Exam</button>
            <button id="jlpt-refresh-btn" class="topbar-btn">🔄 Refresh</button>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;">
            <div style="padding:12px 14px;border:1px solid var(--border);border-radius:14px;background:rgba(255,255,255,.03);">
              <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px;">Status Global</div>
              <div id="jlpt-lock-state" style="font-size:15px;font-weight:800;">—</div>
            </div>
            <div style="padding:12px 14px;border:1px solid var(--border);border-radius:14px;background:rgba(255,255,255,.03);">
              <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px;">Di-update</div>
              <div id="jlpt-lock-updated" style="font-size:15px;font-weight:800;">—</div>
            </div>
            <div style="padding:12px 14px;border:1px solid var(--border);border-radius:14px;background:rgba(255,255,255,.03);">
              <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px;">Active Sessions</div>
              <div id="jlpt-live-count" style="font-size:15px;font-weight:800;">—</div>
            </div>
            <div style="padding:12px 14px;border:1px solid var(--border);border-radius:14px;background:rgba(255,255,255,.03);">
              <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px;">Finished Results</div>
              <div id="jlpt-results-count" style="font-size:15px;font-weight:800;">—</div>
            </div>
          </div>
        </div>

        <div id="jlpt-exam-lock-card" style="background:var(--card);border:1px solid var(--border);border-radius:20px;padding:20px;">
          <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:14px;">
            <div>
              <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:800;margin-bottom:4px;">🧩 Lock / Unlock Per Exam</div>
              <div style="font-size:13px;color:var(--muted);line-height:1.6;">Centang satu atau beberapa ujian, lalu pilih Lock/Unlock.</div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button id="jlpt-select-all-exams" class="topbar-btn">☑️ Pilih Semua</button>
              <button id="jlpt-lock-selected"    class="topbar-btn" style="border-color:rgba(255,95,115,.35);color:#ff9aaa;background:rgba(255,95,115,.08);">🔒 Lock Selected</button>
              <button id="jlpt-unlock-selected"  class="topbar-btn primary">🔓 Unlock Selected</button>
              <button id="jlpt-refresh-locks"    class="topbar-btn">🔄 Reload List</button>
            </div>
          </div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;">
            <input id="jlpt-exam-search" placeholder="Cari exam..." style="flex:1;min-width:220px;background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:12px;padding:11px 14px;color:var(--text);font-family:inherit;font-size:14px;outline:none;">
            <select id="jlpt-exam-level" style="background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:12px;padding:11px 14px;color:var(--text);font-family:inherit;font-size:14px;outline:none;">
              <option value="">All Levels</option>
              <option value="N1">N1</option><option value="N2">N2</option>
              <option value="N3">N3</option><option value="N4">N4</option><option value="N5">N5</option>
            </select>
          </div>
          <div id="jlpt-exam-lock-list" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;"></div>
        </div>
      </div>`;

    const liveHtml = `
      <div id="jlpt-admin-live-card" style="background:var(--card);border:1px solid var(--border);border-radius:20px;overflow:hidden;">
        <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center;padding:18px 20px;border-bottom:1px solid var(--border);">
          <div>
            <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:800;margin-bottom:4px;">🟢 Live Exam Monitor</div>
            <div style="font-size:13px;color:var(--muted);">Lihat user yang sedang ujian, progress, dan sisa waktu secara realtime.</div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
            <span id="jlpt-live-count-badge" style="padding:8px 12px;border-radius:999px;font-size:12px;font-weight:800;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);">— session</span>
            <button id="jlpt-refresh-live" class="topbar-btn">🔄 Refresh Live</button>
          </div>
        </div>
        <!-- Time Filter Bar -->
        <div style="display:flex;gap:6px;flex-wrap:wrap;padding:12px 18px;border-bottom:1px solid var(--border);background:rgba(255,255,255,.015);">
          <span style="font-size:11px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.06em;align-self:center;margin-right:4px;">Filter:</span>
          ${['all','15m','30m','1h','today','week','month'].map(f => {
            const label = {all:'Semua','15m':'15 mnt','30m':'30 mnt','1h':'1 jam',today:'Hari ini',week:'Minggu ini',month:'Bulan ini'}[f];
            return `<button class="jlpt-live-time-btn topbar-btn" data-live-filter="${f}" style="padding:6px 12px;font-size:12px;">${label}</button>`;
          }).join('')}
        </div>
        <div style="overflow:auto;">
          <table style="width:100%;border-collapse:collapse;">
            <thead style="background:rgba(255,255,255,.02);">
              <tr>
                <th style="text-align:left;padding:12px 14px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);">User</th>
                <th style="text-align:left;padding:12px 14px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);">Exam</th>
                <th style="text-align:left;padding:12px 14px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);">Progress</th>
                <th style="text-align:left;padding:12px 14px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);">Remaining</th>
                <th style="text-align:left;padding:12px 14px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);">Updated</th>
                <th style="text-align:left;padding:12px 14px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);">Aksi</th>
              </tr>
            </thead>
            <tbody id="jlpt-live-table">
              <tr><td colspan="6" style="padding:16px;color:var(--muted);">Memuat...</td></tr>
            </tbody>
          </table>
        </div>
      </div>`;

    const resultsHtml = `
      <div id="jlpt-admin-results-card" style="background:var(--card);border:1px solid var(--border);border-radius:20px;overflow:hidden;">
        <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center;padding:18px 20px;border-bottom:1px solid var(--border);">
          <div>
            <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:800;margin-bottom:4px;">📈 Exam Results</div>
            <div style="font-size:13px;color:var(--muted);">Hasil akhir user dan export ke Excel dengan detail per section.</div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
            <span id="jlpt-results-count-badge" style="padding:8px 12px;border-radius:999px;font-size:12px;font-weight:800;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);">— session</span>
            <button id="jlpt-export-selected-xlsx" class="topbar-btn" title="Export hanya user yang dicentang">☑️ Export Terpilih</button>
            <button id="jlpt-export-xlsx"    class="topbar-btn primary">📥 Export Semua</button>
            <button id="jlpt-refresh-results" class="topbar-btn">🔄 Refresh</button>
          </div>
        </div>
        <!-- Time Filter Bar -->
        <div style="display:flex;gap:6px;flex-wrap:wrap;padding:12px 18px;border-bottom:1px solid var(--border);background:rgba(255,255,255,.015);align-items:center;">
          <span style="font-size:11px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-right:4px;">Filter waktu:</span>
          ${['all','15m','30m','1h','today','week','month'].map(f => {
            const label = {all:'Semua','15m':'15 mnt','30m':'30 mnt','1h':'1 jam',today:'Hari ini',week:'Minggu ini',month:'Bulan ini'}[f];
            return `<button class="jlpt-results-time-btn topbar-btn" data-results-filter="${f}" style="padding:6px 12px;font-size:12px;">${label}</button>`;
          }).join('')}
          <span id="jlpt-results-selected-label" style="margin-left:auto;font-size:12px;color:var(--muted);"></span>
        </div>
        <div style="overflow:auto;">
          <table style="width:100%;border-collapse:collapse;">
            <thead style="background:rgba(255,255,255,.02);">
              <tr>
                <th style="padding:12px 14px;"><input type="checkbox" id="jlpt-results-check-all" title="Pilih semua"></th>
                <th style="text-align:left;padding:12px 14px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);">User</th>
                <th style="text-align:left;padding:12px 14px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);">Exam</th>
                <th style="text-align:left;padding:12px 14px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);">Score</th>
                <th style="text-align:left;padding:12px 14px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);">Percent</th>
                <th style="text-align:left;padding:12px 14px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);">Sections (M/B/D)</th>
                <th style="text-align:left;padding:12px 14px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);">Started</th>
                <th style="text-align:left;padding:12px 14px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);">Completed</th>
                <th style="text-align:left;padding:12px 14px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);">Aksi</th>
              </tr>
            </thead>
            <tbody id="jlpt-results-table">
              <tr><td colspan="9" style="padding:16px;color:var(--muted);">Memuat...</td></tr>
            </tbody>
          </table>
        </div>
      </div>`;

    if (usingFallback) {
      wrap.style.cssText = 'margin:18px 0 28px;display:grid;gap:16px;';
      wrap.innerHTML     = lockHtml + liveHtml + resultsHtml;
      fallbackMount.prepend(wrap);
    } else {
      document.body.appendChild(wrap);
      if (lockMount)    lockMount.innerHTML    = lockHtml;
      if (liveMount)    liveMount.innerHTML    = liveHtml;
      if (resultsMount) resultsMount.innerHTML = resultsHtml;
    }

    const root = usingFallback ? wrap : document;

    root.querySelector('#jlpt-lock-btn')?.addEventListener('click', async () => {
      const r = prompt('Alasan lock semua ujian (opsional):', state.settings.exam_lock_reason || '');
      if (r === null) return;  // User cancelled
      await setGlobalLock(true, r);
    });
    root.querySelector('#jlpt-unlock-btn')?.addEventListener('click', async () => {
      const r = prompt('Catatan unlock semua ujian (opsional):', '') ?? '';
      await setGlobalLock(false, r);
    });
    root.querySelector('#jlpt-refresh-btn')?.addEventListener('click',     () => refreshAdminPanels());
    root.querySelector('#jlpt-refresh-live')?.addEventListener('click',    () => refreshAdminLivePanel());
    root.querySelector('#jlpt-refresh-results')?.addEventListener('click', () => refreshAdminResultsPanel());
    root.querySelector('#jlpt-refresh-locks')?.addEventListener('click',   () => renderAdminControlUI());

    // Live time-filter buttons
    root.querySelectorAll('.jlpt-live-time-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        state.liveTimeFilter = btn.dataset.liveFilter || 'all';
        root.querySelectorAll('.jlpt-live-time-btn').forEach(b => {
          b.style.background    = b === btn ? 'rgba(74,158,255,.18)' : '';
          b.style.borderColor   = b === btn ? 'rgba(74,158,255,.5)'  : '';
          b.style.color         = b === btn ? '#7cc0ff'              : '';
        });
        refreshAdminLivePanel();
      });
    });

    // Results time-filter buttons
    root.querySelectorAll('.jlpt-results-time-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        state.resultsTimeFilter = btn.dataset.resultsFilter || 'all';
        root.querySelectorAll('.jlpt-results-time-btn').forEach(b => {
          b.style.background  = b === btn ? 'rgba(74,158,255,.18)' : '';
          b.style.borderColor = b === btn ? 'rgba(74,158,255,.5)'  : '';
          b.style.color       = b === btn ? '#7cc0ff'              : '';
        });
        refreshAdminResultsPanel();
      });
    });

    // Results: select-all checkbox
    root.querySelector('#jlpt-results-check-all')?.addEventListener('change', (e) => {
      root.querySelectorAll('.jlpt-row-check').forEach(cb => { cb.checked = e.target.checked; });
      updateResultsSelectionLabel(root);
    });

    // Export selected
    root.querySelector('#jlpt-export-selected-xlsx')?.addEventListener('click', async () => {
      const checked = Array.from(root.querySelectorAll('.jlpt-row-check:checked'))
        .map(cb => ({ user_id: cb.dataset.userId, exam_key: cb.dataset.examKey }));
      if (!checked.length) { toast('⚠️ Centang setidaknya satu baris dulu'); return; }
      await exportResultsExcel(checked);
    });
    root.querySelector('#jlpt-select-all-exams')?.addEventListener('click', () => {
      const boxes = root.querySelectorAll('.jlpt-lock-check');
      const all   = Array.from(boxes).every(b => b.checked);
      boxes.forEach(b => { b.checked = !all; });
    });
    root.querySelector('#jlpt-lock-selected')?.addEventListener('click', async () => {
      const keys = Array.from(root.querySelectorAll('.jlpt-lock-check:checked')).map(el => el.dataset.examKey);
      const r    = prompt('Alasan lock selected (opsional):', '') ?? '';
      await setMultipleExamLocks(keys, true, r);
    });
    root.querySelector('#jlpt-unlock-selected')?.addEventListener('click', async () => {
      const keys = Array.from(root.querySelectorAll('.jlpt-lock-check:checked')).map(el => el.dataset.examKey);
      const r    = prompt('Catatan unlock selected (opsional):', '') ?? '';
      await setMultipleExamLocks(keys, false, r);
    });
    root.querySelector('#jlpt-exam-search')?.addEventListener('input',  () => renderAdminControlUI());
    root.querySelector('#jlpt-exam-level')?.addEventListener('change',  () => renderAdminControlUI());
    root.querySelector('#jlpt-export-xlsx')?.addEventListener('click',  () => exportResultsExcel());

    bindAdminActionDelegates(root);
    bindAdminActionDelegates(document);

    bindAdminActionDelegates(wrap);
    bindAdminActionDelegates(document);

    // Row checkbox change → update label (delegated)
    document.addEventListener('change', e => {
      if (e.target.classList.contains('jlpt-row-check')) {
        const root2 = document.getElementById('jlpt-sync-admin-wrap') || document;
        updateResultsSelectionLabel(root2);
        // sync select-all state
        const all  = root2.querySelectorAll('.jlpt-row-check');
        const chk  = root2.querySelectorAll('.jlpt-row-check:checked');
        const allCb = root2.querySelector('#jlpt-results-check-all');
        if (allCb) allCb.checked = all.length > 0 && chk.length === all.length;
      }
    });

    state.adminPanelReady = true;
    return wrap;
  }

  function updateResultsSelectionLabel(root) {
    const checked = root.querySelectorAll('.jlpt-row-check:checked').length;
    const total   = root.querySelectorAll('.jlpt-row-check').length;
    const lbl     = root.querySelector('#jlpt-results-selected-label');
    if (lbl) lbl.textContent = checked > 0 ? `${checked} dari ${total} dipilih` : '';
  }

  function renderAdminControlUI() {
    if (!state.isAdminPage) return;
    ensureAdminPanel();

    const locked      = !!state.settings.exam_locked;
    const pill        = document.querySelector('#jlpt-lock-pill');
    const stateText   = document.querySelector('#jlpt-lock-state');
    const updatedText = document.querySelector('#jlpt-lock-updated');

    if (pill) {
      pill.textContent       = locked ? '🔒 LOCKED' : '🔓 UNLOCKED';
      pill.style.color       = locked ? '#ff9aaa'               : '#5ff0b0';
      pill.style.borderColor = locked ? 'rgba(255,95,115,.35)'  : 'rgba(25,195,125,.35)';
      pill.style.background  = locked ? 'rgba(255,95,115,.1)'   : 'rgba(25,195,125,.08)';
    }
    if (stateText)   stateText.textContent   = locked ? 'Semua ujian terkunci' : 'Semua ujian terbuka';
    if (updatedText) updatedText.textContent = state.settings.updated_at ? fmtTime(state.settings.updated_at) : '—';

    // Sync count badges from their source elements
    const liveCount    = document.querySelector('#jlpt-live-count');
    const resultsCount = document.querySelector('#jlpt-results-count');
    const liveBadge    = document.querySelector('#jlpt-live-count-badge');
    const resultsBadge = document.querySelector('#jlpt-results-count-badge');
    if (liveBadge    && liveCount)    liveBadge.textContent    = liveCount.textContent    || '— session';
    if (resultsBadge && resultsCount) resultsBadge.textContent = resultsCount.textContent || '— session';

    // Render per-exam lock list
    const search   = String(document.querySelector('#jlpt-exam-search')?.value || '').trim().toLowerCase();
    const level    = String(document.querySelector('#jlpt-exam-level')?.value  || '').trim().toUpperCase();
    const catalog  = getExamCatalog();
    const filtered = catalog.filter(e => {
      const ms = !search || `${e.key} ${e.title} ${e.level} ${e.year} ${e.href}`.toLowerCase().includes(search);
      const ml = !level  || String(e.level || '').toUpperCase() === level;
      return ms && ml;
    });

    const list = document.querySelector('#jlpt-exam-lock-list');
    if (list) {
      if (!filtered.length) {
        list.innerHTML = '<div style="grid-column:1/-1;padding:18px;color:var(--muted);border:1px dashed var(--border);border-radius:16px;">Tidak ada exam yang cocok. Scan soal terlebih dahulu di GitHub Config.</div>';
      } else {
        list.innerHTML = filtered.map(e => {
          const row       = state.examLocks.get(String(e.key).toLowerCase());
          const rowLocked = !!row?.locked;
          const updated   = row?.updated_at ? fmtTime(row.updated_at) : '—';
          return `
            <div style="background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:16px;padding:14px;">
              <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:10px;">
                <label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer;">
                  <input type="checkbox" class="jlpt-lock-check" data-exam-key="${esc(e.key)}" style="margin-top:3px;">
                  <div>
                    <div style="font-weight:800;font-size:14px;margin-bottom:4px;">${esc(e.title || e.key)}</div>
                    <div style="font-size:12px;color:var(--muted);">${esc(e.level || '')} · ${esc(e.year || '')} · ${esc(e.key)}</div>
                  </div>
                </label>
                <span style="padding:4px 10px;border-radius:999px;font-size:10px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;
                  border:1px solid ${rowLocked ? 'rgba(255,95,115,.3)' : 'rgba(25,195,125,.3)'};
                  color:${rowLocked ? '#ff9aaa' : '#5ff0b0'};
                  background:${rowLocked ? 'rgba(255,95,115,.12)' : 'rgba(25,195,125,.08)'};">
                  ${rowLocked ? 'LOCKED' : 'OPEN'}
                </span>
              </div>
              <div style="display:flex;gap:8px;flex-wrap:wrap;">
                <button class="act-btn ban"     onclick="window.JLPT_SYNC?.setExamLock('${esc(e.key)}', true)">🔒 Lock</button>
                <button class="act-btn approve" onclick="window.JLPT_SYNC?.setExamLock('${esc(e.key)}', false)">🔓 Unlock</button>
              </div>
              <div style="font-size:11px;color:var(--muted);margin-top:10px;">Updated: ${esc(updated)}</div>
            </div>`;
        }).join('');
      }
    }
  }

  // ── Index page: update exam card score after completion ────────────────────
  function updateExamCardScore(examKey, score, percentage) {
    if (!examKey) return;
    const key = String(examKey).toLowerCase();
    document.querySelectorAll('.card[data-examkey]').forEach(card => {
      if (String(card.dataset.examkey || '').toLowerCase() !== key) return;
      let scoreBadge = card.querySelector('.jlpt-score-badge');
      if (!scoreBadge) {
        scoreBadge = document.createElement('div');
        scoreBadge.className = 'jlpt-score-badge';
        scoreBadge.style.cssText = 'position:absolute;bottom:14px;left:14px;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:800;z-index:6;backdrop-filter:blur(4px);';
        card.appendChild(scoreBadge);
      }
      const pct = Number(percentage || 0);
      const pass = pct >= 60;
      scoreBadge.textContent  = `Skor: ${score ?? 0} (${pct.toFixed(0)}%)`;
      scoreBadge.style.background  = pass ? 'rgba(25,195,125,.22)' : 'rgba(255,79,109,.22)';
      scoreBadge.style.border      = `1px solid ${pass ? 'rgba(25,195,125,.5)' : 'rgba(255,79,109,.5)'}`;
      scoreBadge.style.color       = pass ? '#5ff0b0' : '#ff9aaa';
    });
  }

  // ── Realtime subscriptions ───────────────────────────────────────────────────
  function subscribeRealtime() {
    try {
      if (state.settingsChannel) client.removeChannel(state.settingsChannel);
      if (state.progressChannel) client.removeChannel(state.progressChannel);
      if (state.lockChannel)     client.removeChannel(state.lockChannel);
    } catch {}

    state.settingsChannel = client
      .channel('jlpt-system-settings-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'system_settings' }, async () => {
        await loadSystemSettings(); renderIndexLockUI(); renderAdminControlUI(); enforceLockState();
      })
      .subscribe();

    state.lockChannel = client
      .channel('jlpt-exam-settings-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'exam_settings' }, async () => {
        await loadExamLocks(true); renderIndexLockUI(); renderAdminControlUI(); enforceLockState();
      })
      .subscribe();

    state.progressChannel = client
      .channel('jlpt-progress-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'exam_progress' }, async () => {
        if (state.isAdminPage) await refreshAdminLivePanel();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'exam_sessions' }, async (payload) => {
        if (state.isAdminPage) await refreshAdminResultsPanel();
        // Index page: update score badge if this is our own session finishing
        if (state.isIndexPage && state.session) {
          const row = payload.new || {};
          if (row.user_id === state.session.user.id && row.completed) {
            updateExamCardScore(row.exam_key, row.score, row.percentage);
          }
        }
      })
      .subscribe();

    // Index page: subscribe to notifications channel for this user
    if (state.isIndexPage && state.session) {
      const userId = state.session.user.id;
      client
        .channel('jlpt-user-notifs-' + userId)
        .on('postgres_changes', {
          event: 'INSERT', schema: 'public', table: 'notifications',
          filter: `user_id=eq.${userId}`
        }, payload => {
          // Dispatch to the page's own notification system
          if (typeof window.__jlptInjectNotif === 'function') {
            window.__jlptInjectNotif(payload.new);
          }
        })
        .subscribe();
    }
  }

  // ── XLSX export ──────────────────────────────────────────────────────────────
  async function loadXLSX() {
    if (window.XLSX) return window.XLSX;
    await new Promise((res, rej) => {
      const s  = document.createElement('script');
      s.src    = 'https://cdn.jsdelivr.net/npm/xlsx/dist/xlsx.full.min.js';
      s.onload = res; s.onerror = () => rej(new Error('Failed to load XLSX'));
      document.head.appendChild(s);
    });
    return window.XLSX;
  }

  function sectionSummaryFromRow(row) {
    const sec = row.section_scores || {};
    const get = k => (sec[k] && typeof sec[k].percentage !== 'undefined') ? sec[k].percentage : null;
    return {
      moji_pct: get('moji'), bunpou_pct: get('bunpou'), dokkai_pct: get('dokkai'),
      moji_correct:   sec.moji?.correct   ?? null,
      bunpou_correct: sec.bunpou?.correct ?? null,
      dokkai_correct: sec.dokkai?.correct ?? null,
      moji_total:     sec.moji?.total     ?? null,
      bunpou_total:   sec.bunpou?.total   ?? null,
      dokkai_total:   sec.dokkai?.total   ?? null,
    };
  }



async function deleteExamSession(rowOrUserId, maybeExamKey) {
  const parseRow = () => {
    if (rowOrUserId && typeof rowOrUserId === 'object') return rowOrUserId;
    const fromEventTarget = (typeof event !== 'undefined' && event?.target?.closest)
      ? event.target.closest('[data-user-id][data-exam-key]')
      : null;
    if (fromEventTarget) {
      return {
        user_id: fromEventTarget.getAttribute('data-user-id'),
        exam_key: fromEventTarget.getAttribute('data-exam-key'),
      };
    }
    return {
      user_id: typeof rowOrUserId === 'string' ? rowOrUserId : (rowOrUserId?.user_id || ''),
      exam_key: typeof maybeExamKey === 'string' ? maybeExamKey : (rowOrUserId?.exam_key || ''),
    };
  };

  const row = parseRow();
  const userId = row?.user_id || '';
  const examKey = row?.exam_key || '';
  if (!userId || !examKey) {
    toast('⚠️ Data session tidak lengkap');
    return false;
  }

  const confirmMsg = `Hapus session user ini?\n\nUser: ${userId}\nExam: ${examKey}\n\nAksi ini akan menghapus live progress dan hasil akhir.`;
  if (!confirm(confirmMsg)) return false;

  try {
    const [progressRes, sessionRes] = await Promise.all([
      client.from('exam_progress').delete().eq('user_id', userId).eq('exam_key', examKey),
      client.from('exam_sessions').delete().eq('user_id', userId).eq('exam_key', examKey),
    ]);

    if (progressRes?.error) throw progressRes.error;
    if (sessionRes?.error) throw sessionRes.error;

    state.resultsCache = (state.resultsCache || []).filter(r => !(String(r.user_id) === String(userId) && String(r.exam_key) === String(examKey)));
    if (state.isAdminPage) {
      await refreshAdminLivePanel();
      await refreshAdminResultsPanel();
    }

    toast('🗑️ Session user dihapus');
    return true;
  } catch (err) {
    console.error('[jlpt-sync] deleteExamSession failed:', err?.message || err);
    toast('❌ Gagal hapus session: ' + (err?.message || err));
    return false;
  }
}

  async function exportResultsExcel(selectedRows = null) {
    try {
      await loadUserMap();
      let rows = Array.isArray(state.resultsCache) && state.resultsCache.length
        ? state.resultsCache
        : (await client.from('exam_sessions').select('*').order('updated_at', { ascending: false }).limit(1000)).data || [];
      if (!rows.length) { toast('Belum ada data untuk diekspor'); return; }

      // If selectedRows provided, filter to only those user+exam combos
      if (Array.isArray(selectedRows) && selectedRows.length > 0) {
        const selSet = new Set(selectedRows.map(r => `${r.user_id}::${r.exam_key}`));
        rows = rows.filter(r => selSet.has(`${r.user_id}::${r.exam_key}`));
        if (!rows.length) { toast('⚠️ Data terpilih tidak ditemukan di cache'); return; }
      }

      const XLSX = await loadXLSX();
      const wb   = XLSX.utils.book_new();

      const summary = rows.map(row => {
        const user = state.userMap.get(row.user_id) || {};
        const sec  = sectionSummaryFromRow(row);
        const start = row.started_at   ? new Date(row.started_at)   : null;
        const end   = row.completed_at ? new Date(row.completed_at) : (row.updated_at ? new Date(row.updated_at) : null);
        const dur   = start && end ? Math.max((end - start) / 60000, 0) : null;
        return {
          user_name:   user.display_name || user.full_name || user.email || row.user_id,
          user_email:  user.email || '', user_id: row.user_id,
          exam_key:    row.exam_key, exam_title: row.exam_title, level: row.level, mode: row.mode,
          score:       row.score, percentage: Number(row.percentage || 0),
          correct_count: row.correct_count, wrong_count: row.wrong_count,
          total_questions: row.total_questions,
          completed:   row.completed ? 'yes' : 'no',
          started_at:  row.started_at, completed_at: row.completed_at,
          duration_minutes: dur == null ? null : Number(dur.toFixed(2)),
          ...sec, last_event: row.last_event, status: row.status,
        };
      });

      const live = (await client.from('exam_progress').select('*').order('updated_at', { ascending: false }).limit(1000)).data || [];
      const liveSheet = live.map(row => {
        const user = state.userMap.get(row.user_id) || {};
        return {
          user_name: user.display_name || user.full_name || user.email || row.user_id,
          user_email: user.email || '', ...row,
        };
      });

      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary),   'Summary');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(liveSheet), 'Live Progress');
      XLSX.writeFile(wb, `jlpt_results_${new Date().toISOString().slice(0, 10)}.xlsx`);
      toast('✅ Excel berhasil diekspor');
    } catch (err) {
      console.error('[jlpt-sync] exportResultsExcel failed:', err);
      toast('❌ Gagal export Excel: ' + (err?.message || err));
    }
  }



function bindAdminActionDelegates(root = document) {
  if (!root || root.__jlptActionDelegatesBound) return;
  root.__jlptActionDelegatesBound = true;

  root.addEventListener('click', async (e) => {
    const exportBtn = e.target?.closest?.('#jlpt-export-xlsx');
    if (exportBtn) {
      e.preventDefault();
      e.stopPropagation();
      try { await exportResultsExcel(); } catch (err) { console.error('[jlpt-sync] export click failed:', err); }
      return;
    }

    const delBtn = e.target?.closest?.('[data-session-delete="1"]');
    if (delBtn) {
      e.preventDefault();
      e.stopPropagation();
      const userId = delBtn.getAttribute('data-user-id');
      const examKey = delBtn.getAttribute('data-exam-key');
      if (!userId || !examKey) return;
      try { await deleteExamSession({ user_id: userId, exam_key: examKey }); } catch (err) { console.error('[jlpt-sync] delete click failed:', err); }
    }
  }, true);
}

  // ── Main init ────────────────────────────────────────────────────────────────
  async function initPage() {
    const kind = pageKind();
    state.isAdminPage = kind === 'admin';
    state.isIndexPage = kind === 'index';
    state.isExamPage  = kind === 'exam';

    const ctx = await getContext();
    if (ctx) { state.session = ctx.session; state.userDb = ctx.userDb; state.isAdmin = ctx.isAdmin; }

    await loadSystemSettings();
    await loadExamLocks(true);
    subscribeRealtime();

    if (state.isIndexPage) {
      renderIndexLockUI();
      if (location.search.includes('locked=1')) toast('Ujian masih dikunci admin');
    }

    if (state.isAdminPage) {
      // FIX: ensure admin's role is in DB so is_jlpt_admin() works via role check
      await ensureAdminRole(ctx);
      renderAdminControlUI();
      await refreshAdminPanels();
    }

    if (state.isExamPage) {
      installExamGuards();
      await ensureServerSession();
      observeExamFunctions();
      enforceLockState();
      state.heartbeatTimer = setInterval(() => {
        if (state.examRunning) syncSession('heartbeat', false, false);
      }, 10000);
      setInterval(async () => {
        await loadSystemSettings(); await loadCurrentExamLock(); enforceLockState();
      }, 8000);
    }
  }

  // Safely call initPage regardless of DOMContentLoaded timing
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPage);
  } else {
    initPage();
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  window.deleteExamSession = (...args) => window.JLPT_SYNC?.deleteExamSession?.(...args);
  window.JLPT_SYNC = {
    setGlobalLock, setExamLock, setMultipleExamLocks,
    loadSystemSettings, loadExamLocks,
    renderIndexLockUI, renderAdminControlUI,
    refreshAdminLivePanel, refreshAdminResultsPanel, refreshAdminPanels,
    syncSession, exportResultsExcel, deleteExamSession,
    examMeta: examMetaFromPath,
  };
})();