// jlpt-sync.js
// Shared sync layer for JLPT:
// - global lock/unlock (system_settings)
// - per-exam lock/unlock (exam_settings)
// - live session mirror (exam_progress)
// - final result/session storage (exam_sessions)
// - admin live monitor + results export (Excel)
// - browser restrictions during active exams

(async function () {
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm');

  const SUPABASE_URL = 'https://uincqpdexdenjcmwdfsv.supabase.co';
  const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVpbmNxcGRleGRlbmpjbXdkZnN2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5MjM4ODEsImV4cCI6MjA5NTQ5OTg4MX0.Lf1N_P_iiNQ2hnRJhd-Quy9MLKlZFSzbnXtXCnmRCS0';

  const client = window._supabase || createClient(SUPABASE_URL, SUPABASE_ANON);
  if (!window._supabase) window._supabase = client;

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
      if (typeof window.alert === 'function') return window.alert(msg);
    } catch {}
    console.log('[JLPT]', msg);
  }

  function esc(v) {
    return String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function toBool(v) {
    if (typeof v === 'boolean') return v;
    const s = String(v ?? '').trim().toLowerCase();
    return ['1', 'true', 'yes', 'on', 'locked'].includes(s);
  }

  function fmtTime(ts) {
    if (!ts) return '—';
    try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
  }

  function fmtSec(sec) {
    if (sec == null || Number.isNaN(Number(sec))) return '—';
    const s = Math.max(0, Math.floor(Number(sec)));
    const mm = Math.floor(s / 60);
    const ss = s % 60;
    return `${mm}:${String(ss).padStart(2, '0')}`;
  }

  function currentPath() {
    return location.pathname.replace(/\\/g, '/');
  }

  function examMetaFromPath() {
    if (state.examMeta) return state.examMeta;
    const p = currentPath();
    let key = '';
    let level = '';
    let year = '';
    let month = '';
    const m = p.match(/(\d{4})-(\d{2})-n([1-5])/i);
    if (m) {
      year = m[1];
      month = m[2];
      level = `N${m[3]}`;
      key = `n${m[3]}-${m[1]}-${m[2]}`;
    } else {
      const m2 = p.match(/n([1-5])-(\d{4})-(\d{2})/i);
      if (m2) {
        level = `N${m2[1]}`;
        year = m2[2];
        month = m2[3];
        key = `n${m2[1]}-${m2[2]}-${m2[3]}`;
      } else {
        const fallback = (location.pathname.split('/').pop() || document.title || 'exam').replace(/\.[^.]+$/, '');
        key = fallback.toLowerCase();
        const lev = fallback.match(/n([1-5])/i);
        level = lev ? `N${lev[1]}` : 'N?';
      }
    }
    state.examMeta = {
      key,
      level,
      year,
      month,
      title: (document.title || `${level} Exam`).trim(),
      path: p,
    };
    window.__JLPT_EXAM_KEY__ = key;
    return state.examMeta;
  }

  function isAdminEmail(email = '') {
    return ADMIN_EMAILS.has(String(email).trim().toLowerCase());
  }

  async function getContext() {
    try {
      const session = window._session || (await client.auth.getSession()).data.session;
      if (!session) return null;
      const email = (session.user.email || '').trim().toLowerCase();
      let userDb = window._userDb || null;
      if (!userDb) {
        const res = await client.from('users').select('*').eq('id', session.user.id).maybeSingle();
        userDb = res.data || null;
      }
      const dbRole = String(userDb?.role || '').trim().toLowerCase();
      const roleFromDb = ['admin', 'super admin', 'super_admin'].includes(dbRole);
      return { session, userDb, isAdmin: isAdminEmail(email) || roleFromDb };
    } catch (err) {
      console.warn('getContext failed:', err?.message || err);
      return null;
    }
  }

  async function loadUserMap() {
    if (!state.isAdminPage) return state.userMap;
    if (state.userMap.size) return state.userMap;
    try {
      const { data, error } = await client.from('users').select('id, full_name, display_name, email, role');
      if (error) throw error;
      const map = new Map();
      (data || []).forEach((u) => map.set(u.id, u));
      state.userMap = map;
      return map;
    } catch (err) {
      console.warn('loadUserMap failed:', err?.message || err);
      return state.userMap;
    }
  }

  async function loadSystemSettings() {
    try {
      const { data, error } = await client.from('system_settings').select('*');
      if (error) throw error;
      const rows = Array.isArray(data) ? data : [];
      const map = Object.fromEntries(rows.map((r) => [String(r.key || '').toLowerCase(), String(r.value ?? '')]));
      state.settings.exam_locked = toBool(map.exam_locked);
      state.settings.exam_lock_reason = map.exam_lock_reason || '';
      state.settings.exam_live_enabled = !toBool(map.exam_live_enabled) || String(map.exam_live_enabled).trim().toLowerCase() === 'true';
      state.settings.updated_at = rows[0]?.updated_at || state.settings.updated_at;
      state.settings.updated_by = rows[0]?.updated_by || state.settings.updated_by;
      return state.settings;
    } catch (err) {
      console.warn('system_settings load failed:', err?.message || err);
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
      (data || []).forEach((row) => map.set(String(row.exam_key || '').toLowerCase(), row));
      state.examLocks = map;
      return map;
    } catch (err) {
      console.warn('exam_settings load failed:', err?.message || err);
      return state.examLocks;
    }
  }

  async function loadCurrentExamLock() {
    const meta = examMetaFromPath();
    if (!meta.key) return null;
    const map = await loadExamLocks(true);
    return map.get(meta.key) || null;
  }

  async function setSystemSetting(key, value) {
    const ctx = await getContext();
    if (!ctx?.isAdmin) {
      toast('⛔ Admin only');
      return false;
    }
    try {
      const payload = {
        key,
        value: String(value ?? ''),
        updated_at: new Date().toISOString(),
        updated_by: ctx.session.user.id,
      };
      const { error } = await client.from('system_settings').upsert(payload, { onConflict: 'key' });
      if (error) throw error;
      await loadSystemSettings();
      renderIndexLockUI();
      renderAdminControlUI();
      await refreshAdminPanels();
      return true;
    } catch (err) {
      console.error('setSystemSetting failed:', err);
      toast('⚠️ Gagal menyimpan setting global');
      return false;
    }
  }

  async function setGlobalLock(locked, reason = '') {
    const ctx = await getContext();
    if (!ctx?.isAdmin) return false;
    await setSystemSetting('exam_locked', locked ? 'true' : 'false');
    await setSystemSetting('exam_lock_reason', reason || '');
    toast(locked ? '🔒 Semua exam dikunci' : '🔓 Semua exam dibuka');
    return true;
  }

  async function setExamLock(examKey, locked, reason = '') {
    const ctx = await getContext();
    if (!ctx?.isAdmin) {
      toast('⛔ Admin only');
      return false;
    }
    const key = String(examKey || '').toLowerCase();
    if (!key) return false;
    try {
      const row = state.examLocks.get(key) || {};
      const payload = {
        exam_key: key,
        title: row.title || '',
        level: row.level || '',
        locked: !!locked,
        lock_reason: reason ?? row.lock_reason ?? '',
        updated_at: new Date().toISOString(),
        updated_by: ctx.session.user.id,
      };
      const { error } = await client.from('exam_settings').upsert(payload, { onConflict: 'exam_key' });
      if (error) throw error;
      await loadExamLocks(true);
      renderIndexLockUI();
      renderAdminControlUI();
      await refreshAdminPanels();
      return true;
    } catch (err) {
      console.error('setExamLock failed:', err);
      toast('⚠️ Gagal menyimpan lock ujian');
      return false;
    }
  }

  async function setMultipleExamLocks(examKeys, locked, reason = '') {
    const keys = Array.from(new Set((examKeys || []).map((k) => String(k || '').toLowerCase()).filter(Boolean)));
    if (!keys.length) {
      toast('Pilih minimal satu ujian');
      return false;
    }
    let ok = 0;
    for (const key of keys) {
      if (await setExamLock(key, locked, reason)) ok += 1;
    }
    toast(ok ? `${locked ? '🔒' : '🔓'} ${ok} ujian diperbarui` : '⚠️ Tidak ada ujian yang berubah');
    return ok > 0;
  }

  function questionGroups() {
    const groups = [
      { label: '文字・語彙', key: 'moji', aliases: ['文字・語彙', '文字', '語彙'] },
      { label: '文法', key: 'bunpou', aliases: ['文法'] },
      { label: '読解', key: 'dokkai', aliases: ['読解'] },
    ];
    return groups;
  }

  function sectionKeyFromLabel(sec = '') {
    const s = String(sec || '');
    if (s.includes('文字') || s.includes('語彙')) return 'moji';
    if (s.includes('文法')) return 'bunpou';
    if (s.includes('読解')) return 'dokkai';
    return 'other';
  }

  function computeStats() {
    const qs = Array.isArray(window.questions) ? window.questions : [];
    const ans = window.answers && typeof window.answers === 'object' ? window.answers : {};
    const answered = Object.keys(ans).length;
    const correct = Object.values(ans).filter((a) => a && a.correct).length;
    const total = qs.length || Number(window.totalQuestions || 0) || 0;
    const wrong = Math.max(answered - correct, 0);
    const percent = total ? Math.round((correct / total) * 10000) / 100 : 0;

    const sectionScores = {};
    for (const g of questionGroups()) {
      const items = qs.filter((q) => sectionKeyFromLabel(q.sec) === g.key);
      const correctCount = items.filter((q) => ans[q.id] && ans[q.id].correct).length;
      const totalCount = items.length;
      sectionScores[g.key] = {
        label: g.label,
        correct: correctCount,
        total: totalCount,
        percentage: totalCount ? Math.round((correctCount / totalCount) * 10000) / 100 : 0,
      };
    }

    return { answered, correct, wrong, total, percent, sectionScores };
  }

  function remainingSeconds() {
    const startTime = Number(window.startTime || 0);
    const totalSeconds = Number(window.totalSeconds || 0);
    if (!startTime || !totalSeconds) return null;
    return Math.max(totalSeconds - Math.floor((Date.now() - startTime) / 1000), 0);
  }

  function buildSnapshot(eventName = 'heartbeat', done = false) {
    const meta = examMetaFromPath();
    const stats = computeStats();
    const rem = remainingSeconds();
    const now = new Date().toISOString();
    const currentQ = Number(window.currentQ ?? 0);
    const totalQuestions = Number(stats.total || 0);

    const answers = window.answers && typeof window.answers === 'object' ? window.answers : {};
    const startedAt = window.__JLPT_SESSION_STARTED_AT__ || window.startTimeISO || null;

    return {
      exam_key: meta.key,
      exam_title: meta.title,
      level: meta.level,
      year: meta.year ? Number(meta.year) : null,
      month: meta.month || null,
      mode: window.mode || window.currentMode || 'all',
      started_at: startedAt || now,
      updated_at: now,
      last_seen_at: now,
      current_question: currentQ + 1,
      total_questions: totalQuestions,
      timer_remaining: rem,
      answers,
      score: stats.correct,
      correct_count: stats.correct,
      wrong_count: done ? Math.max(totalQuestions - stats.correct, 0) : stats.wrong,
      percentage: stats.percent,
      section_scores: stats.sectionScores,
      completed: !!done,
      completed_at: done ? now : null,
      status: done ? 'done' : (state.examRunning ? 'active' : 'idle'),
      last_event: eventName,
    };
  }

  function buildLivePayload(snapshot) {
    return {
      exam_key: snapshot.exam_key,
      exam_title: snapshot.exam_title,
      level: snapshot.level,
      year: snapshot.year,
      month: snapshot.month,
      mode: snapshot.mode,
      status: snapshot.status,
      current_q: snapshot.current_question,
      total_q: snapshot.total_questions,
      answered_count: Object.keys(snapshot.answers || {}).length,
      correct_count: snapshot.correct_count,
      wrong_count: snapshot.wrong_count,
      percentage: snapshot.percentage,
      remaining_seconds: snapshot.timer_remaining,
      last_event: snapshot.last_event,
      client_time: snapshot.updated_at,
      updated_at: snapshot.updated_at,
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
    } catch (err) {
      console.warn('ensureServerSession failed:', err?.message || err);
    }
    return null;
  }

  async function syncSession(eventName = 'heartbeat', done = false, force = false) {
    const ctx = await getContext();
    if (!ctx || ctx.isAdmin || !state.settings.exam_live_enabled) return false;
    const snapshot = buildSnapshot(eventName, done);
    const hash = JSON.stringify({
      k: snapshot.exam_key,
      q: snapshot.current_question,
      a: snapshot.answers,
      c: snapshot.correct_count,
      w: snapshot.wrong_count,
      p: snapshot.percentage,
      s: snapshot.status,
      r: snapshot.timer_remaining,
      d: snapshot.completed,
      e: snapshot.last_event,
    });
    const now = Date.now();
    if (!force && state.lastProgressHash === hash && now - state.lastProgressSentAt < 4000) return true;
    state.lastProgressHash = hash;
    state.lastProgressSentAt = now;

    try {
      const progressPayload = buildLivePayload(snapshot);
      const sessionPayload = {
        user_id: ctx.session.user.id,
        exam_key: snapshot.exam_key,
        exam_title: snapshot.exam_title,
        level: snapshot.level,
        year: snapshot.year,
        month: snapshot.month,
        mode: snapshot.mode,
        started_at: snapshot.started_at,
        updated_at: snapshot.updated_at,
        last_seen_at: snapshot.last_seen_at,
        answers: snapshot.answers,
        current_question: snapshot.current_question,
        total_questions: snapshot.total_questions,
        timer_remaining: snapshot.timer_remaining,
        score: snapshot.score,
        correct_count: snapshot.correct_count,
        wrong_count: snapshot.wrong_count,
        percentage: snapshot.percentage,
        section_scores: snapshot.section_scores,
        completed: snapshot.completed,
        completed_at: snapshot.completed_at,
        status: snapshot.status,
        last_event: snapshot.last_event,
      };

      const [progressRes, sessionRes] = await Promise.all([
        client.from('exam_progress').upsert({
          user_id: ctx.session.user.id,
          ...progressPayload,
        }, { onConflict: 'user_id,exam_key' }),
        client.from('exam_sessions').upsert(sessionPayload, { onConflict: 'user_id,exam_key' }),
      ]);

      if (progressRes.error) throw progressRes.error;
      if (sessionRes.error) throw sessionRes.error;
      return true;
    } catch (err) {
      console.warn('syncSession failed:', err?.message || err);
      return false;
    }
  }

  function blockExamShortcuts(e) {
    if (!state.isExamPage || !state.examRunning) return;
    const blocked = new Set(['F5', 'F6', 'F12', 'Escape', 'PrintScreen']);
    const ctrlBlocked = new Set(['l', 'n', 't', 'w', 'r', 'u', 's', 'p', 'f', 'j']);
    if (
      blocked.has(e.key) ||
      ((e.ctrlKey || e.metaKey) && ctrlBlocked.has((e.key || '').toLowerCase())) ||
      (e.altKey && ['ArrowLeft', 'ArrowRight'].includes(e.key))
    ) {
      e.preventDefault();
      e.stopPropagation();
      toast('⛔ Navigasi diblokir saat ujian');
      return false;
    }
  }

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
        </div>
      `;
      document.body.appendChild(shield);
    }
    const text = shield.querySelector('#jlpt-lock-shield-text');
    if (text) text.textContent = reason || 'Admin belum membuka akses ujian ini.';
    shield.style.display = 'flex';
  }

  function hideExamLockShield() {
    const shield = document.getElementById('jlpt-exam-lock-shield');
    if (shield) shield.remove();
  }

  function enforceLockState() {
    if (!state.isExamPage) return;
    const locked = !!state.settings.exam_locked;
    const rowLocked = !!state.examLocks.get(examMetaFromPath().key)?.locked;
    const isLocked = (locked || rowLocked) && !state.isAdmin;
    if (isLocked) {
      state.examRunning = false;
      showExamLockShield(state.settings.exam_lock_reason || state.examLocks.get(examMetaFromPath().key)?.lock_reason || '');
    } else {
      hideExamLockShield();
    }
  }

  function installExamGuards() {
    if (!state.isExamPage) return;

    document.addEventListener('keydown', blockExamShortcuts, true);
    document.addEventListener('contextmenu', (e) => {
      if (state.examRunning) e.preventDefault();
    }, true);

    window.addEventListener('blur', () => {
      if (state.examRunning) syncSession('blur', false, true);
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && state.examRunning) syncSession('hidden', false, true);
      if (document.visibilityState === 'visible' && state.examRunning) syncSession('visible', false, true);
    });

    window.addEventListener('beforeunload', (e) => {
      if (!state.examRunning) return;
      try { syncSession('beforeunload', false, true); } catch {}
      e.preventDefault();
      e.returnValue = '';
      return '';
    });
  }

  function wrapFunction(name, afterHook) {
    const original = window[name];
    if (typeof original !== 'function' || original.__jlptWrapped) return false;

    const wrapped = function (...args) {
      const result = original.apply(this, args);
      afterHook?.(result, args);
      return result;
    };
    wrapped.__jlptWrapped = true;
    wrapped.__jlptOriginal = original;
    window[name] = wrapped;
    return true;
  }

  function observeExamFunctions() {
    if (!state.isExamPage) return;
    const timer = setInterval(() => {
      if (typeof window.startMode === 'function' && !window.startMode.__jlptWrapped) {
        const original = window.startMode;
        const wrapped = function (...args) {
          const currentLock = !!state.settings.exam_locked || !!state.examLocks.get(examMetaFromPath().key)?.locked;
          if (currentLock && !state.isAdmin) {
            showExamLockShield(state.settings.exam_lock_reason || state.examLocks.get(examMetaFromPath().key)?.lock_reason || '');
            toast('🔒 Ujian sedang dikunci admin');
            return;
          }
          state.examRunning = true;
          window.__JLPT_EXAM_FINISHED__ = false;
          window.__JLPT_SESSION_STARTED_AT__ = window.__JLPT_SESSION_STARTED_AT__ || new Date().toISOString();
          const result = original.apply(this, args);
          setTimeout(() => syncSession('start', false, true), 150);
          return result;
        };
        wrapped.__jlptWrapped = true;
        wrapped.__jlptOriginal = original;
        window.startMode = wrapped;
      }

      wrapFunction('selectAnswer', () => setTimeout(() => syncSession('answer'), 160));
      wrapFunction('nextQ', () => setTimeout(() => syncSession('next'), 120));
      wrapFunction('prevQ', () => setTimeout(() => syncSession('prev'), 120));
      wrapFunction('saveSessionManual', () => setTimeout(() => syncSession('save', false, true), 80));
      wrapFunction('loadSessionManual', () => setTimeout(() => syncSession('load', false, true), 80));

      if (typeof window.finishQuiz === 'function' && !window.finishQuiz.__jlptWrapped) {
        const original = window.finishQuiz;
        const wrapped = function (...args) {
          const result = original.apply(this, args);
          window.__JLPT_EXAM_FINISHED__ = true;
          state.examRunning = false;
          setTimeout(() => syncSession('done', true, true), 180);
          return result;
        };
        wrapped.__jlptWrapped = true;
        wrapped.__jlptOriginal = original;
        window.finishQuiz = wrapped;
      }

      wrapFunction('goHome', () => {
        state.examRunning = false;
        setTimeout(() => syncSession('home', false, true), 80);
      });
      wrapFunction('openReport', () => setTimeout(() => syncSession('report_open', false, true), 80));
      wrapFunction('closeReport', () => setTimeout(() => syncSession('report_close', false, true), 80));

      if (window.startMode?.__jlptWrapped && window.selectAnswer?.__jlptWrapped && window.finishQuiz?.__jlptWrapped) {
        clearInterval(timer);
      }
    }, 220);

    setTimeout(() => clearInterval(timer), 15000);
  }

  function examKeyFromHref(href = '') {
    const s = String(href || '').replace(/\\/g, '/');
    const m = s.match(/(\d{4})-(\d{2})-n([1-5])/i);
    if (m) return `n${m[3]}-${m[1]}-${m[2]}`;
    const m2 = s.match(/n([1-5])-(\d{4})-(\d{2})/i);
    if (m2) return `n${m2[1]}-${m2[2]}-${m2[3]}`;
    return '';
  }

  function ensureIndexBanner() {
    let banner = document.getElementById('jlpt-global-banner');
    if (banner) return banner;
    banner = document.createElement('div');
    banner.id = 'jlpt-global-banner';
    banner.style.cssText = 'display:none;margin:0 0 16px 0;padding:14px 16px;border-radius:18px;border:1px solid rgba(255,181,71,.28);background:rgba(255,181,71,.10);color:#ffd18a;font-size:13px;line-height:1.6;';
    banner.innerHTML = '<strong>🔒 Ujian sedang dikunci admin.</strong><br><span id="jlpt-global-banner-text">Tunggu persetujuan admin untuk membuka kembali ujian.</span>';
    const hero = document.querySelector('.hero');
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
    badge.textContent = text;
    badge.style.color = color;
    badge.style.background = background;
    badge.style.border = `1px solid ${borderColor || color}`;
  }

  function setCardLockedState(card, locked) {
    if (!card) return;
    card.dataset.jlptLocked = locked ? '1' : '';
    card.style.opacity = locked ? '0.72' : '';
    card.style.filter = locked ? 'saturate(0.8)' : '';
    const btn = card.querySelector('.open-btn');
    if (btn) {
      if (locked) {
        btn.setAttribute('aria-disabled', 'true');
        btn.style.pointerEvents = 'none';
        btn.style.opacity = '0.5';
        btn.style.filter = 'grayscale(0.25)';
        btn.title = 'Ujian sedang dikunci admin';
        btn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          toast('🔒 Ujian ini sedang dikunci admin');
          return false;
        };
      } else {
        btn.removeAttribute('aria-disabled');
        btn.style.pointerEvents = '';
        btn.style.opacity = '';
        btn.style.filter = '';
        btn.title = '';
        btn.onclick = function () {
          if (typeof window.recordExamOpen === 'function') window.recordExamOpen(this);
        };
      }
    }
    badgeForCard(card, locked ? 'Locked' : 'Open', locked ? '#ff9aaa' : '#5ff0b0', locked ? 'rgba(255,95,115,.12)' : 'rgba(25,195,125,.12)', locked ? 'rgba(255,95,115,.30)' : 'rgba(25,195,125,.30)');
  }

  async function renderIndexLockUI() {
    if (!state.isIndexPage) return;
    await loadSystemSettings();
    await loadExamLocks(true);

    const banner = ensureIndexBanner();
    const globalLocked = !!state.settings.exam_locked && !state.isAdmin;
    const lockValues = Array.from(state.examLocks.values());
    const lockedExamCount = lockValues.filter((r) => !!r.locked).length;

    banner.style.display = (globalLocked || lockedExamCount > 0) ? 'block' : 'none';
    const text = banner.querySelector('#jlpt-global-banner-text');
    if (text) {
      if (globalLocked) {
        text.textContent = state.settings.exam_lock_reason || 'Semua ujian sedang dikunci admin.';
      } else if (lockedExamCount > 0) {
        text.textContent = `${lockedExamCount} ujian sedang dikunci admin. Ujian lain tetap dapat dibuka.`;
      } else {
        text.textContent = 'Tunggu persetujuan admin untuk membuka kembali ujian.';
      }
    }

    const cards = document.querySelectorAll('.card[data-examkey], .card[data-name]');
    cards.forEach((card) => {
      const key = String(card.dataset.examkey || card.dataset.name || '').toLowerCase();
      const row = state.examLocks.get(key);
      const locked = (!!state.settings.exam_locked || !!row?.locked) && !state.isAdmin;
      setCardLockedState(card, locked);
    });

    const links = document.querySelectorAll('.open-btn');
    links.forEach((link) => {
      const href = link.getAttribute('href') || '';
      const key = examKeyFromHref(href);
      const row = state.examLocks.get(key);
      const locked = (!!state.settings.exam_locked || !!row?.locked) && !state.isAdmin;
      const card = link.closest('.card');
      setCardLockedState(card, locked);
    });
  }

  function getExamCatalog() {
    const catalog = [];
    if (Array.isArray(window._examList) && window._examList.length) {
      window._examList.forEach((e) => {
        catalog.push({
          key: String(e.key || '').toLowerCase(),
          level: String(e.level || '').toUpperCase(),
          year: e.year || '',
          title: e.title || '',
          href: e.href || '',
          isNew: !!e.isNew,
        });
      });
    }

    if (!catalog.length) {
      document.querySelectorAll('.exam-card-admin').forEach((card) => {
        const title = card.querySelector('.eca-title')?.textContent?.trim() || '';
        const level = card.querySelector('.eca-level')?.textContent?.trim() || '';
        const year = card.querySelector('.eca-year')?.textContent?.trim() || '';
        const href = card.querySelector('.eca-path')?.textContent?.trim() || '';
        const key = card.dataset.examkey || card.getAttribute('data-examkey') || examKeyFromHref(href) || '';
        catalog.push({ key: String(key).toLowerCase(), level, year, title, href, isNew: false });
      });
    }

    return catalog.filter((x, idx, arr) => x.key && arr.findIndex((y) => y.key === x.key) === idx);
  }

  async function refreshAdminLivePanel() {
    if (!state.isAdminPage) return;
    await loadUserMap();
    try {
      const { data, error } = await client
        .from('exam_progress')
        .select('*')
        .order('updated_at', { ascending: false })
        .limit(100);
      if (error) throw error;

      const rows = Array.isArray(data) ? data : [];
      const tbody = document.getElementById('jlpt-live-table');
      const count = document.getElementById('jlpt-live-count');
      if (count) count.textContent = `${rows.length} session`;

      if (!tbody) return;
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="padding:16px;color:var(--muted);">Belum ada sesi yang tersinkron.</td></tr>';
        return;
      }

      tbody.innerHTML = rows.map((row) => {
        const user = state.userMap.get(row.user_id) || {};
        const userLabel = user.display_name || user.full_name || user.email || row.user_id || '—';
        const when = fmtTime(row.updated_at);
        const rem = fmtSec(row.remaining_seconds);
        const progress = `${Number(row.current_q || 0)}/${Number(row.total_q || 0) || '—'} • ${Number(row.correct_count || 0)} benar • ${Number(row.percentage || 0).toFixed ? Number(row.percentage || 0).toFixed(2) : row.percentage || 0}%`;
        const status = String(row.status || 'active');
        const badgeColor = status === 'done' ? '#5ff0b0' : status === 'active' ? '#7cc0ff' : '#ffd18a';

        return `
          <tr>
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
            <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);font-weight:700;">${esc(rem)}</td>
            <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);font-size:12px;color:var(--muted);">${esc(when)}</td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      console.warn('refreshAdminLivePanel failed:', err?.message || err);
      const tbody = document.getElementById('jlpt-live-table');
      if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="padding:16px;color:#ff9aaa;">Gagal memuat live view.</td></tr>';
    }
  }

  async function refreshAdminResultsPanel() {
    if (!state.isAdminPage) return;
    await loadUserMap();
    try {
      const { data, error } = await client
        .from('exam_sessions')
        .select('*')
        .order('updated_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      const rows = Array.isArray(data) ? data : [];
      state.resultsCache = rows;

      const tbody = document.getElementById('jlpt-results-table');
      const count = document.getElementById('jlpt-results-count');
      if (count) count.textContent = `${rows.length} session`;

      if (!tbody) return;
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="padding:16px;color:var(--muted);">Belum ada hasil ujian.</td></tr>';
        return;
      }

      tbody.innerHTML = rows.map((row) => {
        const user = state.userMap.get(row.user_id) || {};
        const userLabel = user.display_name || user.full_name || user.email || row.user_id || '—';
        const pct = Number(row.percentage || 0);
        const sec = row.section_scores || {};
        const moji = sec.moji?.percentage ?? '—';
        const bun = sec.bunpou?.percentage ?? '—';
        const dok = sec.dokkai?.percentage ?? '—';
        return `
          <tr>
            <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);font-weight:700;">${esc(userLabel)}</td>
            <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);">${esc(row.exam_title || row.exam_key || '—')}</td>
            <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);font-family:'JetBrains Mono',monospace;">${esc(row.score ?? 0)}</td>
            <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);font-weight:700;">${esc(String(pct.toFixed ? pct.toFixed(2) : pct))}%</td>
            <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);">${esc(`${moji}% / ${bun}% / ${dok}%`)}</td>
            <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);font-size:12px;color:var(--muted);">${esc(fmtTime(row.started_at))}</td>
            <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);font-size:12px;color:var(--muted);">${esc(fmtTime(row.completed_at || row.updated_at))}</td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      console.warn('refreshAdminResultsPanel failed:', err?.message || err);
      const tbody = document.getElementById('jlpt-results-table');
      if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="padding:16px;color:#ff9aaa;">Gagal memuat hasil ujian.</td></tr>';
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

  function ensureAdminPanel() {
    const existing = document.getElementById('jlpt-sync-admin-wrap');
    if (existing) return existing;
    const mount = document.getElementById('pane-dashboard') || document.querySelector('.content') || document.body;
    const wrap = document.createElement('div');
    wrap.id = 'jlpt-sync-admin-wrap';
    wrap.style.cssText = 'margin:18px 0 28px;display:grid;gap:16px;';
    wrap.innerHTML = `
      <div id="jlpt-admin-global-card" style="background:var(--card);border:1px solid var(--border);border-radius:20px;padding:20px;box-shadow:0 8px 25px rgba(0,0,0,.18);">
        <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:14px;">
          <div>
            <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:800;margin-bottom:4px;">🔐 Kontrol Ujian Global</div>
            <div style="font-size:13px;color:var(--muted);line-height:1.6;">Lock / unlock semua exam dari sini. Status akan sinkron ke halaman user dan exam page secara realtime.</div>
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

      <div id="jlpt-exam-lock-card" style="background:var(--card);border:1px solid var(--border);border-radius:20px;padding:20px;box-shadow:0 8px 25px rgba(0,0,0,.18);">
        <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:14px;">
          <div>
            <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:800;margin-bottom:4px;">🧩 Lock / Unlock Per Exam</div>
            <div style="font-size:13px;color:var(--muted);line-height:1.6;">Centang satu atau beberapa ujian lalu pilih Lock/Unlock. Bisa custom satu, dua, atau semuanya.</div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button id="jlpt-lock-selected" class="topbar-btn" style="border-color:rgba(255,95,115,.35);color:#ff9aaa;background:rgba(255,95,115,.08);">🔒 Lock Selected</button>
            <button id="jlpt-unlock-selected" class="topbar-btn primary">🔓 Unlock Selected</button>
            <button id="jlpt-refresh-locks" class="topbar-btn">🔄 Reload List</button>
          </div>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;">
          <input id="jlpt-exam-search" placeholder="Cari exam..." style="flex:1;min-width:220px;background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:12px;padding:11px 14px;color:var(--text);font-family:inherit;font-size:14px;outline:none;">
          <select id="jlpt-exam-level" style="background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:12px;padding:11px 14px;color:var(--text);font-family:inherit;font-size:14px;outline:none;">
            <option value="">All Levels</option>
            <option value="N1">N1</option>
            <option value="N2">N2</option>
            <option value="N3">N3</option>
            <option value="N4">N4</option>
            <option value="N5">N5</option>
          </select>
        </div>
        <div id="jlpt-exam-lock-list" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;"></div>
      </div>

      <div id="jlpt-admin-live-card" style="background:var(--card);border:1px solid var(--border);border-radius:20px;overflow:hidden;box-shadow:0 8px 25px rgba(0,0,0,.18);">
        <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center;padding:18px 20px;border-bottom:1px solid var(--border);">
          <div>
            <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:800;margin-bottom:4px;">🟢 Live Exam Monitor</div>
            <div style="font-size:13px;color:var(--muted);line-height:1.6;">Lihat user yang sedang ujian, progress, dan sisa waktu secara realtime.</div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
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
      </div>

      <div id="jlpt-admin-results-card" style="background:var(--card);border:1px solid var(--border);border-radius:20px;overflow:hidden;box-shadow:0 8px 25px rgba(0,0,0,.18);">
        <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center;padding:18px 20px;border-bottom:1px solid var(--border);">
          <div>
            <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:800;margin-bottom:4px;">📈 Exam Results</div>
            <div style="font-size:13px;color:var(--muted);line-height:1.6;">Hasil akhir user tampil di sini dan bisa diekspor ke Excel dengan detail persentase per section.</div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button id="jlpt-export-xlsx" class="topbar-btn primary">📥 Export Excel</button>
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
                <th style="text-align:left;padding:12px 14px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);">Sections</th>
                <th style="text-align:left;padding:12px 14px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);">Started</th>
                <th style="text-align:left;padding:12px 14px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);">Completed</th>
              </tr>
            </thead>
            <tbody id="jlpt-results-table">
              <tr><td colspan="7" style="padding:16px;color:var(--muted);">Memuat...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `;

    mount.prepend(wrap);

    wrap.querySelector('#jlpt-lock-btn')?.addEventListener('click', async () => {
      const reasonInput = prompt('Alasan lock semua ujian (opsional):', state.settings.exam_lock_reason || '');
      const reason = (reasonInput ?? state.settings.exam_lock_reason) || '';
      await setGlobalLock(true, reason);
    });
    wrap.querySelector('#jlpt-unlock-btn')?.addEventListener('click', async () => {
      const reasonInput = prompt('Catatan unlock semua ujian (opsional):', state.settings.exam_lock_reason || '');
      const reason = (reasonInput ?? '');
      await setGlobalLock(false, reason);
    });
    wrap.querySelector('#jlpt-refresh-btn')?.addEventListener('click', () => refreshAdminPanels());
    wrap.querySelector('#jlpt-refresh-live')?.addEventListener('click', () => refreshAdminLivePanel());
    wrap.querySelector('#jlpt-refresh-results')?.addEventListener('click', () => refreshAdminResultsPanel());
    wrap.querySelector('#jlpt-refresh-locks')?.addEventListener('click', () => renderAdminControlUI());
    wrap.querySelector('#jlpt-lock-selected')?.addEventListener('click', async () => {
      const keys = Array.from(wrap.querySelectorAll('.jlpt-lock-check:checked')).map((el) => el.dataset.examKey);
      const reason = prompt('Alasan lock selected (opsional):', '') ?? '';
      await setMultipleExamLocks(keys, true, reason);
    });
    wrap.querySelector('#jlpt-unlock-selected')?.addEventListener('click', async () => {
      const keys = Array.from(wrap.querySelectorAll('.jlpt-lock-check:checked')).map((el) => el.dataset.examKey);
      const reason = prompt('Catatan unlock selected (opsional):', '') ?? '';
      await setMultipleExamLocks(keys, false, reason);
    });
    wrap.querySelector('#jlpt-exam-search')?.addEventListener('input', () => renderAdminControlUI());
    wrap.querySelector('#jlpt-exam-level')?.addEventListener('change', () => renderAdminControlUI());
    wrap.querySelector('#jlpt-export-xlsx')?.addEventListener('click', () => exportResultsExcel());

    state.adminPanelReady = true;
    return wrap;
  }

  function renderAdminControlUI() {
    if (!state.isAdminPage) return;
    const panel = ensureAdminPanel();
    const locked = !!state.settings.exam_locked;

    const pill = panel.querySelector('#jlpt-lock-pill');
    const stateText = panel.querySelector('#jlpt-lock-state');
    const updatedText = panel.querySelector('#jlpt-lock-updated');
    if (pill) {
      pill.textContent = locked ? 'LOCKED' : 'UNLOCKED';
      pill.style.color = locked ? '#ff9aaa' : '#5ff0b0';
      pill.style.borderColor = locked ? 'rgba(255,95,115,.35)' : 'rgba(25,195,125,.35)';
      pill.style.background = locked ? 'rgba(255,95,115,.1)' : 'rgba(25,195,125,.08)';
    }
    if (stateText) stateText.textContent = locked ? 'Semua ujian terkunci' : 'Semua ujian terbuka';
    if (updatedText) updatedText.textContent = state.settings.updated_at ? fmtTime(state.settings.updated_at) : '—';

    const search = String(panel.querySelector('#jlpt-exam-search')?.value || '').trim().toLowerCase();
    const level = String(panel.querySelector('#jlpt-exam-level')?.value || '').trim().toUpperCase();
    const catalog = getExamCatalog();
    const filtered = catalog.filter((e) => {
      const matchSearch = !search || `${e.key} ${e.title} ${e.level} ${e.year} ${e.href}`.toLowerCase().includes(search);
      const matchLevel = !level || String(e.level || '').toUpperCase() === level;
      return matchSearch && matchLevel;
    });

    const list = panel.querySelector('#jlpt-exam-lock-list');
    if (list) {
      if (!filtered.length) {
        list.innerHTML = '<div style="grid-column:1/-1;padding:18px;color:var(--muted);border:1px dashed var(--border);border-radius:16px;">Tidak ada exam yang cocok.</div>';
      } else {
        list.innerHTML = filtered.map((e) => {
          const row = state.examLocks.get(String(e.key).toLowerCase());
          const rowLocked = !!row?.locked;
          const updated = row?.updated_at ? fmtTime(row.updated_at) : '—';
          return `
            <div style="background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:16px;padding:14px 14px 12px;position:relative;">
              <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:10px;">
                <label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer;">
                  <input type="checkbox" class="jlpt-lock-check" data-exam-key="${esc(e.key)}" style="margin-top:3px;">
                  <div>
                    <div style="font-weight:800;font-size:14px;margin-bottom:4px;">${esc(e.title || e.key)}</div>
                    <div style="font-size:12px;color:var(--muted);">${esc(e.level || '')} · ${esc(e.year || '')} · ${esc(e.key)}</div>
                  </div>
                </label>
                <span style="padding:4px 10px;border-radius:999px;font-size:10px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;border:1px solid ${rowLocked ? 'rgba(255,95,115,.3)' : 'rgba(25,195,125,.3)'};color:${rowLocked ? '#ff9aaa' : '#5ff0b0'};background:${rowLocked ? 'rgba(255,95,115,.12)' : 'rgba(25,195,125,.08)'};">${rowLocked ? 'LOCKED' : 'OPEN'}</span>
              </div>
              <div style="display:flex;gap:8px;flex-wrap:wrap;">
                <button class="act-btn ban" onclick="window.JLPT_SYNC?.setExamLock('${esc(e.key)}', true)">Lock</button>
                <button class="act-btn approve" onclick="window.JLPT_SYNC?.setExamLock('${esc(e.key)}', false)">Unlock</button>
              </div>
              <div style="font-size:11px;color:var(--muted);margin-top:10px;">Updated: ${esc(updated)}</div>
            </div>
          `;
        }).join('');
      }
    }

    const globalCards = panel.querySelectorAll('#jlpt-admin-global-card, #jlpt-exam-lock-card, #jlpt-admin-live-card, #jlpt-admin-results-card');
    globalCards.forEach((card) => { if (card) card.style.display = ''; });
  }

  async function loadXLSX() {
    if (window.XLSX) return window.XLSX;
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/xlsx/dist/xlsx.full.min.js';
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Failed to load XLSX library'));
      document.head.appendChild(s);
    });
    return window.XLSX;
  }

  function sectionSummaryFromRow(row) {
    const sec = row.section_scores || {};
    const get = (k) => (sec[k] && typeof sec[k].percentage !== 'undefined') ? sec[k].percentage : null;
    return {
      moji_pct: get('moji'),
      bunpou_pct: get('bunpou'),
      dokkai_pct: get('dokkai'),
      moji_correct: sec.moji?.correct ?? null,
      bunpou_correct: sec.bunpou?.correct ?? null,
      dokkai_correct: sec.dokkai?.correct ?? null,
      moji_total: sec.moji?.total ?? null,
      bunpou_total: sec.bunpou?.total ?? null,
      dokkai_total: sec.dokkai?.total ?? null,
    };
  }

  async function exportResultsExcel() {
    try {
      await loadUserMap();
      const rows = Array.isArray(state.resultsCache) && state.resultsCache.length
        ? state.resultsCache
        : (await client.from('exam_sessions').select('*').order('updated_at', { ascending: false }).limit(1000)).data || [];

      if (!rows.length) {
        toast('Belum ada data untuk diekspor');
        return;
      }

      const XLSX = await loadXLSX();
      const wb = XLSX.utils.book_new();

      const summary = rows.map((row) => {
        const user = state.userMap.get(row.user_id) || {};
        const sec = sectionSummaryFromRow(row);
        const start = row.started_at ? new Date(row.started_at) : null;
        const end = row.completed_at ? new Date(row.completed_at) : (row.updated_at ? new Date(row.updated_at) : null);
        const durationMin = start && end ? Math.max((end - start) / 60000, 0) : null;

        return {
          user_name: user.display_name || user.full_name || user.email || row.user_id,
          user_email: user.email || '',
          user_id: row.user_id,
          exam_key: row.exam_key,
          exam_title: row.exam_title,
          level: row.level,
          mode: row.mode,
          score: row.score,
          percentage: Number(row.percentage || 0),
          correct_count: row.correct_count,
          wrong_count: row.wrong_count,
          total_questions: row.total_questions,
          completed: row.completed ? 'yes' : 'no',
          started_at: row.started_at,
          completed_at: row.completed_at,
          duration_minutes: durationMin == null ? null : Number(durationMin.toFixed(2)),
          moji_pct: sec.moji_pct,
          bunpou_pct: sec.bunpou_pct,
          dokkai_pct: sec.dokkai_pct,
          moji_correct: sec.moji_correct,
          bunpou_correct: sec.bunpou_correct,
          dokkai_correct: sec.dokkai_correct,
          moji_total: sec.moji_total,
          bunpou_total: sec.bunpou_total,
          dokkai_total: sec.dokkai_total,
          last_event: row.last_event,
          status: row.status,
        };
      });

      const detail = [];
      rows.forEach((row) => {
        const user = state.userMap.get(row.user_id) || {};
        const sec = row.section_scores || {};
        for (const [k, v] of Object.entries(sec)) {
          detail.push({
            user_name: user.display_name || user.full_name || user.email || row.user_id,
            user_email: user.email || '',
            exam_key: row.exam_key,
            exam_title: row.exam_title,
            section: k,
            correct: v?.correct ?? 0,
            total: v?.total ?? 0,
            percentage: v?.percentage ?? 0,
          });
        }
      });

      const live = (await client.from('exam_progress').select('*').order('updated_at', { ascending: false }).limit(1000)).data || [];
      const liveSheet = live.map((row) => {
        const user = state.userMap.get(row.user_id) || {};
        return {
          user_name: user.display_name || user.full_name || user.email || row.user_id,
          user_email: user.email || '',
          user_id: row.user_id,
          exam_key: row.exam_key,
          exam_title: row.exam_title,
          level: row.level,
          mode: row.mode,
          status: row.status,
          current_q: row.current_q,
          total_q: row.total_q,
          answered_count: row.answered_count,
          correct_count: row.correct_count,
          wrong_count: row.wrong_count,
          percentage: row.percentage,
          remaining_seconds: row.remaining_seconds,
          last_event: row.last_event,
          updated_at: row.updated_at,
        };
      });

      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), 'Summary');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detail), 'Section Detail');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(liveSheet), 'Live Progress');

      const fileName = `jlpt_results_${new Date().toISOString().slice(0, 10)}.xlsx`;
      XLSX.writeFile(wb, fileName);
      toast('✅ Excel berhasil diekspor');
    } catch (err) {
      console.error('exportResultsExcel failed:', err);
      toast('❌ Gagal export Excel');
    }
  }

  function subscribeRealtime() {
    try {
      if (state.settingsChannel) client.removeChannel(state.settingsChannel);
      if (state.progressChannel) client.removeChannel(state.progressChannel);
      if (state.lockChannel) client.removeChannel(state.lockChannel);
    } catch {}

    state.settingsChannel = client
      .channel('jlpt-system-settings-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'system_settings' }, async () => {
        await loadSystemSettings();
        renderIndexLockUI();
        renderAdminControlUI();
        enforceLockState();
      })
      .subscribe();

    state.lockChannel = client
      .channel('jlpt-exam-settings-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'exam_settings' }, async (payload) => {
        await loadExamLocks(true);
        renderIndexLockUI();
        renderAdminControlUI();
        enforceLockState();
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

  async function initPage() {
    const kind = pageKind();
    state.isAdminPage = kind === 'admin';
    state.isIndexPage = kind === 'index';
    state.isExamPage = kind === 'exam';

    const ctx = await getContext();
    if (ctx) {
      state.session = ctx.session;
      state.userDb = ctx.userDb;
      state.isAdmin = ctx.isAdmin;
    }

    await loadSystemSettings();
    await loadExamLocks(true);
    subscribeRealtime();

    if (state.isIndexPage) {
      renderIndexLockUI();
      if (location.search.includes('locked=1')) toast('Ujian masih dikunci admin');
    }

    if (state.isAdminPage) {
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
      // Re-check access if admin changes lock state while user is on the exam page.
      setInterval(async () => {
        await loadSystemSettings();
        await loadCurrentExamLock();
        enforceLockState();
      }, 8000);
    }
  }

  document.addEventListener('DOMContentLoaded', initPage);

  window.JLPT_SYNC = {
    setGlobalLock,
    setExamLock,
    setMultipleExamLocks,
    loadSystemSettings,
    loadExamLocks,
    renderIndexLockUI,
    renderAdminControlUI,
    refreshAdminLivePanel,
    refreshAdminResultsPanel,
    refreshAdminPanels,
    syncSession,
    exportResultsExcel,
    examMeta: examMetaFromPath,
  };
})();


/* ===== Extended account/device/notification features ===== */
(() => {
  const api = window.JLPT_SYNC;
  const state = window.__JLPT_SYNC__ || {};
  const sb = window._supabase || null;
  if (!api || !sb) return;

  const ui = window.__JLPT_EXT_UI__ = window.__JLPT_EXT_UI__ || {
    liveRange: localStorage.getItem('jlpt_admin_live_range') || 'all',
    resultsRange: localStorage.getItem('jlpt_admin_results_range') || 'all',
    resultsUser: localStorage.getItem('jlpt_admin_results_user') || 'all',
    liveUser: localStorage.getItem('jlpt_admin_live_user') || 'all',
  };

  const esc = (v) => String(v ?? '')
  const fmtSec = (sec) => {
    if (sec == null || Number.isNaN(Number(sec))) return '—';
    const s = Math.max(0, Math.floor(Number(sec)));
    const mm = Math.floor(s / 60);
    const ss = s % 60;
    return `${mm}:${String(ss).padStart(2, '0')}`;
  };

    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const nowIso = () => new Date().toISOString();

  async function loadUsersMap() {
    try {
      const { data } = await sb.from('users').select('id,full_name,display_name,email,role,status');
      const map = new Map();
      (data || []).forEach(u => map.set(u.id, u));
      return map;
    } catch {
      return new Map();
    }
  }

  function sinceFor(range) {
    const now = new Date();
    const d = new Date(now);
    switch (String(range || 'all')) {
      case '15m': d.setMinutes(d.getMinutes() - 15); return d;
      case '30m': d.setMinutes(d.getMinutes() - 30); return d;
      case '1h': d.setHours(d.getHours() - 1); return d;
      case 'today': d.setHours(0, 0, 0, 0); return d;
      case 'week': d.setDate(d.getDate() - 7); return d;
      case 'month': d.setMonth(d.getMonth() - 1); return d;
      default: return null;
    }
  }

  function withinRange(ts, range) {
    const since = sinceFor(range);
    if (!since) return true;
    const d = ts ? new Date(ts) : null;
    if (!d || Number.isNaN(d.getTime())) return false;
    return d >= since;
  }

  function badgeForSession(status) {
    const s = String(status || 'active');
    const color = s === 'done' ? '#5ff0b0' : s === 'active' ? '#7cc0ff' : '#ffd18a';
    return `<span style="padding:4px 10px;border-radius:999px;font-size:11px;font-weight:800;border:1px solid rgba(255,255,255,.12);color:${color};">${esc(s)}</span>`;
  }

  async function notifyUsers(userIds, title, message, status = 'done', meta = {}) {
    const ids = Array.from(new Set((userIds || []).filter(Boolean)));
    if (!ids.length) return true;
    const rows = ids.map(user_id => ({
      user_id,
      status,
      message,
      is_read: false,
      title,
      meta,
      created_at: nowIso(),
    }));
    const { error } = await sb.from('notifications').insert(rows);
    if (error) throw error;
    return true;
  }

  async function notifyAllActiveUsers(title, message, status = 'done', meta = {}) {
    const { data, error } = await sb.from('users').select('id').eq('status', 'active');
    if (error) throw error;
    return notifyUsers((data || []).map(x => x.id), title, message, status, meta);
  }

  async function notifySingleUser(userId, title, message, status = 'done', meta = {}) {
    return notifyUsers([userId], title, message, status, meta);
  }

  async function ensureDeviceRow() {
    try {
      if (!window._session?.user?.id) return null;
      const deviceId = localStorage.getItem('jlpt_device_id') || (() => {
        const v = 'dev_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem('jlpt_device_id', v);
        return v;
      })();
      const ua = navigator.userAgent || '';
      const platform = navigator.platform || '';
      const row = {
        user_id: window._session.user.id,
        device_id: deviceId,
        device_name: localStorage.getItem('jlpt_device_name') || (navigator.userAgentData?.platform || platform || 'Unknown device'),
        browser: ua,
        platform,
        session_token: window._session.access_token || '',
        last_seen_at: nowIso(),
        is_current: true,
        revoked_at: null,
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      const { error } = await sb.from('user_sessions').upsert(row, { onConflict: 'user_id,device_id' });
      if (error) throw error;
      return row;
    } catch (err) {
      console.warn('[jlpt-ext] ensureDeviceRow failed:', err?.message || err);
      return null;
    }
  }

  async function checkDeviceRevoked() {
    try {
      if (!window._session?.user?.id) return false;
      const deviceId = localStorage.getItem('jlpt_device_id');
      if (!deviceId) return false;
      const { data, error } = await sb.from('user_sessions')
        .select('id,revoked_at,is_current')
        .eq('user_id', window._session.user.id)
        .eq('device_id', deviceId)
        .maybeSingle();
      if (error) throw error;
      if (data && (data.revoked_at || data.is_current === false)) {
        await sb.auth.signOut();
        window.location.replace('./auth.html');
        return true;
      }
      return false;
    } catch (err) {
      console.warn('[jlpt-ext] checkDeviceRevoked failed:', err?.message || err);
      return false;
    }
  }

  async function loadMyDeviceSessions() {
    if (!window._session?.user?.id) return [];
    const { data, error } = await sb.from('user_sessions')
      .select('*')
      .eq('user_id', window._session.user.id)
      .order('last_seen_at', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async function revokeDeviceSession(sessionId) {
    const ctx = window.__JLPT_SYNC__;
    const isAdmin = !!ctx?.isAdmin;
    try {
      const { error } = await sb.from('user_sessions')
        .update({ revoked_at: nowIso(), is_current: false, updated_at: nowIso() })
        .eq('id', sessionId);
      if (error) throw error;
      return true;
    } catch (err) {
      console.warn('[jlpt-ext] revokeDeviceSession failed:', err?.message || err);
      return false;
    }
  }

  function ensureIndexSecurityButtons() {
    const actions = document.querySelector('.profile-actions');
    if (!actions || document.getElementById('securityBtn')) return;
    const sec = document.createElement('button');
    sec.id = 'securityBtn';
    sec.className = 'logout-btn-sm';
    sec.style.marginTop = '0';
    sec.textContent = '🔐 Security';
    sec.onclick = openSecurityModal;
    actions.insertBefore(sec, actions.querySelector('.logout-btn-sm') || null);

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'securityModal';
    modal.innerHTML = `
      <div class="modal modal-wide" style="max-width:720px;">
        <div class="modal-title">🔐 Security & Devices</div>
        <div class="config-desc">Ubah password, lihat login history, dan logout device yang sudah tidak dipakai.</div>
        <div class="form-row">
          <div class="form-group">
            <label>Password baru</label>
            <input class="form-input" type="password" id="newPwd1" placeholder="Password baru">
          </div>
          <div class="form-group">
            <label>Ulangi password</label>
            <input class="form-input" type="password" id="newPwd2" placeholder="Ulangi password">
          </div>
        </div>
        <div class="modal-actions">
          <button class="modal-save" onclick="changePassword()">🔄 Ganti Password</button>
          <button class="modal-cancel" onclick="openDeviceModal()">📱 Login Device</button>
        </div>
        <div style="margin-top:18px;">
          <button class="act-btn delete" onclick="deleteAccount()">🗑️ Hapus Akun</button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    const dev = document.createElement('div');
    dev.className = 'modal-overlay';
    dev.id = 'deviceModal';
    dev.innerHTML = `
      <div class="modal modal-wide" style="max-width:900px;">
        <div class="modal-title">📱 Login History & Device Control</div>
        <div class="table-wrap" style="max-height:70vh;overflow:auto;">
          <div class="table-head">
            <div class="table-title">Perangkat Login</div>
            <div class="table-actions">
              <button class="topbar-btn" onclick="refreshDeviceSessions()">🔄 Refresh</button>
            </div>
          </div>
          <table>
            <thead><tr>
              <th>Device</th><th>Browser</th><th>Last Seen</th><th>Status</th><th>Aksi</th>
            </tr></thead>
            <tbody id="deviceSessionsTable"><tr><td colspan="5" style="padding:16px;color:var(--muted);">Memuat...</td></tr></tbody>
          </table>
        </div>
        <div class="modal-footer">
          <button class="modal-cancel" onclick="closeModal('deviceModal')">Tutup</button>
        </div>
      </div>`;
    document.body.appendChild(dev);
  }

  async function renderMyDeviceSessions() {
    const tbody = document.getElementById('deviceSessionsTable');
    if (!tbody) return;
    try {
      const rows = await loadMyDeviceSessions();
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="padding:16px;color:var(--muted);">Belum ada login device.</td></tr>';
        return;
      }
      tbody.innerHTML = rows.map(r => `
        <tr>
          <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);font-weight:700;">${esc(r.device_name || r.device_id || '—')}</td>
          <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);font-size:12px;color:var(--muted);word-break:break-word;">${esc((r.browser || '').slice(0,120))}</td>
          <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);font-size:12px;">${esc(new Date(r.last_seen_at || r.created_at).toLocaleString())}</td>
          <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);">${r.revoked_at ? '<span class="status rejected">Revoked</span>' : '<span class="status active">Active</span>'}</td>
          <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);">
            ${r.revoked_at ? '—' : `<button type="button" class="act-btn delete" onclick="revokeMyDevice('${esc(r.id)}')">Logout Device</button>`}
          </td>
        </tr>
      `).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5" style="padding:16px;color:#ff9aaa;">${esc(err.message || err)}</td></tr>`;
    }
  }

  async function syncHistoryFromDb() {
    try {
      if (!window._session?.user?.id) return;
      const { data, error } = await sb.from('exam_sessions')
        .select('exam_key,exam_title,level,year,score,completed_at,updated_at,completed,percentage')
        .eq('user_id', window._session.user.id)
        .order('completed_at', { ascending: false });
      if (error) throw error;
      const history = loadHistory();
      const map = new Map(history.map(h => [h.key, h]));
      (data || []).forEach(row => {
        if (!row.completed && !row.completed_at) return;
        const entry = map.get(row.exam_key) || { key: row.exam_key, count: 0 };
        entry.name = row.exam_title || entry.name || row.exam_key;
        entry.level = row.level || entry.level || '';
        entry.year = row.year || entry.year || '';
        entry.score = row.score ?? entry.score ?? null;
        entry.percentage = row.percentage ?? entry.percentage ?? null;
        entry.completedAt = row.completed_at || row.updated_at || new Date().toISOString();
        entry.count = (entry.count || 0) + 1;
        map.set(row.exam_key, entry);
      });
      const merged = [...map.values()].sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
      saveHistory(merged);
      updateCompletedBadges();
      updateCompletedStat();
    } catch (err) {
      console.warn('[jlpt-ext] syncHistoryFromDb failed:', err?.message || err);
    }
  }

  async function changePassword() {
    const p1 = document.getElementById('newPwd1')?.value || '';
    const p2 = document.getElementById('newPwd2')?.value || '';
    if (!p1 || p1.length < 8) return showToast('⚠️ Password minimal 8 karakter');
    if (p1 !== p2) return showToast('⚠️ Password tidak sama');
    try {
      const { error } = await sb.auth.updateUser({ password: p1 });
      if (error) throw error;
      showToast('✅ Password diperbarui');
      closeModal('securityModal');
    } catch (err) {
      showToast('❌ Gagal ganti password: ' + (err.message || err));
    }
  }

  async function deleteAccount() {
    if (!confirm('Hapus akun ini secara permanen? Data login, history, progress, dan notifikasi akan dihapus.')) return;
    try {
      const { error } = await sb.rpc('delete_my_account');
      if (error) throw error;
      await sb.auth.signOut();
      window.location.replace('./auth.html');
    } catch (err) {
      showToast('❌ Gagal hapus akun: ' + (err.message || err));
    }
  }

  function openSecurityModal() { openModal('securityModal'); }
  function openDeviceModal() { openModal('deviceModal'); renderMyDeviceSessions(); }
  function refreshDeviceSessions() { renderMyDeviceSessions(); }
  async function revokeMyDevice(sessionId) {
    if (!confirm('Logout device ini?')) return;
    const ok = await revokeDeviceSession(sessionId);
    if (ok) {
      showToast('✅ Device dilogout');
      renderMyDeviceSessions();
    } else {
      showToast('❌ Gagal logout device');
    }
  }

  function wrapGotoForActivity() {
    if (window.goto && !window.goto.__jlptWrapped) {
      const original = window.goto;
      window.goto = function (pane) {
        const out = original.apply(this, arguments);
        const titleMap = {
          dashboard:'Dashboard',
          upload:'Upload Soal Baru',
          exams:'Kelola Soal',
          editor:'Editor Soal',
          reports:'Laporan Error Soal',
          requests:'Request Soal',
          users:'Semua User',
          pending:'User Pending Approval',
          github:'GitHub & Telegram Config',
          examlock:'Exam Lock Manager',
          livemonitor:'Live Exam Monitor',
          examresults:'Exam Results',
          devices:'Login Device',
        };
        if (typeof pushActivity === 'function') {
          const t = titleMap[pane] || pane;
          pushActivity('view', `Buka panel ${t}`, `Admin membuka ${t}`);
        }
        return out;
      };
      window.goto.__jlptWrapped = true;
    }
  }

  function wrapAdminActions() {
    const wrapAsync = (name, cb) => {
      const orig = window[name];
      if (typeof orig !== 'function' || orig.__jlptWrapped) return;
      const wrapped = async function(...args) {
        const res = await orig.apply(this, args);
        try { await cb?.(res, args); } catch (e) { console.warn('[jlpt-ext] action hook failed', name, e); }
        return res;
      };
      wrapped.__jlptWrapped = true;
      window[name] = wrapped;
    };

    wrapAsync('doUpload', async () => {
      try {
        const level = document.getElementById('upLevel')?.value || '';
        const year = document.getElementById('upYear')?.value || '';
        const month = document.getElementById('upMonth')?.value || '';
        const title = `${level.toUpperCase()} ${year}-${month}`;
        if (typeof pushActivity === 'function') pushActivity('upload', 'Upload soal baru', title, { level, year, month });
        await notifyAllActiveUsers('Soal baru tersedia', `Soal baru telah ditambahkan: ${title}`, 'done', { type: 'exam_upload', level, year, month });
      } catch (e) {}
    });

    wrapAsync('saveExamInfo', async () => {
      try {
        const key = document.getElementById('eeKey')?.value || '';
        const title = document.getElementById('eeTitle')?.value || '';
        if (typeof pushActivity === 'function') pushActivity('edit', 'Info soal diperbarui', `${key} — ${title}`, { key, title });
        await notifyAllActiveUsers('Soal diperbarui', `Admin memperbarui soal: ${title || key}`, 'done', { type: 'exam_update', key, title });
      } catch (e) {}
    });

    wrapAsync('saveEditUser', async () => {
      if (typeof pushActivity === 'function') pushActivity('edit', 'User diperbarui', document.getElementById('euName')?.value || '—');
    });

    wrapAsync('changeUserStatus', async (_res, args) => {
      const [id, status] = args || [];
      if (typeof pushActivity === 'function') pushActivity('user', 'Status user berubah', `${id} -> ${status}`);
    });

    const origResolveReport = window.resolveReport;
    if (typeof origResolveReport === 'function' && !origResolveReport.__jlptWrapped) {
      window.resolveReport = async function(id) {
        const report = await sb.from('exam_reports').select('*').eq('id', id).maybeSingle();
        const res = await origResolveReport.apply(this, arguments);
        const row = report?.data || null;
        if (row) {
          if (typeof pushActivity === 'function') pushActivity('edit', 'Laporan diselesaikan', row.exam_title || row.exam_key || row.description || '—', { id: row.id });
          if (row.user_id) await notifySingleUser(row.user_id, 'Laporan diperbaiki', `Laporan soal kamu sudah diperbaiki: ${row.exam_title || row.exam_key || ''}`, 'done', { type: 'report_resolved', report_id: row.id });
        }
        return res;
      };
      window.resolveReport.__jlptWrapped = true;
    }

    const origDeleteReport = window.deleteReport;
    if (typeof origDeleteReport === 'function' && !origDeleteReport.__jlptWrapped) {
      window.deleteReport = async function(id) {
        const report = await sb.from('exam_reports').select('*').eq('id', id).maybeSingle();
        const res = await origDeleteReport.apply(this, arguments);
        const row = report?.data || null;
        if (row && typeof pushActivity === 'function') pushActivity('delete', 'Laporan dihapus', row.exam_title || row.exam_key || row.description || '—');
        return res;
      };
      window.deleteReport.__jlptWrapped = true;
    }

    const origSetRequestStatus = window.setRequestStatus;
    if (typeof origSetRequestStatus === 'function' && !origSetRequestStatus.__jlptWrapped) {
      window.setRequestStatus = async function(id, status) {
        const req = await sb.from('exam_requests').select('*').eq('id', id).maybeSingle();
        const res = await origSetRequestStatus.apply(this, arguments);
        const row = req?.data || null;
        if (row) {
          if (typeof pushActivity === 'function') pushActivity('edit', 'Request soal diubah', `${row.level || ''} ${row.types || ''}`.trim() || '—', { id: row.id, status });
          if (row.user_id) {
            await notifySingleUser(row.user_id, 'Request soal diupdate', `Status request soal kamu sekarang: ${status}`, status === 'rejected' ? 'rejected' : 'done', { type: 'request_status', request_id: row.id });
          }
        }
        return res;
      };
      window.setRequestStatus.__jlptWrapped = true;
    }

    const origConfirmDeleteUser = window.confirmDeleteUser;
    if (typeof origConfirmDeleteUser === 'function' && !origConfirmDeleteUser.__jlptWrapped) {
      window.confirmDeleteUser = function(id, name) {
        if (typeof pushActivity === 'function') pushActivity('delete', 'Hapus user', name || id || '—');
        return origConfirmDeleteUser.apply(this, arguments);
      };
      window.confirmDeleteUser.__jlptWrapped = true;
    }
  }

  async function refreshAdminDevicesPanel() {
    const mount = document.getElementById('jlpt-devices-mount');
    if (!mount) return;
    const usersMap = await loadUsersMap();
    try {
      const { data, error } = await sb.from('user_sessions').select('*').order('last_seen_at', { ascending: false }).limit(300);
      if (error) throw error;
      const rows = Array.isArray(data) ? data : [];
      const q = (document.getElementById('deviceSearch')?.value || '').toLowerCase();
      const filtered = rows.filter(r => {
        const u = usersMap.get(r.user_id) || {};
        const text = [u.full_name, u.display_name, u.email, r.device_name, r.browser, r.platform, r.device_id].join(' ').toLowerCase();
        return !q || text.includes(q);
      });
      mount.innerHTML = `
        <div class="config-wrap">
          <div class="config-title">📱 Login History & Device Control</div>
          <div class="config-desc">Lihat perangkat login, last seen, dan logout device yang tidak dipakai.</div>
          <div class="table-head" style="padding:0 0 14px 0;border-bottom:none;">
            <div class="table-actions" style="display:flex;gap:8px;flex-wrap:wrap;">
              <input class="search-mini" id="deviceSearch" placeholder="Cari user/device..." value="${esc(q)}" oninput="window.JLPT_SYNC.refreshAdminDevicesPanel()">
              <button class="topbar-btn primary" type="button" onclick="window.JLPT_SYNC.refreshAdminDevicesPanel()">🔄 Refresh</button>
            </div>
            <span class="section-count">${filtered.length} device</span>
          </div>
          <div class="table-wrap" style="overflow:auto;">
            <table>
              <thead><tr>
                <th>User</th><th>Device</th><th>Browser</th><th>Last Seen</th><th>Status</th><th>Aksi</th>
              </tr></thead>
              <tbody>
                ${filtered.length ? filtered.map(r => {
                  const u = usersMap.get(r.user_id) || {};
                  const user = u.display_name || u.full_name || u.email || r.user_id || '—';
                  const status = r.revoked_at ? 'revoked' : (r.is_current ? 'current' : 'active');
                  return `
                    <tr>
                      <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);">
                        <div style="font-weight:700;">${esc(user)}</div>
                        <div style="font-size:11px;color:var(--muted);">${esc(u.email || '')}</div>
                      </td>
                      <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);font-size:12px;">${esc(r.device_name || r.device_id || '—')}</td>
                      <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);font-size:12px;color:var(--muted);word-break:break-word;">${esc((r.browser || '').slice(0,140))}</td>
                      <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);font-size:12px;">${esc(new Date(r.last_seen_at || r.created_at).toLocaleString())}</td>
                      <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);">${status === 'revoked' ? '<span class="status rejected">revoked</span>' : status === 'current' ? '<span class="status active">current</span>' : '<span class="status pending">active</span>'}</td>
                      <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);">
                        ${r.revoked_at ? '—' : `<button class="act-btn delete" type="button" onclick="window.JLPT_SYNC.revokeDeviceSession('${r.id}')">Logout</button>`}
                      </td>
                    </tr>`;
                }).join('') : '<tr><td colspan="6" style="padding:16px;color:var(--muted);">Tidak ada device login.</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>`;
    } catch (err) {
      mount.innerHTML = `<div class="config-wrap"><div class="config-desc">❌ Gagal memuat device sessions: ${esc(err.message || err)}</div></div>`;
    }
  }

  async function revokeAdminDevice(sessionId) {
    try {
      const { error } = await sb.from('user_sessions').update({ revoked_at: nowIso(), is_current: false, updated_at: nowIso() }).eq('id', sessionId);
      if (error) throw error;
      await refreshAdminDevicesPanel();
      if (typeof pushActivity === 'function') pushActivity('delete', 'Logout device', sessionId);
      return true;
    } catch (err) {
      console.warn('[jlpt-ext] revokeAdminDevice failed:', err?.message || err);
      return false;
    }
  }

  async function refreshAdminLivePanelEnhanced() {
    const mount = document.getElementById('jlpt-livemonitor-mount');
    if (!mount) return;
    const usersMap = await loadUsersMap();
    const range = ui.liveRange;
    const userFilter = ui.liveUser;
    try {
      const { data, error } = await sb.from('exam_progress').select('*').order('updated_at', { ascending: false }).limit(500);
      if (error) throw error;
      const rows = (Array.isArray(data) ? data : []).filter(r => withinRange(r.updated_at, range) && (userFilter === 'all' || String(r.user_id) === String(userFilter)));
      const options = [...new Map(rows.map(r => [r.user_id, usersMap.get(r.user_id) || {}])).entries()].map(([id, u]) => {
        const label = u.display_name || u.full_name || u.email || id || '—';
        return `<option value="${esc(id)}" ${String(userFilter)===String(id)?'selected':''}>${esc(label)}</option>`;
      }).join('');
      mount.innerHTML = `
        <div class="config-wrap">
          <div class="config-title">🟢 Live Exam Monitor</div>
          <div class="config-desc">Pantau progress user secara realtime. Filter waktu dan user membantu export serta pengecekan cepat.</div>
          <div class="table-head" style="padding:0 0 14px 0;border-bottom:none;">
            <div class="table-actions" style="display:flex;gap:8px;flex-wrap:wrap;">
              <select class="form-input" id="liveRangeSel" style="width:180px;">
                ${['all','15m','30m','1h','today','week','month'].map(k=>`<option value="${k}" ${range===k?'selected':''}>${k==='all'?'Semua':k==='15m'?'15 minutes ago':k==='30m'?'30 minutes ago':k==='1h'?'1 hour ago':k==='today'?'Today':k==='week'?'Last week':'Last month'}</option>`).join('')}
              </select>
              <select class="form-input" id="liveUserSel" style="min-width:220px;">
                <option value="all" ${userFilter==='all'?'selected':''}>Semua user</option>
                ${options}
              </select>
              <button class="topbar-btn primary" type="button" onclick="window.JLPT_SYNC.refreshAdminLivePanel()">🔄 Refresh</button>
            </div>
            <span class="section-count">${rows.length} session</span>
          </div>
          <div class="table-wrap" style="overflow:auto;">
            <table>
              <thead><tr>
                <th>User</th><th>Exam</th><th>Progress</th><th>Remaining</th><th>Updated</th><th>Aksi</th>
              </tr></thead>
              <tbody id="jlpt-live-table">
                ${rows.length ? rows.map((row) => {
                  const u = usersMap.get(row.user_id) || {};
                  const userLabel = u.display_name || u.full_name || u.email || row.user_id || '—';
                  const progress = `${Number(row.current_q || 0)}/${Number(row.total_q || 0) || '—'} • ${Number(row.correct_count || 0)} benar • ${Number(row.percentage || 0).toFixed(2)}%`;
                  const when = new Date(row.updated_at).toLocaleString();
                  return `
                    <tr>
                      <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);">
                        <div style="font-weight:700;">${esc(userLabel)}</div>
                        <div style="font-size:11px;color:var(--muted);">${esc(row.user_id || '')}</div>
                      </td>
                      <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);">
                        <div style="font-weight:700;">${esc(row.exam_title || row.exam_key || '—')}</div>
                        <div style="font-size:11px;color:var(--muted);">${esc(`${row.level || ''} ${row.mode || ''}`.trim())}</div>
                      </td>
                      <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);font-family:'JetBrains Mono',monospace;">${esc(progress)}</td>
                      <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);font-weight:700;">${esc(fmtSec(row.remaining_seconds))}</td>
                      <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);font-size:12px;color:var(--muted);">${esc(when)}</td>
                      <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);">
                        <button class="act-btn delete" type="button" onclick="window.JLPT_SYNC.deleteExamSession('${esc(row.user_id)}','${esc(row.exam_key)}')">🗑️ Delete</button>
                      </td>
                    </tr>`;
                }).join('') : '<tr><td colspan="6" style="padding:16px;color:var(--muted);">Belum ada sesi yang tersinkron.</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>`;

      document.getElementById('liveRangeSel')?.addEventListener('change', e => {
        ui.liveRange = e.target.value;
        localStorage.setItem('jlpt_admin_live_range', ui.liveRange);
        refreshAdminLivePanelEnhanced();
      });
      document.getElementById('liveUserSel')?.addEventListener('change', e => {
        ui.liveUser = e.target.value;
        localStorage.setItem('jlpt_admin_live_user', ui.liveUser);
        refreshAdminLivePanelEnhanced();
      });
    } catch (err) {
      mount.innerHTML = `<div class="config-wrap"><div class="config-desc">❌ Gagal memuat live view: ${esc(err.message || err)}</div></div>`;
    }
  }

  async function refreshAdminResultsPanelEnhanced() {
    const mount = document.getElementById('jlpt-examresults-mount');
    if (!mount) return;
    const usersMap = await loadUsersMap();
    const range = ui.resultsRange;
    const userFilter = ui.resultsUser;
    try {
      const { data, error } = await sb.from('exam_sessions').select('*').order('updated_at', { ascending: false }).limit(500);
      if (error) throw error;
      const rows = (Array.isArray(data) ? data : []).filter(r => withinRange(r.completed_at || r.updated_at, range) && (userFilter === 'all' || String(r.user_id) === String(userFilter)));
      const options = [...new Map(rows.map(r => [r.user_id, usersMap.get(r.user_id) || {}])).entries()].map(([id, u]) => {
        const label = u.display_name || u.full_name || u.email || id || '—';
        return `<option value="${esc(id)}" ${String(userFilter)===String(id)?'selected':''}>${esc(label)}</option>`;
      }).join('');
      mount.innerHTML = `
        <div class="config-wrap">
          <div class="config-title">📈 Exam Results</div>
          <div class="config-desc">Filter hasil berdasarkan waktu atau user sebelum export Excel.</div>
          <div class="table-head" style="padding:0 0 14px 0;border-bottom:none;">
            <div class="table-actions" style="display:flex;gap:8px;flex-wrap:wrap;">
              <select class="form-input" id="resultsRangeSel" style="width:180px;">
                ${['all','15m','30m','1h','today','week','month'].map(k=>`<option value="${k}" ${range===k?'selected':''}>${k==='all'?'Semua':k==='15m'?'15 minutes ago':k==='30m'?'30 minutes ago':k==='1h'?'1 hour ago':k==='today'?'Today':k==='week'?'Last week':'Last month'}</option>`).join('')}
              </select>
              <select class="form-input" id="resultsUserSel" style="min-width:220px;">
                <option value="all" ${userFilter==='all'?'selected':''}>Semua user</option>
                ${options}
              </select>
              <button class="topbar-btn primary" type="button" onclick="window.JLPT_SYNC.exportResultsExcel()">📥 Export Excel</button>
              <button class="topbar-btn" type="button" onclick="window.JLPT_SYNC.refreshAdminResultsPanel()">🔄 Refresh</button>
            </div>
            <span class="section-count">${rows.length} session</span>
          </div>
          <div class="table-wrap" style="overflow:auto;">
            <table>
              <thead><tr>
                <th>User</th><th>Exam</th><th>Score</th><th>%</th><th>Section</th><th>Started</th><th>Completed</th><th>Aksi</th>
              </tr></thead>
              <tbody id="jlpt-results-table">
                ${rows.length ? rows.map((row) => {
                  const u = usersMap.get(row.user_id) || {};
                  const userLabel = u.display_name || u.full_name || u.email || row.user_id || '—';
                  const pct = Number(row.percentage || 0).toFixed(2);
                  const sec = row.section_scores || {};
                  const moji = sec.moji?.percentage ?? '—';
                  const bun = sec.bunpou?.percentage ?? '—';
                  const dok = sec.dokkai?.percentage ?? '—';
                  return `
                    <tr>
                      <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);font-weight:700;">${esc(userLabel)}</td>
                      <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);">${esc(row.exam_title || row.exam_key || '—')}</td>
                      <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);font-family:'JetBrains Mono',monospace;">${esc(row.score ?? 0)}</td>
                      <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);font-weight:700;">${esc(pct)}%</td>
                      <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);">${esc(`${moji}% / ${bun}% / ${dok}%`)}</td>
                      <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);font-size:12px;color:var(--muted);">${esc(new Date(row.started_at || row.updated_at).toLocaleString())}</td>
                      <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);font-size:12px;color:var(--muted);">${esc(new Date(row.completed_at || row.updated_at).toLocaleString())}</td>
                      <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);">
                        <button class="act-btn delete" type="button" onclick="window.JLPT_SYNC.deleteExamSession('${esc(row.user_id)}','${esc(row.exam_key)}')">🗑️ Delete</button>
                      </td>
                    </tr>`;
                }).join('') : '<tr><td colspan="8" style="padding:16px;color:var(--muted);">Belum ada hasil ujian.</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>`;

      document.getElementById('resultsRangeSel')?.addEventListener('change', e => {
        ui.resultsRange = e.target.value;
        localStorage.setItem('jlpt_admin_results_range', ui.resultsRange);
        refreshAdminResultsPanelEnhanced();
      });
      document.getElementById('resultsUserSel')?.addEventListener('change', e => {
        ui.resultsUser = e.target.value;
        localStorage.setItem('jlpt_admin_results_user', ui.resultsUser);
        refreshAdminResultsPanelEnhanced();
      });
    } catch (err) {
      mount.innerHTML = `<div class="config-wrap"><div class="config-desc">❌ Gagal memuat hasil ujian: ${esc(err.message || err)}</div></div>`;
    }
  }

  async function deleteExamSession(userId, examKey) {
    if (!userId || !examKey) return false;
    if (!confirm('Hapus session user ini?')) return false;
    try {
      const [a, b] = await Promise.all([
        sb.from('exam_progress').delete().eq('user_id', userId).eq('exam_key', examKey),
        sb.from('exam_sessions').delete().eq('user_id', userId).eq('exam_key', examKey),
      ]);
      if (a?.error) throw a.error;
      if (b?.error) throw b.error;
      if (typeof pushActivity === 'function') pushActivity('delete', 'Hapus session user', `${userId} / ${examKey}`);
      await refreshAdminLivePanelEnhanced();
      await refreshAdminResultsPanelEnhanced();
      return true;
    } catch (err) {
      showToast?.('❌ Gagal hapus session: ' + (err.message || err), 'error');
      return false;
    }
  }

  async function loadXLSX() {
    if (window.XLSX) return window.XLSX;
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.full.min.js';
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
    return window.XLSX;
  }

  function sectionSummary(row) {
    const sec = row?.section_scores || {};
    return {
      moji_pct: sec.moji?.percentage ?? null,
      bunpou_pct: sec.bunpou?.percentage ?? null,
      dokkai_pct: sec.dokkai?.percentage ?? null,
      moji_correct: sec.moji?.correct ?? null,
      bunpou_correct: sec.bunpou?.correct ?? null,
      dokkai_correct: sec.dokkai?.correct ?? null,
      moji_total: sec.moji?.total ?? null,
      bunpou_total: sec.bunpou?.total ?? null,
      dokkai_total: sec.dokkai?.total ?? null,
    };
  }

  async function exportResultsExcelEnhanced() {
    try {
      const XLSX = await loadXLSX();
      const usersMap = await loadUsersMap();
      const range = ui.resultsRange;
      const userFilter = ui.resultsUser;
      const { data, error } = await sb.from('exam_sessions').select('*').order('updated_at', { ascending: false }).limit(1000);
      if (error) throw error;
      let rows = Array.isArray(data) ? data : [];
      rows = rows.filter(r => withinRange(r.completed_at || r.updated_at, range) && (userFilter === 'all' || String(r.user_id) === String(userFilter)));
      if (!rows.length) return showToast?.('Belum ada data untuk diekspor', 'error');

      const wb = XLSX.utils.book_new();
      const summaryRows = rows.map(row => {
        const user = usersMap.get(row.user_id) || {};
        const sec = sectionSummary(row);
        return {
          user_name: user.display_name || user.full_name || user.email || row.user_id,
          user_email: user.email || '',
          exam_title: row.exam_title,
          level: row.level,
          score: row.score,
          percentage: Number(row.percentage || 0),
          correct_count: row.correct_count,
          wrong_count: row.wrong_count,
          total_questions: row.total_questions,
          started_at: row.started_at,
          completed_at: row.completed_at,
          moji_pct: sec.moji_pct,
          bunpou_pct: sec.bunpou_pct,
          dokkai_pct: sec.dokkai_pct,
          status: row.status,
        };
      });

      const liveRows = (await sb.from('exam_progress').select('*').order('updated_at', { ascending: false }).limit(1000)).data || [];
      const filteredLive = liveRows.filter(r => withinRange(r.updated_at, ui.liveRange) && (ui.liveUser === 'all' || String(r.user_id) === String(ui.liveUser)));

      const aoa = [];
      aoa.push(['JLPT Export', 'Generated ' + nowIso()]);
      aoa.push(['Summary Rows', summaryRows.length]);
      aoa.push([]);
      aoa.push(['User', 'Email', 'Exam', 'Level', 'Score', 'Percent', 'Correct', 'Wrong', 'Total', 'Started', 'Completed', 'M %', 'B %', 'D %', 'Status']);
      summaryRows.forEach(r => aoa.push([
        r.user_name, r.user_email, r.exam_title, r.level, r.score, r.percentage, r.correct_count, r.wrong_count, r.total_questions,
        r.started_at, r.completed_at, r.moji_pct ?? '', r.bunpou_pct ?? '', r.dokkai_pct ?? '', r.status
      ]));
      const ws1 = XLSX.utils.aoa_to_sheet(aoa);
      XLSX.utils.book_append_sheet(wb, ws1, 'Summary');

      const aoa2 = [];
      aoa2.push(['Live Progress', 'Generated ' + nowIso()]);
      aoa2.push(['Live Rows', filteredLive.length]);
      aoa2.push([]);
      aoa2.push(['User ID', 'Exam', 'Current Q', 'Total Q', 'Answered', 'Correct', 'Wrong', 'Percent', 'Remaining', 'Updated']);
      filteredLive.forEach(r => aoa2.push([
        r.user_id, r.exam_title || r.exam_key, r.current_q, r.total_q, r.answered_count, r.correct_count, r.wrong_count, r.percentage, r.remaining_seconds, r.updated_at
      ]));
      const ws2 = XLSX.utils.aoa_to_sheet(aoa2);
      XLSX.utils.book_append_sheet(wb, ws2, 'Live');

      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['Guide'],
        ['Range filters', '15 minutes ago / 30 minutes ago / 1 hour ago / Today / Last week / Last month'],
        ['User filter', 'Select one user before export'],
      ]), 'Guide');

      XLSX.writeFile(wb, `jlpt_export_${new Date().toISOString().slice(0,10)}.xlsx`);
      showToast?.('✅ Excel berhasil diekspor', 'success');
    } catch (err) {
      showToast?.('❌ Gagal export Excel: ' + (err.message || err), 'error');
    }
  }

  function injectIndexUI() {
    ensureIndexSecurityButtons();
  }

  async function wrapHistoryRemoteSync() {
    const origOpenHistoryModal = window.openHistoryModal;
    if (typeof origOpenHistoryModal === 'function' && !origOpenHistoryModal.__jlptWrapped) {
      window.openHistoryModal = async function() {
        await syncHistoryFromDb();
        return origOpenHistoryModal.apply(this, arguments);
      };
      window.openHistoryModal.__jlptWrapped = true;
    }
    await syncHistoryFromDb();
  }

  function wrapIndexFunctions() {
    const origCompleteExam = window.completeExam;
    if (typeof origCompleteExam === 'function' && !origCompleteExam.__jlptWrapped) {
      window.completeExam = function(examKey, examName, level, year, score) {
        const res = origCompleteExam.apply(this, arguments);
        syncHistoryFromDb().catch(()=>{});
        return res;
      };
      window.completeExam.__jlptWrapped = true;
    }

    const origDoLogout = window.doLogout;
    if (typeof origDoLogout === 'function' && !origDoLogout.__jlptWrapped) {
      window.doLogout = async function() {
        try {
          const deviceId = localStorage.getItem('jlpt_device_id');
          if (deviceId && window._session?.user?.id) {
            await sb.from('user_sessions')
              .update({ is_current: false, last_seen_at: nowIso(), updated_at: nowIso() })
              .eq('user_id', window._session.user.id)
              .eq('device_id', deviceId);
          }
        } catch {}
        return origDoLogout.apply(this, arguments);
      };
      window.doLogout.__jlptWrapped = true;
    }
  }

  function attachIndexActions() {
    if (!document.getElementById('changePasswordBtn')) {
      const actions = document.querySelector('.profile-actions');
      if (actions) {
        const b1 = document.createElement('button');
        b1.className = 'history-btn';
        b1.id = 'changePasswordBtn';
        b1.textContent = '🔑 Change Password';
        b1.onclick = openSecurityModal;
        actions.insertBefore(b1, actions.querySelector('.logout-btn-sm'));
      }
    }
  }

  async function initAdminEnhancements() {
    if (state.isAdminPage) {
      const nav = document.getElementById('navGithub');
      if (nav && !document.getElementById('navDeviceSessions')) {
        const div = document.createElement('div');
        div.className = 'nav-item';
        div.id = 'navDeviceSessions';
        div.setAttribute('onclick', "goto('devices')");
        div.innerHTML = '<span class="nav-icon">📱</span> Login Device';
        nav.parentNode.insertBefore(div, nav);
      }
      if (!document.getElementById('pane-devices')) {
        const content = document.querySelector('.content');
        const pane = document.createElement('div');
        pane.className = 'pane';
        pane.id = 'pane-devices';
        pane.innerHTML = '<div id="jlpt-devices-mount"></div>';
        const after = document.getElementById('pane-examresults');
        if (after) after.parentNode.insertBefore(pane, after.nextSibling);
        else content.appendChild(pane);
      }
      wrapGotoForActivity();
      wrapAdminActions();

      const origGoto = window.goto;
      window.goto = function(pane) {
        const res = origGoto.apply(this, arguments);
        if (pane === 'devices') {
          const titleEl = document.getElementById('pageTitle');
          if (titleEl) titleEl.textContent = 'Login Device';
          refreshAdminDevicesPanel();
        }
        return res;
      };

      if (window.JLPT_SYNC) {
        window.JLPT_SYNC.refreshAdminLivePanel = refreshAdminLivePanelEnhanced;
        window.JLPT_SYNC.refreshAdminResultsPanel = refreshAdminResultsPanelEnhanced;
        window.JLPT_SYNC.exportResultsExcel = exportResultsExcelEnhanced;
        window.JLPT_SYNC.deleteExamSession = deleteExamSession;
        window.JLPT_SYNC.revokeDeviceSession = revokeAdminDevice;
      }
      await refreshAdminDevicesPanel();
    }

    if (state.isIndexPage) {
      attachIndexActions();
      wrapIndexFunctions();
      await wrapHistoryRemoteSync();
      ensureDeviceRow().catch(()=>{});
      setInterval(() => {
        checkDeviceRevoked().catch(()=>{});
        ensureDeviceRow().catch(()=>{});
      }, 60000);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    initAdminEnhancements().catch(err => console.warn('[jlpt-ext] init failed', err));
  });

  // expose for button onclicks
  window.openSecurityModal = openSecurityModal;
  window.openDeviceModal = openDeviceModal;
  window.refreshDeviceSessions = refreshDeviceSessions;
  window.changePassword = changePassword;
  window.deleteAccount = deleteAccount;
  window.revokeMyDevice = revokeMyDevice;
})();

