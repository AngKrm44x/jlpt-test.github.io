(async function () {
  if (window.__JLPT_ACCOUNT_TOOLS_LOADED__) return;
  window.__JLPT_ACCOUNT_TOOLS_LOADED__ = true;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function waitForAuth() {
    const deadline = Date.now() + 6000;
    while (!(window._supabase && window._session) && Date.now() < deadline) {
      await sleep(50);
    }
    return window._supabase && window._session ? { sb: window._supabase, session: window._session, userDb: window._userDb || null } : null;
  }

  function toast(msg) {
    if (typeof window.showToast === 'function') return window.showToast(msg);
    if (typeof window.alert === 'function') return window.alert(msg);
    console.log('[JLPT Account]', msg);
  }

  function getDeviceId() {
    let id = localStorage.getItem('jlpt_device_id');
    if (!id) {
      id = window.crypto?.randomUUID ? crypto.randomUUID() : `dev_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      localStorage.setItem('jlpt_device_id', id);
    }
    return id;
  }

  function getDeviceName() {
    const ua = navigator.userAgent || '';
    const platform = navigator.platform || '';
    return `${platform} · ${ua}`.trim().slice(0, 220);
  }

  async function recordAuthEvent(action, meta = {}) {
    const ctx = await waitForAuth();
    if (!ctx?.session?.user?.id) return false;

    try {
      const deviceId = getDeviceId();
      const loginKey = `jlpt_login_logged_${ctx.session.user.id}_${deviceId}`;
      if (action === 'login' && localStorage.getItem(loginKey) === '1') return true;

      const payload = {
        user_id: ctx.session.user.id,
        email: ctx.session.user.email || '',
        action: String(action || 'unknown'),
        device_id: deviceId,
        device_name: getDeviceName(),
        user_agent: navigator.userAgent || '',
        meta,
        created_at: new Date().toISOString(),
      };
      const { error } = await ctx.sb.from('login_history').insert(payload);
      if (error) throw error;
      if (action === 'login') localStorage.setItem(loginKey, '1');
      return true;
    } catch (err) {
      console.warn('[jlpt-account] recordAuthEvent failed:', err?.message || err);
      return false;
    }
  }

  async function ensureDeviceSession() {
    const ctx = await waitForAuth();
    if (!ctx?.session?.user?.id) return null;

    const userId = ctx.session.user.id;
    const deviceId = getDeviceId();
    const deviceName = getDeviceName();
    window.__JLPT_DEVICE_ID__ = deviceId;

    try {
      const { data: existing, error } = await ctx.sb
        .from('user_devices')
        .select('*')
        .eq('user_id', userId)
        .eq('device_id', deviceId)
        .maybeSingle();
      if (error) throw error;

      if (existing?.revoked_at) {
        toast('⛔ Device ini telah dilogout admin/user');
        try { await ctx.sb.auth.signOut(); } catch {}
        location.replace('./auth.html');
        return { revoked: true };
      }

      const payload = {
        user_id: userId,
        device_id: deviceId,
        device_name: deviceName,
        user_agent: navigator.userAgent || '',
        last_seen_at: new Date().toISOString(),
        revoked_at: null,
        revoked_by: null,
        created_at: existing?.created_at || new Date().toISOString(),
      };
      const { error: upsertErr } = await ctx.sb.from('user_devices').upsert(payload, { onConflict: 'user_id,device_id' });
      if (upsertErr) throw upsertErr;
      return { revoked: false };
    } catch (err) {
      console.warn('[jlpt-account] ensureDeviceSession failed:', err?.message || err);
      return { revoked: false, error: err };
    }
  }



async function loadUserMapForAccountTools() {
  try {
    const ctx = await waitForAuth();
    if (!ctx?.session?.user?.id) return new Map();
    if (window.__JLPT_ACCOUNT_USER_MAP__?.size) return window.__JLPT_ACCOUNT_USER_MAP__;
    const { data, error } = await ctx.sb.from('users').select('id, full_name, display_name, email, role');
    if (error) throw error;
    const map = new Map();
    (data || []).forEach(u => map.set(u.id, u));
    window.__JLPT_ACCOUNT_USER_MAP__ = map;
    return map;
  } catch (err) {
    console.warn('[jlpt-account] loadUserMap failed:', err?.message || err);
    return window.__JLPT_ACCOUNT_USER_MAP__ || new Map();
  }
}

  async function loadLoginHistory(targetUserId = null, limit = 50) {
    const ctx = await waitForAuth();
    if (!ctx?.session?.user?.id) return [];
    try {
      const isAdmin = String(ctx.userDb?.role || '').toLowerCase().includes('admin') ||
        ['sidiqangga44@gmail.com', 'admin@example.com'].includes(String(ctx.session.user.email || '').toLowerCase());

      let query = ctx.sb.from('login_history').select('*').order('created_at', { ascending: false }).limit(limit);
      if (!isAdmin || targetUserId) query = query.eq('user_id', targetUserId || ctx.session.user.id);

      const { data, error } = await query;
      if (error) throw error;
      return Array.isArray(data) ? data : [];
    } catch (err) {
      console.warn('[jlpt-account] loadLoginHistory failed:', err?.message || err);
      return [];
    }
  }

  async function loadDeviceSessions(targetUserId = null) {
    const ctx = await waitForAuth();
    if (!ctx?.session?.user?.id) return [];
    try {
      const isAdmin = String(ctx.userDb?.role || '').toLowerCase().includes('admin') ||
        ['sidiqangga44@gmail.com', 'admin@example.com'].includes(String(ctx.session.user.email || '').toLowerCase());

      let query = ctx.sb.from('user_devices').select('*').order('last_seen_at', { ascending: false });
      if (!isAdmin || targetUserId) query = query.eq('user_id', targetUserId || ctx.session.user.id);

      const { data, error } = await query;
      if (error) throw error;
      return Array.isArray(data) ? data : [];
    } catch (err) {
      console.warn('[jlpt-account] loadDeviceSessions failed:', err?.message || err);
      return [];
    }
  }

  async function revokeDeviceSession(userId, deviceId) {
    const ctx = await waitForAuth();
    if (!ctx?.session?.user?.id) return false;
    try {
      const { error } = await ctx.sb
        .from('user_devices')
        .update({
          revoked_at: new Date().toISOString(),
          revoked_by: ctx.session.user.id,
          last_seen_at: new Date().toISOString(),
        })
        .eq('user_id', userId)
        .eq('device_id', deviceId);
      if (error) throw error;

      await recordAuthEvent('device_revoked', { target_user_id: userId, target_device_id: deviceId });
      if (String(userId) === String(ctx.session.user.id) && String(deviceId) === String(window.__JLPT_DEVICE_ID__ || getDeviceId())) {
        try { await ctx.sb.auth.signOut(); } catch {}
        location.replace('./auth.html');
      }
      return true;
    } catch (err) {
      console.warn('[jlpt-account] revokeDeviceSession failed:', err?.message || err);
      toast('❌ Gagal logout device: ' + (err?.message || err));
      return false;
    }
  }

  async function changePassword(newPassword) {
    const ctx = await waitForAuth();
    if (!ctx?.session?.user?.id) return false;
    try {
      const { error } = await ctx.sb.auth.updateUser({ password: newPassword });
      if (error) throw error;
      await recordAuthEvent('password_change', { scope: 'self' });
      toast('✅ Password berhasil diubah');
      return true;
    } catch (err) {
      console.warn('[jlpt-account] changePassword failed:', err?.message || err);
      toast('❌ Gagal mengubah password: ' + (err?.message || err));
      return false;
    }
  }

  async function deleteOwnAccount() {
    const ctx = await waitForAuth();
    if (!ctx?.session?.user?.id) return false;
    try {
      const { error } = await ctx.sb
        .from('users')
        .update({
          status: 'deleted',
          deleted_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', ctx.session.user.id);
      if (error) throw error;
      await recordAuthEvent('account_deleted', { scope: 'self' });
      try { await ctx.sb.auth.signOut(); } catch {}
      location.replace('./auth.html');
      return true;
    } catch (err) {
      console.warn('[jlpt-account] deleteOwnAccount failed:', err?.message || err);
      toast('❌ Gagal hapus akun: ' + (err?.message || err));
      return false;
    }
  }

  function formatTime(ts) {
    if (!ts) return '—';
    try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
  }

  function formatDeviceLabel(row) {
    if (!row) return '—';
    const n = row.device_name || 'Device';
    const ua = row.user_agent ? row.user_agent.slice(0, 44) : '';
    return ua ? `${n} · ${ua}` : n;
  }

  // =========================
  // INDEX / USER UI
  // =========================
  function ensureUserSecurityModal() {
    if (document.getElementById('accountSecurityModal')) return;

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'accountSecurityModal';
    modal.innerHTML = `
      <div class="modal modal-wide" style="max-width:960px;">
        <div class="modal-title">🔐 Keamanan Akun</div>
        <div style="display:grid;grid-template-columns:1.05fr .95fr;gap:16px;">
          <div class="table-wrap" style="background:rgba(255,255,255,.02);">
            <div class="table-head">
              <div class="table-title">🔑 Ganti Password</div>
            </div>
            <div style="padding:18px 20px;">
              <div class="form-group" style="margin-bottom:12px;">
                <label>Password baru</label>
                <input class="form-input" id="accNewPass" type="password" placeholder="Minimal 8 karakter">
              </div>
              <div class="form-group" style="margin-bottom:12px;">
                <label>Ulangi password</label>
                <input class="form-input" id="accNewPass2" type="password" placeholder="Ketik ulang password">
              </div>
              <button class="submit-btn" id="accChangePassBtn" type="button" style="margin-top:8px;width:100%;">💾 Simpan Password</button>
            </div>
          </div>

          <div class="table-wrap" style="background:rgba(255,255,255,.02);">
            <div class="table-head">
              <div class="table-title">📱 Kontrol Device</div>
            </div>
            <div style="padding:18px 20px;">
              <div id="accDeviceList" style="display:flex;flex-direction:column;gap:10px;max-height:250px;overflow:auto;"></div>
              <button class="topbar-btn" id="accRefreshDeviceBtn" type="button" style="margin-top:12px;width:100%;justify-content:center;">🔄 Refresh Device</button>
            </div>
          </div>
        </div>

        <div class="table-wrap" style="background:rgba(255,255,255,.02);margin-top:16px;">
          <div class="table-head">
            <div class="table-title">🕘 Login History</div>
            <div class="table-actions">
              <input class="search-mini" id="accHistorySearch" type="text" placeholder="Cari riwayat..." style="width:220px;">
              <select class="form-input" id="accHistoryFilter" style="width:170px;padding:8px 12px;border-radius:10px;font-size:13px;">
                <option value="all">Semua</option>
                <option value="login">Login</option>
                <option value="logout">Logout</option>
                <option value="password_change">Password</option>
                <option value="device_revoked">Logout Device</option>
                <option value="account_deleted">Hapus Akun</option>
              </select>
              <button class="topbar-btn primary" id="accRefreshHistoryBtn" type="button">🔄 Refresh</button>
            </div>
          </div>
          <div style="overflow:auto;max-height:360px;">
            <table style="width:100%;border-collapse:collapse;">
              <thead>
                <tr>
                  <th>User</th><th>Action</th><th>Device</th><th>Time</th><th>Meta</th>
                </tr>
              </thead>
              <tbody id="accHistoryTable"><tr><td colspan="5" style="padding:16px;color:var(--muted);">Memuat...</td></tr></tbody>
            </table>
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn-cancel" id="accDeleteBtn" type="button" style="border-color:rgba(255,79,109,.3);color:#ff9aaa;">🗑 Hapus Akun</button>
          <button class="btn-cancel" id="accCloseBtn" type="button">Tutup</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('show'); });
    modal.querySelector('#accCloseBtn')?.addEventListener('click', () => modal.classList.remove('show'));
    modal.querySelector('#accRefreshHistoryBtn')?.addEventListener('click', renderUserSecurityModal);
    modal.querySelector('#accRefreshDeviceBtn')?.addEventListener('click', renderUserSecurityModal);
    modal.querySelector('#accChangePassBtn')?.addEventListener('click', async () => {
      const p1 = modal.querySelector('#accNewPass').value.trim();
      const p2 = modal.querySelector('#accNewPass2').value.trim();
      if (!p1 || p1.length < 8) return toast('⚠️ Password minimal 8 karakter');
      if (p1 !== p2) return toast('⚠️ Password tidak sama');
      const ok = await changePassword(p1);
      if (ok) {
        modal.querySelector('#accNewPass').value = '';
        modal.querySelector('#accNewPass2').value = '';
      }
    });
    modal.querySelector('#accDeleteBtn')?.addEventListener('click', async () => {
      if (!confirm('Hapus akun ini? Aksi ini akan menonaktifkan akun dan sign out dari perangkat ini.')) return;
      await deleteOwnAccount();
    });
    modal.querySelector('#accHistorySearch')?.addEventListener('input', renderUserSecurityModal);
    modal.querySelector('#accHistoryFilter')?.addEventListener('change', renderUserSecurityModal);
  }

  async function renderUserSecurityModal() {
    const modal = document.getElementById('accountSecurityModal');
    if (!modal) return;
    const ctx = await waitForAuth();
    if (!ctx?.session?.user?.id) return;

    const [histories, devices] = await Promise.all([
      loadLoginHistory(ctx.session.user.id, 200),
      loadDeviceSessions(ctx.session.user.id),
    ]);

    const historySearch = String(modal.querySelector('#accHistorySearch')?.value || '').trim().toLowerCase();
    const historyFilter = String(modal.querySelector('#accHistoryFilter')?.value || 'all');

    const hRows = histories.filter(r => {
      if (historyFilter !== 'all' && String(r.action || '') !== historyFilter) return false;
      if (!historySearch) return true;
      const hay = [r.action, r.device_name, r.user_agent, r.email, JSON.stringify(r.meta || {})].join(' ').toLowerCase();
      return hay.includes(historySearch);
    });

    modal.querySelector('#accHistoryTable').innerHTML = hRows.length ? hRows.slice(0, 120).map(r => `
      <tr>
        <td style="padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.04);">${r.email ? r.email.split('@')[0] : '—'}</td>
        <td style="padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.04);"><span class="status active">${r.action}</span></td>
        <td style="padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.04);">${formatDeviceLabel(r)}</td>
        <td style="padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.04);font-size:12px;color:var(--muted);">${formatTime(r.created_at)}</td>
        <td style="padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.04);font-size:12px;color:var(--muted);word-break:break-word;">${JSON.stringify(r.meta || {}).slice(0, 120)}</td>
      </tr>
    `).join('') : '<tr><td colspan="5" style="padding:16px;color:var(--muted);">Tidak ada riwayat login.</td></tr>';

    modal.querySelector('#accDeviceList').innerHTML = devices.length ? devices.map(d => `
      <div style="padding:12px 14px;border:1px solid var(--border);border-radius:14px;background:rgba(255,255,255,.03);display:flex;gap:10px;align-items:flex-start;justify-content:space-between;">
        <div>
          <div style="font-weight:700;margin-bottom:3px;">${formatDeviceLabel(d)}</div>
          <div style="font-size:12px;color:var(--muted);line-height:1.6;">${formatTime(d.last_seen_at)}${d.revoked_at ? ' · Revoked' : ''}</div>
        </div>
        <button class="act-btn delete" type="button" ${d.revoked_at ? 'disabled style="opacity:.4;cursor:not-allowed;"' : ''} data-revoke-device="1" data-user-id="${d.user_id}" data-device-id="${d.device_id}">Logout</button>
      </div>
    `).join('') : '<div style="color:var(--muted);">Belum ada device tercatat.</div>';

    modal.querySelectorAll('[data-revoke-device="1"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Logout device ini?')) return;
        await revokeDeviceSession(btn.getAttribute('data-user-id'), btn.getAttribute('data-device-id'));
        await renderUserSecurityModal();
      });
    });
  }

  function openUserSecurityModal() {
    ensureUserSecurityModal();
    renderUserSecurityModal();
    document.getElementById('accountSecurityModal')?.classList.add('show');
  }

  function insertUserButtons() {
    const actions = document.querySelector('.profile-actions');
    if (actions && !document.getElementById('btnAccountSecurity')) {
      const btn = document.createElement('button');
      btn.className = 'history-btn';
      btn.id = 'btnAccountSecurity';
      btn.innerHTML = '🔐 <span>Keamanan Akun</span>';
      btn.addEventListener('click', openUserSecurityModal);
      actions.insertBefore(btn, actions.children[1] || null);
    }

    const sidebarAcc = Array.from(document.querySelectorAll('.sidebar-section summary'))
      .find(s => (s.textContent || '').includes('Akun'));
    const sidebarLinks = sidebarAcc?.parentElement?.querySelector('.sidebar-links');
    if (sidebarLinks && !sidebarLinks.querySelector('[data-account-security-link="1"]')) {
      const b = document.createElement('button');
      b.className = 'sidebar-link-btn';
      b.dataset.accountSecurityLink = '1';
      b.innerHTML = '<span>🔐</span><span>Keamanan Akun</span><small>Ganti password & device</small>';
      b.onclick = () => { openUserSecurityModal(); if (typeof window.closeSidebar === 'function') window.closeSidebar(); };
      sidebarLinks.insertBefore(b, sidebarLinks.children[1] || null);
    }
  }

  async function bootstrapUserSide() {
    const ctx = await waitForAuth();
    if (!ctx?.session?.user?.id) return;
    await ensureDeviceSession();
    await recordAuthEvent('login', { page: 'user' });
    insertUserButtons();

    const origLogout = window.doLogout;
    if (typeof origLogout === 'function' && !origLogout.__jlptAccountWrapped) {
      const wrapped = async function (...args) {
        try { await recordAuthEvent('logout', { page: 'user' }); } catch {}
        return origLogout.apply(this, args);
      };
      wrapped.__jlptAccountWrapped = true;
      window.doLogout = wrapped;
    }

    setInterval(async () => {
      const rows = await loadDeviceSessions(ctx.session.user.id);
      const current = rows.find(r => String(r.device_id) === String(window.__JLPT_DEVICE_ID__ || getDeviceId()));
      if (current?.revoked_at) {
        toast('⛔ Device ini telah dinonaktifkan');
        try { await ctx.sb.auth.signOut(); } catch {}
        location.replace('./auth.html');
      }
    }, 30000);
  }

  // =========================
  // ADMIN UI
  // =========================
  function ensureAdminLoginPane() {
    if (document.getElementById('pane-loginhistory')) return;
    const content = document.querySelector('.content');
    if (!content) return;
    const pane = document.createElement('div');
    pane.className = 'pane';
    pane.id = 'pane-loginhistory';
    pane.innerHTML = `
      <div class="table-wrap">
        <div class="table-head">
          <div class="table-title">🕘 Login History & Device Control</div>
          <div class="table-actions">
            <input class="search-mini" id="adminLoginSearch" type="text" placeholder="Cari user/device..." style="width:220px;">
            <select class="form-input" id="adminLoginFilter" style="width:170px;padding:8px 12px;border-radius:10px;font-size:13px;">
              <option value="all">Semua</option>
              <option value="login">Login</option>
              <option value="logout">Logout</option>
              <option value="password_change">Password</option>
              <option value="device_revoked">Logout Device</option>
              <option value="account_deleted">Hapus Akun</option>
            </select>
            <button class="topbar-btn primary" id="adminLoginRefreshBtn" type="button">🔄 Refresh</button>
          </div>
        </div>
        <div style="overflow:auto;max-height:560px;">
          <table>
            <thead><tr><th>User</th><th>Action</th><th>Device</th><th>Time</th><th>Meta</th><th>Aksi</th></tr></thead>
            <tbody id="adminLoginHistoryTable"><tr><td colspan="6" class="empty-state"><p>Memuat...</p></td></tr></tbody>
          </table>
        </div>
      </div>
    `;
    const usersPane = document.getElementById('pane-users');
    if (usersPane && usersPane.parentElement) usersPane.after(pane);
    else content.appendChild(pane);
  }

  function ensureAdminNavItem() {
    if (document.getElementById('navLoginHistory')) return;
    const navSection = Array.from(document.querySelectorAll('.nav-section'))
      .find(el => (el.textContent || '').includes('Manajemen User'));
    if (!navSection) return;
    const target = navSection.nextElementSibling?.nextElementSibling?.nextElementSibling; // after Users & Pending? maybe best effort
    const navItem = document.createElement('div');
    navItem.className = 'nav-item';
    navItem.id = 'navLoginHistory';
    navItem.setAttribute('onclick', "goto('loginhistory')");
    navItem.innerHTML = '<span class="nav-icon">🕘</span> Login History';
    if (target && target.parentElement) target.parentElement.insertBefore(navItem, target);
    else navSection.parentElement.insertBefore(navItem, navSection.nextSibling.nextSibling);
  }

  async function renderAdminLoginHistoryPanel() {
    ensureAdminLoginPane();
    const tbody = document.getElementById('adminLoginHistoryTable');
    if (!tbody) return;

    const [histories, userMap, devices] = await Promise.all([
      loadLoginHistory(null, 500),
      loadUserMapForAccountTools(),
      loadDeviceSessions(null),
    ]);
    window.__JLPT_LOGIN_USER_MAP__ = userMap instanceof Map ? userMap : new Map();
    const q = String(document.getElementById('adminLoginSearch')?.value || '').trim().toLowerCase();
    const filter = String(document.getElementById('adminLoginFilter')?.value || 'all');

    const rows = histories.filter(r => {
      if (filter !== 'all' && String(r.action || '') !== filter) return false;
      if (!q) return true;
      const u = (window.__JLPT_LOGIN_USER_MAP__ || new Map()).get(r.user_id) || {};
      const hay = [u.display_name, u.full_name, u.email, r.email, r.action, r.device_name, r.user_agent].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });

    tbody.innerHTML = rows.length ? rows.slice(0, 200).map(r => {
      const u = (window.__JLPT_LOGIN_USER_MAP__ || new Map()).get(r.user_id) || {};
      const name = u.display_name || u.full_name || u.email || r.email || r.user_id || '—';
      const dev = formatDeviceLabel(r);
      const meta = JSON.stringify(r.meta || {}).slice(0, 120);
      const revoked = r.revoked_at ? '<span class="status rejected">Revoked</span>' : '<span class="status active">Active</span>';
      const revokeBtn = r.action === 'login' && !r.revoked_at ? `<button class="act-btn delete" type="button" data-admin-revoke-device="1" data-user-id="${r.user_id}" data-device-id="${r.device_id}">Logout Device</button>` : '';
      return `<tr>
        <td>${name}</td>
        <td><span class="status active">${r.action}</span></td>
        <td>${dev}<div style="margin-top:6px;">${revoked}</div></td>
        <td style="font-size:12px;color:var(--muted);">${formatTime(r.created_at)}</td>
        <td style="font-size:12px;color:var(--muted);word-break:break-word;">${meta}</td>
        <td>${revokeBtn}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="6" class="empty-state"><p>Tidak ada login history.</p></td></tr>';

    tbody.querySelectorAll('[data-admin-revoke-device="1"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Logout device ini?')) return;
        await revokeDeviceSession(btn.getAttribute('data-user-id'), btn.getAttribute('data-device-id'));
        await renderAdminLoginHistoryPanel();
      });
    });

    document.getElementById('adminLoginRefreshBtn')?.addEventListener('click', () => renderAdminLoginHistoryPanel());
    document.getElementById('adminLoginSearch')?.addEventListener('input', () => renderAdminLoginHistoryPanel());
    document.getElementById('adminLoginFilter')?.addEventListener('change', () => renderAdminLoginHistoryPanel());
  }

  function injectAdminNav() {
    if (document.getElementById('navLoginHistory')) return;
    const navTarget = Array.from(document.querySelectorAll('.nav-item'))
      .find(el => (el.textContent || '').includes('User Pending'));
    const navItem = document.createElement('div');
    navItem.className = 'nav-item';
    navItem.id = 'navLoginHistory';
    navItem.setAttribute('onclick', "goto('loginhistory')");
    navItem.innerHTML = '<span class="nav-icon">🕘</span> Login History';
    if (navTarget?.parentElement) navTarget.parentElement.insertBefore(navItem, navTarget.nextSibling);
  }

  function patchGoto() {
    if (typeof window.goto !== 'function' || window.goto.__jlptLoginHistoryWrapped) return;
    const original = window.goto;
    const wrapped = function (pane) {
      original.apply(this, arguments);
      if (pane === 'loginhistory') {
        document.getElementById('pageTitle') && (document.getElementById('pageTitle').textContent = 'Login History');
        renderAdminLoginHistoryPanel();
      }
    };
    wrapped.__jlptLoginHistoryWrapped = true;
    window.goto = wrapped;
  }

  async function bootstrapAdminSide() {
    const ctx = await waitForAuth();
    if (!ctx?.session?.user?.id) return;
    injectAdminNav();
    ensureAdminLoginPane();
    patchGoto();
    await recordAuthEvent('login', { page: 'admin' });
    setInterval(async () => {
      const rows = await loadDeviceSessions(ctx.session.user.id);
      const current = rows.find(r => String(r.device_id) === String(window.__JLPT_DEVICE_ID__ || getDeviceId()));
      if (current?.revoked_at) {
        toast('⛔ Admin device telah dinonaktifkan');
        try { await ctx.sb.auth.signOut(); } catch {}
        location.replace('./auth.html');
      }
    }, 30000);
  }

  async function init() {
    const ctx = await waitForAuth();
    if (!ctx?.session?.user?.id) return;

    if (location.pathname.toLowerCase().includes('admin.html')) {
      await bootstrapAdminSide();
      document.addEventListener('DOMContentLoaded', () => renderAdminLoginHistoryPanel(), { once: true });
      if (window.JLPT_SYNC?.refreshAdminPanels) {
        const orig = window.JLPT_SYNC.refreshAdminPanels;
        window.JLPT_SYNC.refreshAdminPanels = async function(...args){
          const out = await orig.apply(this, args);
          await renderAdminLoginHistoryPanel();
          return out;
        };
      }
    } else {
      await bootstrapUserSide();
      document.addEventListener('DOMContentLoaded', () => renderUserSecurityModal(), { once: true });
    }

    // Make sure logout records are written even if the page uses a different handler.
    const wrapLogout = () => {
      const orig = window.doLogout;
      if (typeof orig === 'function' && !orig.__jlptAccountWrapped) {
        const wrapped = async function (...args) {
          try { await recordAuthEvent('logout', { page: location.pathname }); } catch {}
          return orig.apply(this, args);
        };
        wrapped.__jlptAccountWrapped = true;
        window.doLogout = wrapped;
      }
    };
    wrapLogout();
    setTimeout(wrapLogout, 1200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  window.__JLPT_ACCOUNT_TOOLS__ = {
    recordAuthEvent,
    loadLoginHistory,
    loadDeviceSessions,
    revokeDeviceSession,
    changePassword,
    deleteOwnAccount,
    renderUserSecurityModal,
    renderAdminLoginHistoryPanel,
    openUserSecurityModal,
  };
})();