import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

// jlpt-sync.js
// Shared sync layer for:
// - global lock/unlock of all exams
// - live progress sync between exam pages and admin
// - browser restrictions during exams
// - admin dashboard live panel injection

(function () {
  const SUPABASE_URL = 'https://uincqpdexdenjcmwdfsv.supabase.co';
  const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVpbmNxcGRleGRlbmpjbXdkZnN2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5MjM4ODEsImV4cCI6MjA5NTQ5OTg4MX0.Lf1N_P_iiNQ2hnRJhd-Quy9MLKlZFSzbnXtXCnmRCS0';

  const client = window._supabase || createClient(SUPABASE_URL, SUPABASE_ANON);
  const state = window.__JLPT_SYNC__ = {
    client,
    settings: { id: 'global', exam_locked: false, exam_live_enabled: true, lock_reason: '', updated_at: null },
    isAdmin: false,
    isExamPage: false,
    isIndexPage: false,
    isAdminPage: false,
    session: null,
    userDb: null,
    currentExam: null,
    examRunning: false,
    heartbeatTimer: null,
    progressChannel: null,
    settingsChannel: null,
    lastSentAt: 0,
    lastPayloadHash: '',
    adminPanelReady: false,
    indexBannerReady: false
  };

  const ADMIN_EMAILS = new Set(['sidiqangga44@gmail.com', 'admin@example.com']);

  function pageKind() {
    const p = location.pathname.toLowerCase();
    if (p.includes('admin.html')) return 'admin';
    if (p.includes('index.html')) return 'index';
    if (p.match(/n[1-5]\.html$/) || p.includes('/jlpt/')) return 'exam';
    return 'other';
  }

  function toast(msg) {
    try {
      if (typeof window.showToast === 'function') return window.showToast(msg);
      if (typeof window.alert === 'function') return window.alert(msg);
    } catch {}
    console.log('[JLPT]', msg);
  }

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async function getContext() {
    try {
      const session = window._session || (await client.auth.getSession()).data.session;
      if (!session) return null;
      const email = (session.user.email || '').trim().toLowerCase();
      const isAdmin = ADMIN_EMAILS.has(email);
      let userDb = window._userDb || null;
      if (!userDb) {
        const res = await client.from('users').select('*').eq('id', session.user.id).maybeSingle();
        userDb = res.data || null;
      }
      return { session, userDb, isAdmin };
    } catch (err) {
      console.warn('JLPT context error:', err?.message || err);
      return null;
    }
  }

  async function fetchSettings() {
    try {
      const { data, error } = await client
        .from('exam_settings')
        .select('*')
        .eq('id', 'global')
        .maybeSingle();
      if (error) throw error;
      if (data) {
        state.settings = {
          id: 'global',
          exam_locked: !!data.exam_locked,
          exam_live_enabled: data.exam_live_enabled !== false,
          lock_reason: data.lock_reason || '',
          updated_at: data.updated_at || null,
          updated_by: data.updated_by || null
        };
      }
    } catch (err) {
      // If the table isn't created yet, keep safe defaults.
      console.warn('exam_settings not ready:', err?.message || err);
    }
    return state.settings;
  }

  async function saveSettings(patch) {
    const ctx = await getContext();
    if (!ctx || !ctx.isAdmin) {
      toast('⛔ Admin only');
      return false;
    }

    const payload = {
      id: 'global',
      exam_locked: !!patch.exam_locked,
      exam_live_enabled: patch.exam_live_enabled !== false,
      lock_reason: patch.lock_reason ?? state.settings.lock_reason ?? '',
      updated_at: new Date().toISOString(),
      updated_by: ctx.session.user.id
    };

    try {
      const { error } = await client.from('exam_settings').upsert(payload, { onConflict: 'id' });
      if (error) throw error;
      state.settings = { ...state.settings, ...payload };
      renderIndexLockUI();
      renderAdminControlUI();
      await refreshAdminLivePanel();
      toast(payload.exam_locked ? '🔒 Semua exam dikunci' : '🔓 Semua exam dibuka');
      return true;
    } catch (err) {
      console.error('saveSettings failed:', err);
      toast('⚠️ Gagal menyimpan status global');
      return false;
    }
  }

  function examMeta() {
    if (state.currentExam) return state.currentExam;

    const path = location.pathname.replace(/\\/g, '/').toLowerCase();
    const match = path.match(/(?:\/|^)(\d{4}-\d{2})-n([1-5])\.html$/i);
    const levelMatch = path.match(/n([1-5])\.html$/i);
    const level = levelMatch ? `N${levelMatch[1]}` : 'N?';
    const examKey = match ? `n${match[2]}-${match[1]}` : (window.location.pathname.split('/').pop() || 'exam');
    const title = (document.title || `JLPT ${level}`).trim();

    state.currentExam = {
      key: examKey,
      name: title,
      level,
      year: match ? match[1].split('-')[0] : (title.match(/20\d{2}/)?.[0] || ''),
      month: match ? match[1].split('-')[1] : '',
      path: location.pathname,
      title
    };
    return state.currentExam;
  }

  function getExamStateSnapshot(eventName) {
    const q = Number(window.currentQ ?? 0);
    const qs = Array.isArray(window.questions) ? window.questions : [];
    const ans = window.answers && typeof window.answers === 'object' ? window.answers : {};
    const total = qs.length || Number(window.totalQuestions || 0) || 0;
    const answered = Object.keys(ans).length;
    const correct = Object.values(ans).filter(v => v && v.correct).length;
    const startTime = Number(window.startTime || 0);
    const totalSeconds = Number(window.totalSeconds || 0);
    const remaining = startTime && totalSeconds ? Math.max(totalSeconds - Math.floor((Date.now() - startTime) / 1000), 0) : null;

    return {
      exam_key: examMeta().key,
      exam_name: examMeta().name,
      level: examMeta().level,
      year: Number(examMeta().year) || null,
      month: examMeta().month || null,
      mode: window.mode || window.currentMode || 'all',
      status: window.__JLPT_EXAM_FINISHED__ ? 'done' : (state.examRunning ? 'active' : 'idle'),
      current_q: q + 1,
      total_q: total,
      answered_count: answered,
      correct_count: correct,
      remaining_seconds: remaining,
      client_time: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_event: eventName || (state.examRunning ? 'heartbeat' : 'idle')
    };
  }

  function payloadHash(payload) {
    try { return JSON.stringify(payload); } catch { return String(Date.now()); }
  }

  async function pushProgress(eventName, force = false) {
    const ctx = await getContext();
    if (!ctx || ctx.isAdmin) return false;

    const payload = getExamStateSnapshot(eventName);
    const hash = payloadHash(payload);
    const now = Date.now();
    if (!force && state.lastPayloadHash === hash && now - state.lastSentAt < 4000) return true;
    state.lastPayloadHash = hash;
    state.lastSentAt = now;

    try {
      const { error } = await client.from('exam_progress').upsert({
        user_id: ctx.session.user.id,
        ...payload
      }, { onConflict: 'user_id,exam_key' });
      if (error) throw error;
      return true;
    } catch (err) {
      console.warn('pushProgress failed:', err?.message || err);
      return false;
    }
  }

  function blockExamShortcuts(e) {
    if (!state.isExamPage || !state.examRunning) return;

    const blocked = new Set(['F5', 'F6', 'F12', 'Escape', 'PrintScreen']);
    const ctrlBlocked = new Set(['l', 'n', 't', 'w', 'r', 'u', 's', 'p', 'f']);
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

  function installExamGuards() {
    if (!state.isExamPage) return;

    document.addEventListener('keydown', blockExamShortcuts, true);
    document.addEventListener('contextmenu', (e) => {
      if (state.examRunning) e.preventDefault();
    }, true);

    window.addEventListener('blur', () => {
      if (state.examRunning) pushProgress('blur');
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && state.examRunning) pushProgress('hidden', true);
      if (document.visibilityState === 'visible' && state.examRunning) pushProgress('visible', true);
    });

    window.addEventListener('beforeunload', (e) => {
      if (!state.examRunning) return;
      try { pushProgress('beforeunload', true); } catch {}
      e.preventDefault();
      e.returnValue = '';
      return '';
    });
  }

  function wrap(name, handler) {
    const original = window[name];
    if (typeof original !== 'function' || original.__jlptWrapped) return false;

    const wrapped = function (...args) {
      return handler.call(this, original, args);
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
        wrap('startMode', async (original, args) => {
          if (state.settings.exam_locked && !state.isAdmin) {
            toast('🔒 Semua exam sedang dikunci admin');
            return;
          }
          state.examRunning = true;
          window.__JLPT_EXAM_FINISHED__ = false;
          const result = original.apply(this, args);
          setTimeout(() => pushProgress('start', true), 120);
          return result;
        });
      }

      if (typeof window.selectAnswer === 'function' && !window.selectAnswer.__jlptWrapped) {
        wrap('selectAnswer', (original, args) => {
          const result = original.apply(this, args);
          setTimeout(() => pushProgress('answer'), 180);
          return result;
        });
      }

      if (typeof window.nextQ === 'function' && !window.nextQ.__jlptWrapped) {
        wrap('nextQ', (original, args) => {
          const result = original.apply(this, args);
          setTimeout(() => pushProgress('next'), 120);
          return result;
        });
      }

      if (typeof window.prevQ === 'function' && !window.prevQ.__jlptWrapped) {
        wrap('prevQ', (original, args) => {
          const result = original.apply(this, args);
          setTimeout(() => pushProgress('prev'), 120);
          return result;
        });
      }

      if (typeof window.saveSessionManual === 'function' && !window.saveSessionManual.__jlptWrapped) {
        wrap('saveSessionManual', (original, args) => {
          const result = original.apply(this, args);
          setTimeout(() => pushProgress('save', true), 80);
          return result;
        });
      }

      if (typeof window.loadSessionManual === 'function' && !window.loadSessionManual.__jlptWrapped) {
        wrap('loadSessionManual', (original, args) => {
          const result = original.apply(this, args);
          setTimeout(() => pushProgress('load', true), 80);
          return result;
        });
      }

      if (typeof window.finishQuiz === 'function' && !window.finishQuiz.__jlptWrapped) {
        wrap('finishQuiz', async (original, args) => {
          const result = original.apply(this, args);
          window.__JLPT_EXAM_FINISHED__ = true;
          state.examRunning = false;
          setTimeout(() => pushProgress('done', true), 120);
          return result;
        });
      }

      if (typeof window.goHome === 'function' && !window.goHome.__jlptWrapped) {
        wrap('goHome', (original, args) => {
          state.examRunning = false;
          const result = original.apply(this, args);
          setTimeout(() => pushProgress('home'), 80);
          return result;
        });
      }

      if (typeof window.openReport === 'function' && !window.openReport.__jlptWrapped) {
        wrap('openReport', (original, args) => {
          const result = original.apply(this, args);
          setTimeout(() => pushProgress('report_open'), 80);
          return result;
        });
      }

      if (typeof window.closeReport === 'function' && !window.closeReport.__jlptWrapped) {
        wrap('closeReport', (original, args) => {
          const result = original.apply(this, args);
          setTimeout(() => pushProgress('report_close'), 80);
          return result;
        });
      }

      if (
        window.startMode?.__jlptWrapped &&
        window.selectAnswer?.__jlptWrapped &&
        window.finishQuiz?.__jlptWrapped &&
        window.goHome?.__jlptWrapped
      ) {
        clearInterval(timer);
      }
    }, 200);

    setTimeout(() => clearInterval(timer), 15000);
  }

  function ensureIndexBanner() {
    const existing = document.getElementById('jlpt-global-banner');
    if (existing) return existing;
    const banner = document.createElement('div');
    banner.id = 'jlpt-global-banner';
    banner.style.cssText = [
      'display:none',
      'margin:0 0 16px 0',
      'padding:14px 16px',
      'border-radius:18px',
      'border:1px solid rgba(255,181,71,.28)',
      'background:rgba(255,181,71,.10)',
      'color:#ffd18a',
      'font-size:13px',
      'line-height:1.6'
    ].join(';');
    banner.innerHTML = '<strong>🔒 Semua ujian sedang dikunci admin.</strong><br><span id="jlpt-global-banner-text">Tunggu persetujuan admin untuk membuka kembali semua ujian.</span>';

    const hero = document.querySelector('.hero');
    const content = document.querySelector('.content') || document.body;
    if (hero?.parentNode) hero.insertAdjacentElement('afterend', banner);
    else content.prepend(banner);
    return banner;
  }

  function disableIndexExamLinks(locked) {
    const links = document.querySelectorAll('.open-btn');
    links.forEach((link) => {
      if (locked) {
        link.dataset.jlptLocked = '1';
        link.setAttribute('aria-disabled', 'true');
        link.style.pointerEvents = 'none';
        link.style.opacity = '0.5';
        link.style.filter = 'grayscale(0.35)';
        link.title = 'Semua ujian sedang dikunci admin';
        link.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          toast('🔒 Semua exam sedang dikunci admin');
          return false;
        };
      } else {
        if (link.dataset.jlptLocked === '1') {
          link.style.pointerEvents = '';
          link.style.opacity = '';
          link.style.filter = '';
          link.removeAttribute('aria-disabled');
          link.title = '';
          link.dataset.jlptLocked = '';
          link.onclick = function () {
            if (typeof window.recordExamOpen === 'function') {
              window.recordExamOpen(this);
            }
          };
        }
      }
    });
  }

  function renderIndexLockUI() {
    if (!state.isIndexPage) return;
    const banner = ensureIndexBanner();
    const locked = !!state.settings.exam_locked && !state.isAdmin;
    banner.style.display = locked ? 'block' : 'none';
    const text = banner.querySelector('#jlpt-global-banner-text');
    if (text) {
      text.textContent = state.settings.lock_reason
        ? state.settings.lock_reason
        : 'Tunggu persetujuan admin untuk membuka kembali semua ujian.';
    }
    disableIndexExamLinks(locked);
  }

  function ensureAdminPanel() {
    const existing = document.getElementById('jlpt-admin-control-card');
    if (existing) return existing;

    const mount = document.getElementById('pane-dashboard') || document.querySelector('.content') || document.body;
    const wrap = document.createElement('div');
    wrap.id = 'jlpt-admin-control-card';
    wrap.style.cssText = 'margin:18px 0 28px;background:var(--card);border:1px solid var(--border);border-radius:20px;padding:20px;box-shadow:0 8px 25px rgba(0,0,0,.18);';
    wrap.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:14px;">
        <div>
          <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:800;margin-bottom:4px;">🔐 Kontrol Ujian Global</div>
          <div style="font-size:13px;color:var(--muted);line-height:1.6;">Lock / unlock semua exam dari sini. Status akan disinkronkan ke halaman user secara realtime.</div>
        </div>
        <div id="jlpt-lock-pill" style="padding:8px 12px;border-radius:999px;font-size:12px;font-weight:800;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);">Memuat...</div>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;">
        <button id="jlpt-lock-btn" class="topbar-btn" style="border-color:rgba(255,95,115,.35);color:#ff9aaa;background:rgba(255,95,115,.08);">🔒 Lock All Exam</button>
        <button id="jlpt-unlock-btn" class="topbar-btn primary">🔓 Unlock All Exam</button>
        <button id="jlpt-refresh-btn" class="topbar-btn">🔄 Refresh Live View</button>
      </div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:14px;">
        <div style="padding:12px 14px;border:1px solid var(--border);border-radius:14px;background:rgba(255,255,255,.03);min-width:180px;">
          <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px;">Status Global</div>
          <div id="jlpt-lock-state" style="font-size:15px;font-weight:800;">—</div>
        </div>
        <div style="padding:12px 14px;border:1px solid var(--border);border-radius:14px;background:rgba(255,255,255,.03);min-width:180px;">
          <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px;">Di-update</div>
          <div id="jlpt-lock-updated" style="font-size:15px;font-weight:800;">—</div>
        </div>
        <div style="padding:12px 14px;border:1px solid var(--border);border-radius:14px;background:rgba(255,255,255,.03);min-width:180px;">
          <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px;">Active Sessions</div>
          <div id="jlpt-live-count" style="font-size:15px;font-weight:800;">—</div>
        </div>
      </div>
      <div style="overflow:auto;border:1px solid var(--border);border-radius:16px;">
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
    `;
    mount.prepend(wrap);

    wrap.querySelector('#jlpt-lock-btn')?.addEventListener('click', () => saveSettings({ exam_locked: true }));
    wrap.querySelector('#jlpt-unlock-btn')?.addEventListener('click', () => saveSettings({ exam_locked: false }));
    wrap.querySelector('#jlpt-refresh-btn')?.addEventListener('click', () => refreshAdminLivePanel());
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
    if (updatedText) updatedText.textContent = state.settings.updated_at ? new Date(state.settings.updated_at).toLocaleString() : '—';
  }

  async function refreshAdminLivePanel() {
    if (!state.isAdminPage) return;
    try {
      const { data, error } = await client
        .from('exam_progress')
        .select('*')
        .order('updated_at', { ascending: false })
        .limit(30);
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
        const when = row.updated_at ? new Date(row.updated_at).toLocaleString() : '—';
        const rem = row.remaining_seconds == null ? '—' : `${Math.max(Number(row.remaining_seconds), 0)}s`;
        const progress = `${Number(row.current_q || 0)}/${Number(row.total_q || 0) || '—'} • ${Number(row.correct_count || 0)} benar`;
        const status = row.status || 'active';
        const badgeColor = status === 'done' ? '#5ff0b0' : status === 'active' ? '#7cc0ff' : '#ffd18a';

        return `
          <tr>
            <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);">
              <div style="font-weight:700;">${esc(row.user_id || '—')}</div>
              <div style="font-size:11px;color:var(--muted);">${esc(row.level || '')} ${esc(row.mode || '')}</div>
            </td>
            <td style="padding:12px 14px;border-top:1px solid rgba(255,255,255,.04);">
              <div style="font-weight:700;">${esc(row.exam_name || row.exam_key || '—')}</div>
              <div style="font-size:11px;color:var(--muted);">${esc(row.exam_key || '')}</div>
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

  function subscribeRealtimes() {
    try {
      if (state.settingsChannel) client.removeChannel(state.settingsChannel);
      if (state.progressChannel) client.removeChannel(state.progressChannel);
    } catch {}

    state.settingsChannel = client
      .channel('jlpt-settings-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'exam_settings', filter: 'id=eq.global' }, async () => {
        await fetchSettings();
        renderIndexLockUI();
        renderAdminControlUI();
      })
      .subscribe();

    state.progressChannel = client
      .channel('jlpt-progress-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'exam_progress' }, async () => {
        if (state.isAdminPage) await refreshAdminLivePanel();
      })
      .subscribe();
  }

  function renderIndexLockUI() {
    if (!state.isIndexPage) return;
    const banner = ensureIndexBanner();
    const locked = !!state.settings.exam_locked && !state.isAdmin;
    banner.style.display = locked ? 'block' : 'none';
    const text = banner.querySelector('#jlpt-global-banner-text');
    if (text) {
      text.textContent = state.settings.lock_reason
        ? state.settings.lock_reason
        : 'Tunggu persetujuan admin untuk membuka kembali semua ujian.';
    }
    disableIndexExamLinks(locked);
  }

  function ensureIndexBanner() {
    const existing = document.getElementById('jlpt-global-banner');
    if (existing) return existing;
    const banner = document.createElement('div');
    banner.id = 'jlpt-global-banner';
    banner.style.cssText = [
      'display:none',
      'margin:0 0 16px 0',
      'padding:14px 16px',
      'border-radius:18px',
      'border:1px solid rgba(255,181,71,.28)',
      'background:rgba(255,181,71,.10)',
      'color:#ffd18a',
      'font-size:13px',
      'line-height:1.6'
    ].join(';');
    banner.innerHTML = '<strong>🔒 Semua ujian sedang dikunci admin.</strong><br><span id="jlpt-global-banner-text">Tunggu persetujuan admin untuk membuka kembali semua ujian.</span>';
    const hero = document.querySelector('.hero');
    const content = document.querySelector('.content') || document.body;
    if (hero?.parentNode) hero.insertAdjacentElement('afterend', banner);
    else content.prepend(banner);
    return banner;
  }

  function disableIndexExamLinks(locked) {
    const links = document.querySelectorAll('.open-btn');
    links.forEach((link) => {
      if (locked) {
        link.dataset.jlptLocked = '1';
        link.setAttribute('aria-disabled', 'true');
        link.style.pointerEvents = 'none';
        link.style.opacity = '0.5';
        link.style.filter = 'grayscale(0.35)';
        link.title = 'Semua ujian sedang dikunci admin';
        link.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          toast('🔒 Semua exam sedang dikunci admin');
          return false;
        };
      } else if (link.dataset.jlptLocked === '1') {
        link.style.pointerEvents = '';
        link.style.opacity = '';
        link.style.filter = '';
        link.removeAttribute('aria-disabled');
        link.title = '';
        link.dataset.jlptLocked = '';
        link.onclick = function () {
          if (typeof window.recordExamOpen === 'function') {
            window.recordExamOpen(this);
          }
        };
      }
    });
  }

  function installExamGuards() {
    if (!state.isExamPage) return;

    document.addEventListener('keydown', (e) => {
      if (!state.examRunning) return;
      const blocked = new Set(['F5', 'F6', 'F12', 'Escape', 'PrintScreen']);
      const ctrlBlocked = new Set(['l', 'n', 't', 'w', 'r', 'u', 's', 'p', 'f']);
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
      if (state.examRunning) e.preventDefault();
    }, true);

    window.addEventListener('blur', () => {
      if (state.examRunning) pushProgress('blur');
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && state.examRunning) pushProgress('hidden', true);
      if (document.visibilityState === 'visible' && state.examRunning) pushProgress('visible', true);
    });

    window.addEventListener('beforeunload', (e) => {
      if (!state.examRunning) return;
      try { pushProgress('beforeunload', true); } catch {}
      e.preventDefault();
      e.returnValue = '';
      return '';
    });
  }

  function observeExamFunctions() {
    if (!state.isExamPage) return;

    const timer = setInterval(() => {
      if (typeof window.startMode === 'function' && !window.startMode.__jlptWrapped) {
        const original = window.startMode;
        const wrapped = function (...args) {
          if (state.settings.exam_locked && !state.isAdmin) {
            toast('🔒 Semua exam sedang dikunci admin');
            return;
          }
          state.examRunning = true;
          window.__JLPT_EXAM_FINISHED__ = false;
          const result = original.apply(this, args);
          setTimeout(() => pushProgress('start', true), 120);
          return result;
        };
        wrapped.__jlptWrapped = true;
        wrapped.__jlptOriginal = original;
        window.startMode = wrapped;
      }

      const patch = (name, after) => {
        if (typeof window[name] !== 'function' || window[name].__jlptWrapped) return;
        const original = window[name];
        const wrapped = function (...args) {
          const result = original.apply(this, args);
          after?.();
          return result;
        };
        wrapped.__jlptWrapped = true;
        wrapped.__jlptOriginal = original;
        window[name] = wrapped;
      };

      patch('selectAnswer', () => setTimeout(() => pushProgress('answer'), 180));
      patch('nextQ', () => setTimeout(() => pushProgress('next'), 120));
      patch('prevQ', () => setTimeout(() => pushProgress('prev'), 120));
      patch('saveSessionManual', () => setTimeout(() => pushProgress('save', true), 80));
      patch('loadSessionManual', () => setTimeout(() => pushProgress('load', true), 80));

      if (typeof window.finishQuiz === 'function' && !window.finishQuiz.__jlptWrapped) {
        const original = window.finishQuiz;
        const wrapped = function (...args) {
          const result = original.apply(this, args);
          window.__JLPT_EXAM_FINISHED__ = true;
          state.examRunning = false;
          setTimeout(() => pushProgress('done', true), 120);
          return result;
        };
        wrapped.__jlptWrapped = true;
        wrapped.__jlptOriginal = original;
        window.finishQuiz = wrapped;
      }

      patch('goHome', () => {
        state.examRunning = false;
        pushProgress('home');
      });
      patch('openReport', () => pushProgress('report_open'));
      patch('closeReport', () => pushProgress('report_close'));

      if (
        window.startMode?.__jlptWrapped &&
        window.selectAnswer?.__jlptWrapped &&
        window.finishQuiz?.__jlptWrapped &&
        window.goHome?.__jlptWrapped
      ) {
        clearInterval(timer);
      }
    }, 200);

    setTimeout(() => clearInterval(timer), 15000);
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

    await fetchSettings();
    subscribeRealtimes();

    if (state.isIndexPage) renderIndexLockUI();

    if (state.isAdminPage) {
      renderAdminControlUI();
      await refreshAdminLivePanel();
    }

    if (state.isExamPage) {
      installExamGuards();
      observeExamFunctions();

      if (state.settings.exam_locked && !state.isAdmin) {
        const shield = document.createElement('div');
        shield.id = 'jlpt-exam-lock-shield';
        shield.style.cssText = 'position:fixed;inset:0;z-index:999999;background:rgba(5,9,16,.92);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:18px;text-align:center;';
        shield.innerHTML = `
          <div style="max-width:520px;background:#111a2f;border:1px solid rgba(255,95,115,.3);border-radius:24px;padding:28px 24px;box-shadow:0 25px 80px rgba(0,0,0,.6);">
            <div style="font-size:46px;margin-bottom:10px;">🔒</div>
            <div style="font-family:'Syne',sans-serif;font-size:22px;font-weight:800;margin-bottom:8px;color:#ff9aaa;">Semua exam sedang dikunci</div>
            <div style="font-size:14px;color:#aab8d8;line-height:1.8;">Admin belum membuka akses ujian. Silakan kembali ke halaman utama dan tunggu status <strong>Unlock All Exam</strong>.</div>
          </div>
        `;
        document.body.appendChild(shield);
      }

      state.heartbeatTimer = setInterval(() => {
        if (state.examRunning) pushProgress('heartbeat');
      }, 10000);
    }
  }

  document.addEventListener('DOMContentLoaded', initPage);

  window.JLPT_SYNC = {
    fetchSettings,
    saveSettings,
    refreshAdminLivePanel,
    renderAdminControlUI,
    renderIndexLockUI,
    pushProgress,
    examMeta
  };
})();
