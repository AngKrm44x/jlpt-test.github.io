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

    if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="padding:16px;color:var(--muted);">Memuat data sesi...</td></tr>';

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
      const activeCount = rows.filter(r => String(r.status || '').toLowerCase() === 'active').length;
      const summary     = `${activeCount} active / ${rows.length} session`;
      if (count)      count.textContent      = summary;
      if (countBadge) countBadge.textContent = summary;

      if (!tbody) { console.warn('[jlpt-sync] #jlpt-live-table not found in DOM'); return; }
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="padding:16px;color:var(--muted);">Belum ada sesi yang tersinkron.</td></tr>';
        return;
      }
      tbody.innerHTML = rows.map(row => {
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
        </tr>`;
      }).join('');
    } catch (err) {
      console.error('[jlpt-sync] refreshAdminLivePanel failed:', err?.message || err);
      if (tbody) tbody.innerHTML = `<tr><td colspan="5" style="padding:16px;color:#ff9aaa;">Gagal memuat live view: ${esc(err?.message || String(err))}</td></tr>`;
    }
  }

  async function refreshAdminResultsPanel() {
    if (!state.isAdminPage) return;
    ensureAdminPanel();   // Guarantee DOM elements exist
    await loadUserMap();

    const tbody      = document.getElementById('jlpt-results-table');
    const count      = document.getElementById('jlpt-results-count');
    const countBadge = document.getElementById('jlpt-results-count-badge');

    if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="padding:16px;color:var(--muted);">Memuat hasil ujian...</td></tr>';

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

      if (count)      count.textContent      = `${rows.length} session`;
      if (countBadge) countBadge.textContent = `${rows.length} session`;

      if (!tbody) { console.warn('[jlpt-sync] #jlpt-results-table not found in DOM'); return; }
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="padding:16px;color:var(--muted);">Belum ada hasil ujian.</td></tr>';
        return;
      }
      tbody.innerHTML = rows.map(row => {
        const user  = state.userMap.get(row.user_id) || {};
        const label = user.display_name || user.full_name || user.email || row.user_id || '—';
        const pct   = Number(row.percentage || 0);
        const sec   = row.section_scores || {};
        const moji  = sec.moji?.percentage   ?? '—';
        const bun   = sec.bunpou?.percentage ?? '—';
        const dok   = sec.dokkai?.percentage ?? '—';
        return `<tr>
          <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);font-weight:700;">${esc(label)}</td>
          <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);">${esc(row.exam_title || row.exam_key || '—')}</td>
          <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);font-family:'JetBrains Mono',monospace;">${esc(row.score ?? 0)}</td>
          <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);font-weight:700;">${esc(String(pct.toFixed ? pct.toFixed(2) : pct))}%</td>
          <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);">${esc(`${moji}% / ${bun}% / ${dok}%`)}</td>
          <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);font-size:12px;color:var(--muted);">${esc(fmtTime(row.started_at))}</td>
          <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);font-size:12px;color:var(--muted);">${esc(fmtTime(row.completed_at || row.updated_at))}</td>
        </tr>`;
      }).join('');
    } catch (err) {
      console.error('[jlpt-sync] refreshAdminResultsPanel failed:', err?.message || err);
      if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="padding:16px;color:#ff9aaa;">Gagal memuat hasil: ${esc(err?.message || String(err))}</td></tr>`;
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
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <span id="jlpt-live-count-badge" style="padding:8px 12px;border-radius:999px;font-size:12px;font-weight:800;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);">— session</span>
            <button id="jlpt-refresh-live" class="topbar-btn">🔄 Refresh Live</button>
          </div>
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
              </tr>
            </thead>
            <tbody id="jlpt-live-table">
              <tr><td colspan="5" style="padding:16px;color:var(--muted);">Memuat...</td></tr>
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
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <span id="jlpt-results-count-badge" style="padding:8px 12px;border-radius:999px;font-size:12px;font-weight:800;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);">— session</span>
            <button id="jlpt-export-xlsx"    class="topbar-btn primary">📥 Export Excel</button>
            <button id="jlpt-refresh-results" class="topbar-btn">🔄 Refresh Results</button>
          </div>
        </div>
        <div style="overflow:auto;">
          <table style="width:100%;border-collapse:collapse;">
            <thead style="background:rgba(255,255,255,.02);">
              <tr>
                <th style="text-align:left;padding:12px 14px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);">User</th>
                <th style="text-align:left;padding:12px 14px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);">Exam</th>
                <th style="text-align:left;padding:12px 14px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);">Score</th>
                <th style="text-align:left;padding:12px 14px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);">Percent</th>
                <th style="text-align:left;padding:12px 14px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);">Sections (M/B/D)</th>
                <th style="text-align:left;padding:12px 14px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);">Started</th>
                <th style="text-align:left;padding:12px 14px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);">Completed</th>
              </tr>
            </thead>
            <tbody id="jlpt-results-table">
              <tr><td colspan="7" style="padding:16px;color:var(--muted);">Memuat...</td></tr>
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

    state.adminPanelReady = true;
    return wrap;
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'exam_sessions' }, async () => {
        if (state.isAdminPage) await refreshAdminResultsPanel();
      })
      .subscribe();
  }

  // ── XLSX export ──────────────────────────────────────────────────────────────

  async function loadXLSX() {
    if (window.XLSX) return window.XLSX;
    const candidates = [
      'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.full.min.js',
      'https://cdn.jsdelivr.net/npm/xlsx/dist/xlsx.full.min.js',
    ];

    let lastErr = null;
    for (const src of candidates) {
      try {
        await new Promise((res, rej) => {
          const s  = document.createElement('script');
          s.src    = src;
          s.onload = res;
          s.onerror = () => rej(new Error('Failed to load XLSX from ' + src));
          document.head.appendChild(s);
        });
        if (window.XLSX) return window.XLSX;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('Failed to load XLSX');
  }

  function fmtDateTimeCell(value) {
    if (!value) return '—';
    try {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return String(value);
      return d.toLocaleString('id-ID', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return String(value);
    }
  }

  function fmtDurationCell(minutes) {
    if (minutes == null || Number.isNaN(Number(minutes))) return '—';
    const n = Number(minutes);
    return n < 1 ? `${Math.round(n * 60)} detik` : `${n.toFixed(2)} menit`;
  }

  function makeSectionText(sec) {
    if (!sec) return '—';
    const parts = [];
    const push = (label, pct, corr, total) => {
      if (pct == null && corr == null && total == null) return;
      parts.push(`${label}: ${pct == null ? '—' : `${Number(pct).toFixed(2)}%`} (${corr ?? '—'}/${total ?? '—'})`);
    };
    push('M', sec.moji_pct, sec.moji_correct, sec.moji_total);
    push('B', sec.bunpou_pct, sec.bunpou_correct, sec.bunpou_total);
    push('D', sec.dokkai_pct, sec.dokkai_correct, sec.dokkai_total);
    return parts.join(' | ');
  }

  function styleCell(cell, style) {
    if (cell) cell.s = style;
  }

  function applyWorksheetTheme(ws, headersRowIndex = 1, freezeRow = 1, headerRange = null) {
    ws['!freeze'] = { xSplit: 0, ySplit: freezeRow };
    ws['!autofilter'] = headerRange ? { ref: headerRange } : undefined;
    ws['!rows'] = ws['!rows'] || [];
  }

  function setColWidths(ws, widths) {
    ws['!cols'] = widths.map(w => ({ wch: w }));
  }

  function buildSheetFromRows(XLSX, title, subtitle, columns, rows, options = {}) {
    const data = [];
    data.push([title]);
    data.push([subtitle]);
    data.push([]);
    data.push(columns.map(c => c.label));

    for (const row of rows) {
      data.push(columns.map(c => {
        try {
          return c.value(row);
        } catch {
          return '';
        }
      }));
    }

    const ws = XLSX.utils.aoa_to_sheet(data);

    const titleRow = 1;
    const subRow   = 2;
    const headRow   = 4;
    const lastCol   = XLSX.utils.encode_col(columns.length - 1);
    const lastRow   = data.length;
    ws['!merges'] = [
      { s: { r: titleRow - 1, c: 0 }, e: { r: titleRow - 1, c: columns.length - 1 } },
      { s: { r: subRow - 1, c: 0 },   e: { r: subRow - 1, c: columns.length - 1 } },
    ];

    setColWidths(ws, columns.map(c => c.width || 16));
    applyWorksheetTheme(ws, headRow, headRow, `A${headRow}:${lastCol}${lastRow}`);

    const styles = {
      title: {
        font: { bold: true, sz: 16, color: { rgb: 'FFFFFF' } },
        fill: { patternType: 'solid', fgColor: { rgb: options.titleFill || '2D4EA1' } },
        alignment: { horizontal: 'center', vertical: 'center' },
        border: {
          top: { style: 'thin', color: { rgb: 'D6E2FF' } },
          bottom: { style: 'thin', color: { rgb: 'D6E2FF' } },
          left: { style: 'thin', color: { rgb: 'D6E2FF' } },
          right: { style: 'thin', color: { rgb: 'D6E2FF' } },
        },
      },
      subtitle: {
        font: { italic: true, color: { rgb: '6B7280' } },
        alignment: { horizontal: 'left', vertical: 'center', wrapText: true },
      },
      header: {
        font: { bold: true, color: { rgb: 'FFFFFF' } },
        fill: { patternType: 'solid', fgColor: { rgb: '0F172A' } },
        border: {
          top: { style: 'thin', color: { rgb: '334155' } },
          bottom: { style: 'thin', color: { rgb: '334155' } },
          left: { style: 'thin', color: { rgb: '334155' } },
          right: { style: 'thin', color: { rgb: '334155' } },
        },
        alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
      },
      body: {
        font: { color: { rgb: '111827' } },
        alignment: { vertical: 'top', wrapText: true },
        border: {
          top: { style: 'thin', color: { rgb: 'E5E7EB' } },
          bottom: { style: 'thin', color: { rgb: 'E5E7EB' } },
          left: { style: 'thin', color: { rgb: 'E5E7EB' } },
          right: { style: 'thin', color: { rgb: 'E5E7EB' } },
        },
      },
      bodyAlt: {
        font: { color: { rgb: '111827' } },
        fill: { patternType: 'solid', fgColor: { rgb: 'F8FAFC' } },
        alignment: { vertical: 'top', wrapText: true },
        border: {
          top: { style: 'thin', color: { rgb: 'E5E7EB' } },
          bottom: { style: 'thin', color: { rgb: 'E5E7EB' } },
          left: { style: 'thin', color: { rgb: 'E5E7EB' } },
          right: { style: 'thin', color: { rgb: 'E5E7EB' } },
        },
      },
    };

    styleCell(ws['A1'], styles.title);
    styleCell(ws['A2'], styles.subtitle);

    for (let c = 0; c < columns.length; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r: headRow - 1, c })];
      if (cell) styleCell(cell, styles.header);
    }

    for (let r = headRow; r < data.length; r++) {
      for (let c = 0; c < columns.length; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (!cell) continue;
        styleCell(cell, (r % 2 === 0) ? styles.bodyAlt : styles.body);
        const col = columns[c];
        if (col && col.numFmt) cell.z = col.numFmt;
        if (col && col.align) {
          cell.s = cell.s || {};
          cell.s.alignment = { ...(cell.s.alignment || {}), horizontal: col.align };
        }
      }
    }

    if (columns.some(c => c.autoFilter !== false)) {
      ws['!autofilter'] = { ref: `A${headRow}:${lastCol}${lastRow}` };
    }

    return ws;
  }

  async function exportResultsExcel() {
    try {
      await loadUserMap();
      const rows = Array.isArray(state.resultsCache) && state.resultsCache.length
        ? state.resultsCache
        : (await client.from('exam_sessions').select('*').order('updated_at', { ascending: false }).limit(1000)).data || [];
      if (!rows.length) { toast('Belum ada data untuk diekspor'); return; }

      const live = (await client.from('exam_progress').select('*').order('updated_at', { ascending: false }).limit(1000)).data || [];
      const XLSX = await loadXLSX();
      const wb   = XLSX.utils.book_new();
      const genAt = new Date().toISOString();

      const summaryRows = rows.map(row => {
        const user = state.userMap.get(row.user_id) || {};
        const sec  = sectionSummaryFromRow(row);
        const start = row.started_at   ? new Date(row.started_at)   : null;
        const end   = row.completed_at ? new Date(row.completed_at) : (row.updated_at ? new Date(row.updated_at) : null);
        const dur   = start && end ? Math.max((end - start) / 60000, 0) : null;
        return {
          user_name: user.display_name || user.full_name || user.email || row.user_id,
          user_email: user.email || '',
          user_id: row.user_id,
          exam_key: row.exam_key,
          exam_title: row.exam_title,
          level: row.level,
          mode: row.mode,
          score: Number(row.score || 0),
          percentage: Number(row.percentage || 0),
          correct_count: Number(row.correct_count || 0),
          wrong_count: Number(row.wrong_count || 0),
          total_questions: Number(row.total_questions || 0),
          completed: row.completed ? 'Yes' : 'No',
          started_at: row.started_at,
          completed_at: row.completed_at,
          duration_minutes: dur == null ? null : Number(dur.toFixed(2)),
          section_text: makeSectionText(sec),
          last_event: row.last_event || '',
          status: row.status || '',
        };
      });

      const liveRows = live.map(row => {
        const user = state.userMap.get(row.user_id) || {};
        return {
          user_name: user.display_name || user.full_name || user.email || row.user_id,
          user_email: user.email || '',
          exam_key: row.exam_key || '',
          exam_title: row.exam_title || '',
          level: row.level || '',
          mode: row.mode || '',
          current_q: Number(row.current_q || 0),
          total_q: Number(row.total_q || 0),
          answered_count: Number(row.answered_count || 0),
          correct_count: Number(row.correct_count || 0),
          wrong_count: Number(row.wrong_count || 0),
          percentage: Number(row.percentage || 0),
          remaining_seconds: row.remaining_seconds == null ? null : Number(row.remaining_seconds),
          status: row.status || '',
          last_event: row.last_event || '',
          updated_at: row.updated_at || '',
        };
      });

      const overview = [
        ['JLPT Exam Export', ''],
        ['Generated at', genAt],
        ['Summary rows', summaryRows.length],
        ['Live progress rows', liveRows.length],
        ['Top score', summaryRows.length ? Math.max(...summaryRows.map(r => Number(r.percentage || 0))) : 0],
        ['Avg score', summaryRows.length ? Number((summaryRows.reduce((a, r) => a + Number(r.percentage || 0), 0) / summaryRows.length).toFixed(2)) : 0],
      ];
      const overviewWs = XLSX.utils.aoa_to_sheet(overview);
      overviewWs['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
      overviewWs['!cols'] = [{ wch: 24 }, { wch: 40 }];
      const ovStyles = {
        title: { font: { bold: true, sz: 16, color: { rgb: 'FFFFFF' } }, fill: { patternType: 'solid', fgColor: { rgb: '2D4EA1' } }, alignment: { horizontal: 'center' } },
        label: { font: { bold: true, color: { rgb: '111827' } }, fill: { patternType: 'solid', fgColor: { rgb: 'F8FAFC' } } },
        value: { font: { color: { rgb: '111827' } }, fill: { patternType: 'solid', fgColor: { rgb: 'FFFFFF' } } },
      };
      overviewWs['A1'].s = ovStyles.title;
      overviewWs['B1'].s = ovStyles.title;
      for (let r = 2; r < overview.length; r++) {
        if (overviewWs[`A${r+1}`]) overviewWs[`A${r+1}`].s = ovStyles.label;
        if (overviewWs[`B${r+1}`]) overviewWs[`B${r+1}`].s = ovStyles.value;
      }

      const summaryColumns = [
        { label: 'User', width: 22, value: r => r.user_name },
        { label: 'Email', width: 24, value: r => r.user_email },
        { label: 'Exam', width: 22, value: r => r.exam_title },
        { label: 'Level', width: 10, value: r => r.level, align: 'center' },
        { label: 'Mode', width: 10, value: r => r.mode, align: 'center' },
        { label: 'Score', width: 10, value: r => r.score, align: 'center', numFmt: '0' },
        { label: 'Percent', width: 10, value: r => `${Number(r.percentage || 0).toFixed(2)}%`, align: 'center' },
        { label: 'Correct', width: 10, value: r => r.correct_count, align: 'center', numFmt: '0' },
        { label: 'Wrong', width: 10, value: r => r.wrong_count, align: 'center', numFmt: '0' },
        { label: 'Total', width: 9, value: r => r.total_questions, align: 'center', numFmt: '0' },
        { label: 'Started', width: 20, value: r => fmtDateTimeCell(r.started_at) },
        { label: 'Completed', width: 20, value: r => fmtDateTimeCell(r.completed_at) },
        { label: 'Duration', width: 11, value: r => fmtDurationCell(r.duration_minutes), align: 'center' },
        { label: 'Section Detail', width: 48, value: r => r.section_text },
        { label: 'Last Event', width: 14, value: r => r.last_event, align: 'center' },
        { label: 'Status', width: 12, value: r => r.status, align: 'center' },
      ];

      const liveColumns = [
        { label: 'User', width: 22, value: r => r.user_name },
        { label: 'Email', width: 24, value: r => r.user_email },
        { label: 'Exam', width: 22, value: r => r.exam_title },
        { label: 'Level', width: 10, value: r => r.level, align: 'center' },
        { label: 'Mode', width: 10, value: r => r.mode, align: 'center' },
        { label: 'Current Q', width: 10, value: r => r.current_q, align: 'center', numFmt: '0' },
        { label: 'Total Q', width: 9, value: r => r.total_q, align: 'center', numFmt: '0' },
        { label: 'Answered', width: 10, value: r => r.answered_count, align: 'center', numFmt: '0' },
        { label: 'Correct', width: 10, value: r => r.correct_count, align: 'center', numFmt: '0' },
        { label: 'Wrong', width: 9, value: r => r.wrong_count, align: 'center', numFmt: '0' },
        { label: 'Percent', width: 10, value: r => `${Number(r.percentage || 0).toFixed(2)}%`, align: 'center' },
        { label: 'Remaining', width: 12, value: r => r.remaining_seconds == null ? '—' : fmtSec(r.remaining_seconds), align: 'center' },
        { label: 'Status', width: 12, value: r => r.status, align: 'center' },
        { label: 'Last Event', width: 14, value: r => r.last_event, align: 'center' },
        { label: 'Updated', width: 20, value: r => fmtDateTimeCell(r.updated_at) },
      ];

      const guideRows = [
        { item: 'M', title: '文字・語彙', detail: 'Persentase berdasarkan section moji.' },
        { item: 'B', title: '文法', detail: 'Persentase berdasarkan section bunpou.' },
        { item: 'D', title: '読解', detail: 'Persentase berdasarkan section dokkai.' },
        { item: 'Percent', title: 'Nilai total', detail: 'Total persentase jawaban benar dari seluruh soal.' },
        { item: 'Duration', title: 'Durasi pengerjaan', detail: 'Selisih waktu start dan selesai, dalam menit.' },
        { item: 'Status', title: 'Status sesi', detail: 'opened / active / done / idle sesuai state ujian.' },
      ];
      const guideColumns = [
        { label: 'Key', width: 10, value: r => r.item, align: 'center' },
        { label: 'Label', width: 18, value: r => r.title },
        { label: 'Keterangan', width: 48, value: r => r.detail },
      ];

      XLSX.utils.book_append_sheet(wb, overviewWs, 'Overview');
      XLSX.utils.book_append_sheet(wb, buildSheetFromRows(XLSX, 'JLPT Exam Results', `Generated ${fmtDateTimeCell(genAt)} · Summary sessions`, summaryColumns, summaryRows, { titleFill: '1D4ED8' }), 'Summary');
      XLSX.utils.book_append_sheet(wb, buildSheetFromRows(XLSX, 'JLPT Live Progress', `Generated ${fmtDateTimeCell(genAt)} · Realtime progress`, liveColumns, liveRows, { titleFill: '0F766E' }), 'Live Progress');
      XLSX.utils.book_append_sheet(wb, buildSheetFromRows(XLSX, 'JLPT Export Guide', 'Penjelasan kolom export untuk admin.', guideColumns, guideRows, { titleFill: '7C3AED' }), 'Guide');

      XLSX.writeFile(wb, `jlpt_results_${new Date().toISOString().slice(0, 10)}.xlsx`);
      toast('✅ Excel berhasil diekspor');
    } catch (err) {
      console.error('[jlpt-sync] exportResultsExcel failed:', err);
      toast('❌ Gagal export Excel: ' + (err?.message || err));
    }
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
  window.JLPT_SYNC = {
    setGlobalLock, setExamLock, setMultipleExamLocks,
    loadSystemSettings, loadExamLocks,
    renderIndexLockUI, renderAdminControlUI,
    refreshAdminLivePanel, refreshAdminResultsPanel, refreshAdminPanels,
    syncSession, exportResultsExcel,
    examMeta: examMetaFromPath,
  };
})();