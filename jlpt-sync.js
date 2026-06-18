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
        const m3 = p.match(/(\d{4})-(\d{2})-jlpt/i);
        const lvl = p.match(/\/jlpt\/n([1-5])\//i) || p.match(/\/n([1-5])\//i);
        if (m3 && lvl) {
          year = m3[1];
          month = m3[2];
          level = `N${lvl[1]}`;
          key = `n${lvl[1]}-${m3[1]}-${m3[2]}`;
        } else {
          const fallback = (location.pathname.split('/').pop() || document.title || 'exam').replace(/\.[^.]+$/, '');
          key = fallback.toLowerCase();
          const lev = fallback.match(/n([1-5])/i);
          level = lev ? `N${lev[1]}` : 'N?';
        }
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

  function mergeLiveAndResultRows(progressRows = [], sessionRows = []) {
    const map = new Map();

    const mergeInto = (row, source) => {
      if (!row) return;
      const key = `${String(row.user_id || '')}::${String(row.exam_key || '')}`;
      const existing = map.get(key) || {};
      map.set(key, {
        ...existing,
        ...row,
        _source: source,
        _hasProgress: source === 'progress' ? true : !!existing._hasProgress,
        _hasSession: source === 'session' ? true : !!existing._hasSession,
      });
    };

    (sessionRows || []).forEach((row) => mergeInto(row, 'session'));
    (progressRows || []).forEach((row) => mergeInto(row, 'progress'));

    return Array.from(map.values()).sort((a, b) => {
      const at = new Date(a.updated_at || a.client_time || 0).getTime();
      const bt = new Date(b.updated_at || b.client_time || 0).getTime();
      return bt - at;
    });
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
      const catalogEntry = !row.title ? getExamCatalog().find((e) => e.key === key) : null;
      const payload = {
        exam_key: key,
        title: row.title || catalogEntry?.title || '',
        level: row.level || catalogEntry?.level || '',
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
    const blocked = new Set(['F5', 'F6', 'F7', 'F11', 'F12', 'PrintScreen']);
    const ctrlBlocked = new Set(['l', 'n', 't', 'w', 'r', 'u', 's', 'p', 'f', 'j', 'k', 'h', 'd', 'g']);
    if (
      blocked.has(e.key) ||
      ((e.ctrlKey || e.metaKey) && ctrlBlocked.has((e.key || '').toLowerCase())) ||
      ((e.ctrlKey || e.metaKey) && e.shiftKey) ||
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

  // ---- Fullscreen enforcement ----
  // The address bar itself is browser chrome and cannot be hidden or
  // disabled by page JavaScript (no website can do this — it would be a
  // serious security hole if it could). The closest practical equivalent
  // is forcing fullscreen mode during an active exam, which visually hides
  // the address bar/tab strip on most desktop and mobile browsers, plus
  // nudging the user back into fullscreen if they exit it.

  async function requestExamFullscreen() {
    try {
      const el = document.documentElement;
      if (document.fullscreenElement) return true;
      if (el.requestFullscreen) await el.requestFullscreen();
      else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
      else if (el.msRequestFullscreen) await el.msRequestFullscreen();
      return true;
    } catch (err) {
      console.warn('Fullscreen request failed (often requires a user gesture):', err?.message || err);
      return false;
    }
  }

  async function exitExamFullscreen() {
    try {
      if (!document.fullscreenElement) return;
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) await document.webkitExitFullscreen();
      else if (document.msExitFullscreen) await document.msExitFullscreen();
    } catch (err) {
      console.warn('Fullscreen exit failed:', err?.message || err);
    }
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
          <div style="font-size:14px;color:#aab8d8;line-height:1.8;margin-bottom:18px;">Ujian harus dikerjakan dalam mode layar penuh. Klik tombol di bawah untuk melanjutkan.</div>
          <button id="jlpt-fullscreen-resume-btn" style="padding:12px 22px;border-radius:14px;border:none;background:linear-gradient(135deg,#4a9eff,#6c3fff);color:#fff;font-weight:800;font-size:14px;cursor:pointer;font-family:inherit;">Lanjutkan Layar Penuh</button>
        </div>
      `;
      document.body.appendChild(prompt);
      prompt.querySelector('#jlpt-fullscreen-resume-btn')?.addEventListener('click', async () => {
        const ok = await requestExamFullscreen();
        if (ok) hideFullscreenPrompt();
      });
    }
    prompt.style.display = 'flex';
  }

  function hideFullscreenPrompt() {
    const prompt = document.getElementById('jlpt-fullscreen-prompt');
    if (prompt) prompt.style.display = 'none';
  }

  function installFullscreenGuard() {
    if (!state.isExamPage) return;
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && state.examRunning && !state.isAdmin) {
        showFullscreenPrompt();
        syncSession('fullscreen_exit', false, true);
      } else if (document.fullscreenElement) {
        hideFullscreenPrompt();
      }
    });
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
          // Fired from a real click handler, so this counts as a user
          // gesture and the browser will actually grant fullscreen here.
          requestExamFullscreen();
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
          hideFullscreenPrompt();
          exitExamFullscreen();
          setTimeout(() => syncSession('done', true, true), 180);
          return result;
        };
        wrapped.__jlptWrapped = true;
        wrapped.__jlptOriginal = original;
        window.finishQuiz = wrapped;
      }

      wrapFunction('goHome', () => {
        state.examRunning = false;
        hideFullscreenPrompt();
        exitExamFullscreen();
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
    const s = String(href || '').toLowerCase().replace(/\\/g, '/');
    const m = s.match(/(\d{4})-(\d{2})-n([1-5])/i);
    if (m) return `n${m[3]}-${m[1]}-${m[2]}`;
    const m2 = s.match(/n([1-5])-(\d{4})-(\d{2})/i);
    if (m2) return `n${m2[1]}-${m2[2]}-${m2[3]}`;
    // Legacy filenames like jlpt/n2/2025-12-jlpt.html: year/month come from
    // the filename, level comes from the /jlpt/nX/ or /nX/ folder segment.
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
      const [progressRes, sessionRes] = await Promise.all([
        client.from('exam_progress').select('*').order('updated_at', { ascending: false }).limit(100),
        client.from('exam_sessions').select('*').order('updated_at', { ascending: false }).limit(100),
      ]);

      if (progressRes.error) throw progressRes.error;
      if (sessionRes.error) throw sessionRes.error;

      const progressRows = Array.isArray(progressRes.data) ? progressRes.data : [];
      const sessionRows = Array.isArray(sessionRes.data) ? sessionRes.data : [];
      const rows = mergeLiveAndResultRows(progressRows, sessionRows).filter((row) => {
        const status = String(row.status || '').toLowerCase();
        return status === 'active' || status === 'idle' || status === 'done' || status === 'finished' || row.current_q || row.answered_count || row.remaining_seconds != null;
      });

      const tbody = document.getElementById('jlpt-live-table');
      const count = document.getElementById('jlpt-live-count');
      const countBadge = document.getElementById('jlpt-live-count-badge');
      if (count) count.textContent = `${rows.length} sesi aktif`;
      if (countBadge) countBadge.textContent = `${rows.length} sesi aktif`;

      if (!tbody) return;
      if (!rows.length) {
        tbody.innerHTML = `
          <tr>
            <td colspan="5" style="padding:18px;">
              <div style="border:1px dashed var(--border);border-radius:18px;padding:22px;color:var(--muted);background:rgba(255,255,255,.02);">
                <div style="font-weight:800;color:var(--text);margin-bottom:6px;">Belum ada user yang sedang ujian.</div>
                <div style="font-size:13px;line-height:1.7;">Begitu user membuka exam dan sistem menerima heartbeat pertama, sesi mereka akan muncul di sini.</div>
              </div>
            </td>
          </tr>`;
        return;
      }

      tbody.innerHTML = rows.map((row) => {
        const user = state.userMap.get(row.user_id) || {};
        const userLabel = user.display_name || user.full_name || user.email || row.user_id || '—';
        const when = fmtTime(row.updated_at || row.client_time);
        const rem = fmtSec(row.remaining_seconds ?? row.timer_remaining);
        const current = Number(row.current_q ?? row.current_question ?? 0);
        const total = Number(row.total_q ?? row.total_questions ?? 0);
        const answered = Number(row.answered_count ?? Object.keys(row.answers || {}).length ?? 0);
        const correct = Number(row.correct_count ?? 0);
        const pctNum = Number(row.percentage ?? 0);
        const pct = Number.isFinite(pctNum) ? pctNum.toFixed(2) : '0.00';
        const status = String(row.status || 'active').toLowerCase();
        const badgeColor = status === 'done' || status === 'finished' ? '#5ff0b0' : status === 'active' ? '#7cc0ff' : '#ffd18a';
        const statusText = status === 'done' ? 'DONE' : status === 'finished' ? 'FINISHED' : status.toUpperCase();

        return `
          <tr>
            <td style="padding:14px 16px;border-top:1px solid rgba(255,255,255,.04);vertical-align:top;">
              <div style="font-weight:800;font-size:14px;line-height:1.3;">${esc(userLabel)}</div>
              <div style="font-size:11px;color:var(--muted);margin-top:4px;line-height:1.5;">${esc(user.email || row.user_id || '')}</div>
            </td>
            <td style="padding:14px 16px;border-top:1px solid rgba(255,255,255,.04);vertical-align:top;">
              <div style="font-weight:800;">${esc(row.exam_title || row.exam_key || '—')}</div>
              <div style="font-size:11px;color:var(--muted);margin-top:4px;">${esc(`${row.level || ''} ${row.mode || ''}`.trim())}</div>
            </td>
            <td style="padding:14px 16px;border-top:1px solid rgba(255,255,255,.04);vertical-align:top;">
              <div style="display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;font-size:11px;font-weight:800;border:1px solid rgba(255,255,255,.12);color:${badgeColor};background:rgba(255,255,255,.04);text-transform:uppercase;letter-spacing:.4px;">${esc(statusText)}</div>
              <div style="font-size:12px;color:var(--muted);margin-top:8px;line-height:1.6;">
                <div>Soal: <strong style="color:var(--text);">${current}/${total || '—'}</strong></div>
                <div>Terjawab: <strong style="color:var(--text);">${answered}</strong> • Benar: <strong style="color:var(--text);">${correct}</strong></div>
                <div>Skor: <strong style="color:var(--text);">${pct}%</strong></div>
              </div>
            </td>
            <td style="padding:14px 16px;border-top:1px solid rgba(255,255,255,.04);vertical-align:top;font-family:'JetBrains Mono',monospace;font-weight:700;">${esc(rem)}</td>
            <td style="padding:14px 16px;border-top:1px solid rgba(255,255,255,.04);vertical-align:top;font-size:12px;color:var(--muted);line-height:1.6;">${esc(when)}</td>
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
      const [sessionRes, progressRes] = await Promise.all([
        client.from('exam_sessions').select('*').order('updated_at', { ascending: false }).limit(200),
        client.from('exam_progress').select('*').order('updated_at', { ascending: false }).limit(200),
      ]);
      if (sessionRes.error) throw sessionRes.error;
      if (progressRes.error) throw progressRes.error;

      const sessionRows = Array.isArray(sessionRes.data) ? sessionRes.data : [];
      const progressRows = Array.isArray(progressRes.data) ? progressRes.data : [];
      const rows = mergeLiveAndResultRows(progressRows, sessionRows).filter((row) => row.completed || String(row.status || '').toLowerCase() === 'done' || String(row.status || '').toLowerCase() === 'finished');

      state.resultsCache = rows;

      const tbody = document.getElementById('jlpt-results-table');
      const count = document.getElementById('jlpt-results-count');
      const countBadge = document.getElementById('jlpt-results-count-badge');
      if (count) count.textContent = `${rows.length} hasil`;
      if (countBadge) countBadge.textContent = `${rows.length} hasil`;

      if (!tbody) return;
      if (!rows.length) {
        tbody.innerHTML = `
          <tr>
            <td colspan="7" style="padding:18px;">
              <div style="border:1px dashed var(--border);border-radius:18px;padding:22px;color:var(--muted);background:rgba(255,255,255,.02);">
                <div style="font-weight:800;color:var(--text);margin-bottom:6px;">Belum ada hasil ujian.</div>
                <div style="font-size:13px;line-height:1.7;">Hasil akan muncul otomatis setelah user menekan tombol selesai dan data masuk ke <code>exam_sessions</code>.</div>
              </div>
            </td>
          </tr>`;
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
            <td style="padding:14px 16px;border-top:1px solid rgba(255,255,255,.04);font-weight:800;">${esc(userLabel)}</td>
            <td style="padding:14px 16px;border-top:1px solid rgba(255,255,255,.04);">${esc(row.exam_title || row.exam_key || '—')}</td>
            <td style="padding:14px 16px;border-top:1px solid rgba(255,255,255,.04);font-family:'JetBrains Mono',monospace;font-weight:700;">${esc(row.score ?? 0)}</td>
            <td style="padding:14px 16px;border-top:1px solid rgba(255,255,255,.04);font-weight:800;">${esc(Number.isFinite(pct) ? pct.toFixed(2) : '0.00')}%</td>
            <td style="padding:14px 16px;border-top:1px solid rgba(255,255,255,.04);line-height:1.7;">${esc(`${moji}% / ${bun}% / ${dok}%`)}</td>
            <td style="padding:14px 16px;border-top:1px solid rgba(255,255,255,.04);font-size:12px;color:var(--muted);line-height:1.6;">${esc(fmtTime(row.started_at))}</td>
            <td style="padding:14px 16px;border-top:1px solid rgba(255,255,255,.04);font-size:12px;color:var(--muted);line-height:1.6;">${esc(fmtTime(row.completed_at || row.updated_at))}</td>
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

    const lockMount = document.getElementById('jlpt-examlock-mount');
    const liveMount = document.getElementById('jlpt-livemonitor-mount');
    const resultsMount = document.getElementById('jlpt-examresults-mount');

    // Fallback for older admin.html versions that don't have the dedicated
    // menu panes yet: mount everything into the dashboard like before so
    // nothing silently disappears.
    const fallbackMount = document.getElementById('pane-dashboard') || document.querySelector('.content') || document.body;
    const usingFallback = !lockMount && !liveMount && !resultsMount;

    const wrap = document.createElement('div');
    wrap.id = 'jlpt-sync-admin-wrap';
    wrap.style.cssText = 'display:none;';

    const lockHtml = `
      <div style="display:grid;gap:16px;">
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
              <div style="font-size:13px;color:var(--muted);line-height:1.6;">Centang satu, beberapa, atau semua ujian lalu pilih Lock/Unlock.</div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button id="jlpt-select-all-exams" class="topbar-btn">☑️ Pilih Semua</button>
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
      </div>
    `;

    const liveHtml = `
      <div id="jlpt-admin-live-card" style="background:var(--card);border:1px solid var(--border);border-radius:20px;overflow:hidden;box-shadow:0 8px 25px rgba(0,0,0,.18);">
        <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center;padding:18px 20px;border-bottom:1px solid var(--border);">
          <div>
            <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:800;margin-bottom:4px;">🟢 Live Exam Monitor</div>
            <div style="font-size:13px;color:var(--muted);line-height:1.6;">Lihat user yang sedang ujian, progress, dan sisa waktu secara realtime.</div>
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
      </div>
    `;

    const resultsHtml = `
      <div id="jlpt-admin-results-card" style="background:var(--card);border:1px solid var(--border);border-radius:20px;overflow:hidden;box-shadow:0 8px 25px rgba(0,0,0,.18);">
        <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center;padding:18px 20px;border-bottom:1px solid var(--border);">
          <div>
            <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:800;margin-bottom:4px;">📈 Exam Results</div>
            <div style="font-size:13px;color:var(--muted);line-height:1.6;">Hasil akhir user tampil di sini dan bisa diekspor ke Excel dengan detail persentase per section.</div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <span id="jlpt-results-count-badge" style="padding:8px 12px;border-radius:999px;font-size:12px;font-weight:800;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);">— session</span>
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

    if (usingFallback) {
      wrap.style.cssText = 'margin:18px 0 28px;display:grid;gap:16px;';
      wrap.innerHTML = lockHtml + liveHtml + resultsHtml;
      fallbackMount.prepend(wrap);
    } else {
      document.body.appendChild(wrap); // kept empty/hidden, just used as a "ready" marker
      if (lockMount) lockMount.innerHTML = lockHtml;
      if (liveMount) liveMount.innerHTML = liveHtml;
      if (resultsMount) resultsMount.innerHTML = resultsHtml;
    }

    const root = usingFallback ? wrap : document;

    root.querySelector('#jlpt-lock-btn')?.addEventListener('click', async () => {
      const reasonInput = prompt('Alasan lock semua ujian (opsional):', state.settings.exam_lock_reason || '');
      const reason = (reasonInput ?? state.settings.exam_lock_reason) || '';
      await setGlobalLock(true, reason);
    });
    root.querySelector('#jlpt-unlock-btn')?.addEventListener('click', async () => {
      const reasonInput = prompt('Catatan unlock semua ujian (opsional):', state.settings.exam_lock_reason || '');
      const reason = (reasonInput ?? '');
      await setGlobalLock(false, reason);
    });
    root.querySelector('#jlpt-refresh-btn')?.addEventListener('click', () => refreshAdminPanels());
    root.querySelector('#jlpt-refresh-live')?.addEventListener('click', () => refreshAdminLivePanel());
    root.querySelector('#jlpt-refresh-results')?.addEventListener('click', () => refreshAdminResultsPanel());
    root.querySelector('#jlpt-refresh-locks')?.addEventListener('click', () => renderAdminControlUI());
    root.querySelector('#jlpt-select-all-exams')?.addEventListener('click', () => {
      const boxes = root.querySelectorAll('.jlpt-lock-check');
      const allChecked = Array.from(boxes).every((b) => b.checked);
      boxes.forEach((b) => { b.checked = !allChecked; });
    });
    root.querySelector('#jlpt-lock-selected')?.addEventListener('click', async () => {
      const keys = Array.from(root.querySelectorAll('.jlpt-lock-check:checked')).map((el) => el.dataset.examKey);
      const reason = prompt('Alasan lock selected (opsional):', '') ?? '';
      await setMultipleExamLocks(keys, true, reason);
    });
    root.querySelector('#jlpt-unlock-selected')?.addEventListener('click', async () => {
      const keys = Array.from(root.querySelectorAll('.jlpt-lock-check:checked')).map((el) => el.dataset.examKey);
      const reason = prompt('Catatan unlock selected (opsional):', '') ?? '';
      await setMultipleExamLocks(keys, false, reason);
    });
    root.querySelector('#jlpt-exam-search')?.addEventListener('input', () => renderAdminControlUI());
    root.querySelector('#jlpt-exam-level')?.addEventListener('change', () => renderAdminControlUI());
    root.querySelector('#jlpt-export-xlsx')?.addEventListener('click', () => exportResultsExcel());

    state.adminPanelReady = true;
    return wrap;
  }

  function renderAdminControlUI() {
    if (!state.isAdminPage) return;
    ensureAdminPanel();
    const panel = document; // elements may live in separate mount points; IDs are unique so query from document
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

    const liveCountBadge = panel.querySelector('#jlpt-live-count-badge');
    const resultsCountBadge = panel.querySelector('#jlpt-results-count-badge');
    if (liveCountBadge) liveCountBadge.textContent = panel.querySelector('#jlpt-live-count')?.textContent || '— session';
    if (resultsCountBadge) resultsCountBadge.textContent = panel.querySelector('#jlpt-results-count')?.textContent || '— session';

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

  // IMPORTANT: this script is loaded as type="module", which defers
  // execution until after HTML parsing, and the IIFE above awaits a dynamic
  // import() before reaching this point. By the time that await resolves,
  // DOMContentLoaded may have ALREADY fired — attaching a listener for it
  // here would then never run, silently skipping initPage() forever (this
  // is what caused the Lock Manager / Live Monitor / Exam Results panes to
  // render their title but stay empty). Check readyState directly instead
  // of blindly trusting the event will still come.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPage);
  } else {
    initPage();
  }

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
