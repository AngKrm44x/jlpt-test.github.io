(async function () {
  if (window.__JLPT_EXAM_ENHANCER_LOADED__) return;
  window.__JLPT_EXAM_ENHANCER_LOADED__ = true;

  const SUPABASE_URL = 'https://uincqpdexdenjcmwdfsv.supabase.co';
  const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVpbmNxcGRleGRlbmpjbXdkZnN2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5MjM4ODEsImV4cCI6MjA5NTQ5OTg4MX0.Lf1N_P_iiNQ2hnRJhd-Quy9MLKlZFSzbnXtXCnmRCS0';
  const SYNC_SRC = '../../jlpt-sync.js?v=7';

  let createClientFn = null;
  try {
    ({ createClient: createClientFn } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'));
  } catch (err) {
    console.warn('[JLPT enhancer] failed to import Supabase client:', err?.message || err);
  }

  if (createClientFn && !window._supabase) {
    try {
      window._supabase = createClientFn(SUPABASE_URL, SUPABASE_ANON);
    } catch (err) {
      console.warn('[JLPT enhancer] failed to create Supabase client:', err?.message || err);
    }
  }

  if (window._supabase && !window._session && window._supabase.auth?.getSession) {
    try {
      const sessionRes = await window._supabase.auth.getSession();
      window._session = sessionRes?.data?.session || null;
    } catch {}
  }

  try {
    await import(SYNC_SRC);
  } catch (err) {
    console.warn('[JLPT enhancer] jlpt-sync import failed:', err?.message || err);
  }

  const state = {
    lastHash: '',
    lastSentAt: 0,
    pageOpenSynced: false,
    wrappersInstalled: false,
    heartbeatTimer: null,
  };

  const isFn = (v) => typeof v === 'function';

  const nowIso = () => new Date().toISOString();

  function toast(msg) {
    try {
      if (typeof window.showToast === 'function') return window.showToast(msg);
      if (typeof window.alert === 'function') return window.alert(msg);
    } catch {}
    console.log('[JLPT enhancer]', msg);
  }

  function currentPath() {
    return location.pathname.replace(/\\/g, '/');
  }

  function examMetaFromPath() {
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

    return {
      key,
      level,
      year: year ? Number(year) : null,
      month: month || null,
      title: (document.title || `${level} Exam`).trim(),
      path: p,
    };
  }

  async function resolveSession() {
    let session = window._session || null;
    if (!session?.user?.id && window._supabase?.auth?.getSession) {
      try {
        const res = await window._supabase.auth.getSession();
        session = res?.data?.session || null;
        if (session) window._session = session;
      } catch (err) {
        console.warn('[JLPT enhancer] session fallback failed:', err?.message || err);
      }
    }
    return session;
  }

  function snapshotFromWindow(eventName = 'heartbeat', done = false, statusOverride = '') {
    const meta = examMetaFromPath();
    const questions = Array.isArray(window.questions) ? window.questions : [];
    const answers = window.answers && typeof window.answers === 'object' ? window.answers : {};
    const answered = Object.keys(answers).length;
    const correct = Object.values(answers).filter((a) => a && a.correct).length;
    const wrong = Math.max(answered - correct, 0);
    const total = questions.length || Number(window.totalQuestions || 0) || 0;
    const currentQ = Number(window.currentQ ?? 0);
    const startTime = Number(window.startTime || 0);
    const totalSeconds = Number(window.totalSeconds || 0);
    const remaining = startTime && totalSeconds
      ? Math.max(totalSeconds - Math.floor((Date.now() - startTime) / 1000), 0)
      : null;

    const status = statusOverride || (done ? 'done' : ((window.examRunning || window.timerInterval) ? 'active' : 'opened'));
    const updatedAt = nowIso();

    return {
      exam_key: meta.key,
      exam_title: meta.title,
      level: meta.level,
      year: meta.year,
      month: meta.month,
      mode: window.mode || window.currentMode || 'all',
      started_at: window.__JLPT_SESSION_STARTED_AT__ || window.startTimeISO || updatedAt,
      updated_at: updatedAt,
      last_seen_at: updatedAt,
      current_question: currentQ + 1,
      total_questions: total,
      timer_remaining: remaining,
      answers,
      score: correct,
      correct_count: correct,
      wrong_count: wrong,
      percentage: total ? Math.round((correct / total) * 10000) / 100 : 0,
      section_scores: window.sectionScores || window.section_scores || {},
      completed: !!done,
      completed_at: done ? updatedAt : null,
      status,
      last_event: eventName,
    };
  }

  function mirrorWindowState() {
    try {
      if (typeof window.currentQ !== 'undefined') window.currentQ = Number(window.currentQ || 0);
      if (Array.isArray(window.questions)) window.questions = window.questions;
      if (window.answers && typeof window.answers === 'object') window.answers = window.answers;
      if (typeof window.startTime !== 'undefined') window.startTime = Number(window.startTime || 0);
      if (typeof window.totalSeconds !== 'undefined') window.totalSeconds = Number(window.totalSeconds || 0);
      if (typeof window.mode !== 'undefined') window.mode = window.mode || 'all';
      if (typeof window.currentMode !== 'undefined') window.currentMode = window.currentMode || window.mode || 'all';
      window.totalQuestions = Array.isArray(window.questions) ? window.questions.length : Number(window.totalQuestions || 0) || 0;
      window.startTimeISO = window.startTimeISO || (window.startTime ? new Date(window.startTime).toISOString() : null);
      window.examRunning = !!(window.examRunning || window.timerInterval);
    } catch (err) {
      console.warn('[JLPT enhancer] mirror state failed:', err?.message || err);
    }
  }

  async function directUpsert(eventName = 'heartbeat', done = false, force = false, statusOverride = '') {
    const supabase = window._supabase || null;
    const session = await resolveSession();
    if (!supabase || !session?.user?.id) {
      console.warn('[JLPT enhancer] direct upsert aborted: missing supabase/session');
      return false;
    }

    const snap = snapshotFromWindow(eventName, done, statusOverride);
    const signature = JSON.stringify([
      snap.exam_key,
      snap.current_question,
      snap.total_questions,
      snap.correct_count,
      snap.wrong_count,
      snap.percentage,
      snap.status,
      snap.last_event,
      done,
      Object.keys(snap.answers || {}).length,
      snap.timer_remaining,
    ]);

    const now = Date.now();
    if (!force && state.lastHash === signature && (now - state.lastSentAt) < 4000) return true;
    state.lastHash = signature;
    state.lastSentAt = now;

    const progressPayload = {
      user_id: session.user.id,
      exam_key: snap.exam_key,
      exam_title: snap.exam_title,
      level: snap.level,
      year: snap.year,
      month: snap.month,
      mode: snap.mode,
      status: snap.status,
      current_q: snap.current_question,
      total_q: snap.total_questions,
      answered_count: Object.keys(snap.answers || {}).length,
      correct_count: snap.correct_count,
      wrong_count: snap.wrong_count,
      percentage: snap.percentage,
      remaining_seconds: snap.timer_remaining,
      last_event: snap.last_event,
      client_time: snap.updated_at,
      updated_at: snap.updated_at,
    };

    const sessionPayload = {
      user_id: session.user.id,
      exam_key: snap.exam_key,
      exam_title: snap.exam_title,
      level: snap.level,
      year: snap.year,
      month: snap.month,
      mode: snap.mode,
      started_at: snap.started_at,
      updated_at: snap.updated_at,
      last_seen_at: snap.last_seen_at,
      answers: snap.answers,
      current_question: snap.current_question,
      total_questions: snap.total_questions,
      timer_remaining: snap.timer_remaining,
      score: snap.score,
      correct_count: snap.correct_count,
      wrong_count: snap.wrong_count,
      percentage: snap.percentage,
      section_scores: snap.section_scores,
      completed: snap.completed,
      completed_at: snap.completed_at,
      status: snap.status,
      last_event: snap.last_event,
    };

    try {
      const [progressRes, sessionRes] = await Promise.all([
        supabase.from('exam_progress').upsert(progressPayload, { onConflict: 'user_id,exam_key' }),
        supabase.from('exam_sessions').upsert(sessionPayload, { onConflict: 'user_id,exam_key' }),
      ]);
      if (progressRes.error) throw progressRes.error;
      if (sessionRes.error) throw sessionRes.error;
      return true;
    } catch (err) {
      console.warn('[JLPT enhancer] direct upsert failed:', err?.message || err);
      return false;
    }
  }

  async function bridge(eventName = 'heartbeat', done = false, force = false, statusOverride = '') {
    mirrorWindowState();

    if (isFn(window.syncExamState)) {
      try {
        return window.syncExamState(eventName, done, force);
      } catch (err) {
        console.warn('[JLPT enhancer] syncExamState bridge failed:', err?.message || err);
      }
    }

    if (isFn(window.JLPT_SYNC?.syncSession)) {
      try {
        return await window.JLPT_SYNC.syncSession(eventName, done, force);
      } catch (err) {
        console.warn('[JLPT enhancer] JLPT_SYNC bridge failed:', err?.message || err);
      }
    }

    return directUpsert(eventName, done, force, statusOverride);
  }

  async function requestFullscreenSafe() {
    try {
      if (document.fullscreenElement) return true;
      const el = document.documentElement || document.body;
      if (!el?.requestFullscreen) return false;
      await el.requestFullscreen({ navigationUI: 'hide' });
      return true;
    } catch (err) {
      console.warn('[JLPT enhancer] fullscreen request failed:', err?.message || err);
      return false;
    }
  }

  async function exitFullscreenSafe() {
    try {
      if (!document.fullscreenElement || !document.exitFullscreen) return false;
      await document.exitFullscreen();
      return true;
    } catch (err) {
      console.warn('[JLPT enhancer] fullscreen exit failed:', err?.message || err);
      return false;
    }
  }

  function wrapFunction(name, afterHook) {
    const original = window[name];
    if (!isFn(original) || original.__jlptEnhanced) return false;

    const wrapped = function (...args) {
      const result = original.apply(this, args);
      try {
        afterHook?.call(this, result, args);
      } catch (err) {
        console.warn(`[JLPT enhancer] ${name} hook failed:`, err?.message || err);
      }
      return result;
    };
    wrapped.__jlptEnhanced = true;
    wrapped.__jlptOriginal = original;
    window[name] = wrapped;
    return true;
  }

  function installShortcuts() {
    document.addEventListener('keydown', (e) => {
      if (!window.examRunning) return;
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
      }
    }, true);

    document.addEventListener('contextmenu', (e) => {
      if (window.examRunning) e.preventDefault();
    }, true);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && window.examRunning) {
        bridge('hidden', false, true, 'active').catch(() => {});
      }
      if (document.visibilityState === 'visible' && window.examRunning) {
        bridge('visible', false, true, 'active').catch(() => {});
      }
    }, true);

    window.addEventListener('blur', () => {
      if (window.examRunning) bridge('blur', false, true, 'active').catch(() => {});
    });

    window.addEventListener('beforeunload', (e) => {
      if (!window.examRunning) return;
      try { bridge('beforeunload', false, true, 'active'); } catch {}
      e.preventDefault();
      e.returnValue = '';
      return '';
    });
  }

  function installWrappers() {
    if (state.wrappersInstalled) return;
    state.wrappersInstalled = true;

    const hasNativeSync = isFn(window.syncExamState);

    wrapFunction('startMode', function () {
      setTimeout(() => { requestFullscreenSafe(); }, 150);
      if (!hasNativeSync) setTimeout(() => { bridge('start', false, true, 'active'); }, 180);
    });

    wrapFunction('selectAnswer', function () {
      if (!hasNativeSync) setTimeout(() => { bridge('answer', false, false, 'active'); }, 90);
    });

    wrapFunction('nextQ', function () {
      if (!hasNativeSync) setTimeout(() => { bridge('next', false, false, 'active'); }, 90);
    });

    wrapFunction('prevQ', function () {
      if (!hasNativeSync) setTimeout(() => { bridge('prev', false, false, 'active'); }, 90);
    });

    wrapFunction('saveSessionManual', function () {
      if (!hasNativeSync) setTimeout(() => { bridge('save', false, true, 'active'); }, 80);
    });

    wrapFunction('loadSessionManual', function () {
      if (!hasNativeSync) setTimeout(() => { bridge('load', false, true, 'active'); }, 80);
    });

    wrapFunction('openReport', function () {
      if (!hasNativeSync) setTimeout(() => { bridge('report_open', false, false, 'active'); }, 80);
    });

    wrapFunction('closeReport', function () {
      if (!hasNativeSync) setTimeout(() => { bridge('report_close', false, false, 'active'); }, 80);
    });

    wrapFunction('reviewAnswers', function () {
      if (!hasNativeSync) setTimeout(() => { bridge('review', false, false, 'active'); }, 80);
    });

    wrapFunction('finishQuiz', function () {
      setTimeout(() => { exitFullscreenSafe(); }, 120);
      if (!hasNativeSync) setTimeout(() => { bridge('done', true, true, 'done'); }, 180);
    });

    wrapFunction('goHome', function () {
      setTimeout(() => { exitFullscreenSafe(); }, 120);
      if (!hasNativeSync) setTimeout(() => { bridge('home', false, true, 'opened'); }, 150);
    });
  }

  function startHeartbeatIfNeeded() {
    if (isFn(window.syncExamState)) return;
    if (state.heartbeatTimer) return;
    state.heartbeatTimer = setInterval(() => {
      const status = window.examRunning ? 'active' : 'opened';
      bridge('heartbeat', false, false, status).catch(() => {});
    }, 10000);
  }

  async function pageOpenSyncOnce() {
    if (state.pageOpenSynced) return;
    state.pageOpenSynced = true;
    if (isFn(window.syncExamState)) return; // native template already has its own startup sync path
    await bridge('page_open', false, true, 'opened');
  }

  function installLoop() {
    const startedAt = Date.now();
    const t = setInterval(() => {
      installWrappers();
      if (Date.now() - startedAt > 15000) clearInterval(t);
    }, 250);
  }

  function init() {
    installShortcuts();
    installWrappers();
    startHeartbeatIfNeeded();
    installLoop();

    if (!isFn(window.syncExamState)) {
      setTimeout(() => { pageOpenSyncOnce().catch(() => {}); }, 450);
    } else {
      // Native 2025-12-n3 template already has its own sync; keep only fullscreen/safety helpers.
      setTimeout(() => { requestFullscreenSafe(); }, 120);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  window.JLPT_EXAM_ENHANCER = {
    bridge,
    directUpsert,
    requestFullscreenSafe,
    exitFullscreenSafe,
    examMetaFromPath,
  };
})();