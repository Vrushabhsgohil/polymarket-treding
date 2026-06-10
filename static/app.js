/* ══════════════════════════════════════════════════════════════
   PolyBot — Application Logic
   Polymarket-Style AI Trading Terminal
   ══════════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {
    'use strict';

    // Intercept browser console errors to log them to UI and backend for diagnostics
    const originalConsoleError = console.error;
    console.error = function (...args) {
        originalConsoleError.apply(console, args);
        const msg = args.map(arg => {
            if (arg instanceof Error) return arg.stack || arg.message;
            if (typeof arg === 'object') {
                try { return JSON.stringify(arg); } catch { return String(arg); }
            }
            return String(arg);
        }).join(' ');
        if (msg.includes('/api/logs')) return; // Avoid infinite loops on logging failures
        addFrontendLog('BROWSER_ERROR', msg, 'error');
    };

    // ── Global State Variables ───────────────────────────────────
    let balanceChart = null;
    let analysisHistoryChart = null;
    let portfolioPnlChart = null;
    let portfolioExposureChart = null;
    let portfolioData = { balance: 0, positions: [], history: [] };
    let pollInterval = null;
    let isBotActive = false;
    let confirmResolve = null;
    let sectorsPayload = [];
    let currentStep = 1;
    let selectedSector = null; // Will default to 'all' in loadSectors
    let selectedSubsectors = new Set();
    let selectedQueries = new Set();
    let fetchedQueries = [];
    let analysesCache = [];
    let currentAnalysis = null;
    let currentDetailMarket = null;
    let currentSellPosition = null;

    // Holds the real live order book data for the active modal
    let liveOrderBooks = { yes: [], no: [] };
    let orderBookPollInterval = null;

    // ── 1. Utilities ─────────────────────────────────────────────
    function escapeHtml(str) {
        if (!str) return '';
        const d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    }

    async function apiFetch(url, opts = {}) {
        const token = sessionStorage.getItem('polybot-token');
        const method = (opts.method || 'GET').toUpperCase();
        const originalBody = opts.body;

        // Do not log routine polling endpoints to avoid spamming the backend / logs
        const silentEndpoints = ['/api/logs', '/api/status', '/api/balance', '/api/positions', '/api/history', '/api/portfolio', '/api/orderbook'];
        const isSilent = silentEndpoints.some(e => url.includes(e));

        if (!isSilent) {
            addFrontendLog('API_REQUEST', `${method} ${url}`, 'info', { url, method });
        }
        const headers = { ...(opts.headers || {}) };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
            headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(opts.body);
        }
        try {
            const res = await fetch(url, { ...opts, headers });
            if (!isSilent) {
                addFrontendLog(res.ok ? 'API_RESPONSE' : 'API_ERROR_RESPONSE', `${method} ${url} -> ${res.status}`, res.ok ? 'info' : 'error', {
                    url,
                    method,
                    status: res.status,
                    request_body: originalBody && !(originalBody instanceof FormData) ? originalBody : undefined
                });
            }
            if (res.status === 401) {
                sessionStorage.removeItem('polybot-token');
                showLogin();
                throw new Error('Unauthorized');
            }
            return res;
        } catch (err) {
            if (!isSilent) {
                addFrontendLog('API_FETCH_FAILED', `${method} ${url} failed`, 'error', { url, method, error: err.message });
            }
            throw err;
        }
    }

    async function safeJson(res) {
        try { return await res.json(); } catch { return {}; }
    }

    // ── Operation Logs: visible + console logs for every important action ──
    let frontendOperationLogs = [];

    function ensureOperationLogPanel() {
        if (document.getElementById('operation-log-panel')) return;
        const panel = document.createElement('div');
        panel.id = 'operation-log-panel';
        panel.className = 'operation-log-panel collapsed';
        panel.innerHTML = `
      <button id="operation-log-toggle" class="operation-log-toggle" type="button">System Logs</button>
      <div class="operation-log-content">
        <div class="operation-log-head">
          <strong>Operation Logs</strong>
          <button id="operation-log-clear" type="button">Clear</button>
        </div>
        <div id="operation-log-list" class="operation-log-list"></div>
      </div>`;
        document.body.appendChild(panel);
        document.getElementById('operation-log-toggle')?.addEventListener('click', () => {
            panel.classList.toggle('collapsed');
        });
        document.getElementById('operation-log-clear')?.addEventListener('click', () => {
            frontendOperationLogs = [];
            localStorage.removeItem('polybot-operation-logs');
            renderOperationLogs();
        });
        try {
            const saved = JSON.parse(localStorage.getItem('polybot-operation-logs') || '[]');
            if (Array.isArray(saved)) frontendOperationLogs = saved.slice(-150);
        } catch { }
        renderOperationLogs();
    }

    function addFrontendLog(action, message, level = 'info', details = {}) {
        const entry = {
            timestamp: new Date().toISOString(),
            level: String(level || 'info').toUpperCase(),
            source: 'UI',
            action: String(action || 'UNKNOWN').toUpperCase(),
            message: String(message || ''),
            details: details || {}
        };
        frontendOperationLogs.unshift(entry);
        frontendOperationLogs = frontendOperationLogs.slice(0, 150);
        localStorage.setItem('polybot-operation-logs', JSON.stringify(frontendOperationLogs));
        // Use raw console.log here to avoid triggering interceptors
        console.log(`[PolyBot:${entry.level}] ${entry.action} - ${entry.message}`, entry.details);
        renderOperationLogs();

        // Send the log to backend
        apiFetch('/api/logs', {
            method: 'POST',
            body: {
                action: entry.action,
                message: entry.message,
                level: entry.level,
                source: 'UI',
                details: entry.details
            }
        }).catch(() => { });
    }

    function renderOperationLogs(serverLogs = null) {
        const list = document.getElementById('operation-log-list');
        if (!list) return;
        const merged = [
            ...(serverLogs || []),
            ...frontendOperationLogs
        ].sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0)).slice(0, 80);

        if (!merged.length) {
            list.innerHTML = '<div class="operation-log-empty">No operation logs yet.</div>';
            return;
        }

        list.innerHTML = merged.map(l => `
      <div class="operation-log-item ${String(l.level || 'info').toLowerCase()}">
        <div class="operation-log-line">
          <span class="operation-log-action">${escapeHtml(l.action || 'LOG')}</span>
          <span class="operation-log-time">${formatTime(l.timestamp)}</span>
        </div>
        <div class="operation-log-message">${escapeHtml(l.message || '')}</div>
        ${l.details && Object.keys(l.details).length ? `<pre>${escapeHtml(JSON.stringify(l.details, null, 2))}</pre>` : ''}
      </div>`).join('');
    }

    async function fetchOperationLogs() {
        try {
            const res = await apiFetch('/api/logs?limit=100');
            if (!res.ok) return;
            const data = await safeJson(res);
            renderOperationLogs(data.logs || []);
        } catch (e) {
            console.warn('Failed to fetch operation logs', e);
        }
    }

    function formatUsd(v) {
        const n = Number(v);
        if (isNaN(n)) return '$0.00';
        return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function formatTime(ts) {
        if (!ts) return '--';
        const d = new Date(ts);
        if (isNaN(d)) return ts;
        return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    function pctFromPrice(p) {
        if (p == null || p === '') return '--';
        return Math.round(Number(p) * 100) + '¢';
    }

    // ── 2. Toast System ──────────────────────────────────────────
    const toastContainer = document.getElementById('toast-container');

    function showToast(message, type = 'info') {
        if (!toastContainer) return;
        const t = document.createElement('div');
        t.className = `toast toast-${type}`;
        const iconSvg = type === 'success'
            ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6 9 17l-5-5"/></svg>'
            : type === 'error'
                ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/></svg>'
                : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>';
        t.innerHTML = `<span class="toast-icon ${type}">${iconSvg}</span><span>${escapeHtml(message)}</span>`;
        toastContainer.appendChild(t);
        requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('show')));
        setTimeout(() => {
            t.classList.remove('show');
            setTimeout(() => t.remove(), 350);
        }, 4000);
    }

    // ── 3. Confirm Dialog ────────────────────────────────────────
    const confirmOverlay = document.getElementById('confirm-dialog');

    function showConfirm(title, message, type = 'info') {
        return new Promise(resolve => {
            confirmResolve = resolve;
            const titleEl = document.getElementById('confirm-title');
            const msgEl = document.getElementById('confirm-message');
            const icon = document.getElementById('confirm-icon');
            const okBtn = document.getElementById('confirm-ok-btn');

            if (titleEl) titleEl.textContent = title;
            if (msgEl) msgEl.textContent = message;
            if (icon) icon.className = `confirm-icon ${type}`;
            if (okBtn) okBtn.className = type === 'danger' ? 'btn btn-red btn-sm' : 'btn btn-primary btn-sm';

            if (confirmOverlay) {
                confirmOverlay.classList.remove('hidden');
                requestAnimationFrame(() => confirmOverlay.classList.add('show'));
            }
        });
    }

    function closeConfirm(result) {
        if (confirmOverlay) {
            confirmOverlay.classList.remove('show');
            setTimeout(() => confirmOverlay.classList.add('hidden'), 200);
        }
        if (confirmResolve) { confirmResolve(result); confirmResolve = null; }
    }

    document.getElementById('confirm-ok-btn')?.addEventListener('click', () => closeConfirm(true));
    document.getElementById('confirm-cancel-btn')?.addEventListener('click', () => closeConfirm(false));

    // ── 4. Theme Manager ─────────────────────────────────────────
    const themeToggleBtn = document.getElementById('theme-toggle-btn');
    const themeIcon = document.getElementById('theme-icon');
    const settingTheme = document.getElementById('setting-theme');

    function applyTheme(mode) {
        document.documentElement.setAttribute('data-theme', mode);
        localStorage.setItem('polybot-theme', mode);

        if (themeIcon) {
            themeIcon.innerHTML = mode === 'dark'
                ? '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'
                : '<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>';
        }

        if (settingTheme) settingTheme.value = mode;

        if (balanceChart) {
            updateChartTheme();
        }
        if (analysisHistoryChart) {
            updateChartTheme();
        }
    }

    function toggleTheme() {
        const current = document.documentElement.getAttribute('data-theme') || 'light';
        applyTheme(current === 'light' ? 'dark' : 'light');
    }

    themeToggleBtn?.addEventListener('click', toggleTheme);
    settingTheme?.addEventListener('change', (e) => applyTheme(e.target.value));

    applyTheme(localStorage.getItem('polybot-theme') || 'light');
    ensureOperationLogPanel();

    // ── 5. Auth / Login ──────────────────────────────────────────
    const loginOverlay = document.getElementById('login-overlay');
    const appContainer = document.getElementById('app-container');
    const loginBtn = document.getElementById('login-btn');
    const registerBtn = document.getElementById('register-btn');
    const loginUsername = document.getElementById('login-username');
    const loginPassword = document.getElementById('login-password');
    const loginError = document.getElementById('login-error');
    const logoutBtn = document.getElementById('logout-btn');
    const termsModal = document.getElementById('terms-modal');
    const termsCheckbox = document.getElementById('terms-checkbox');
    const viewTermsLink = document.getElementById('view-terms-link');

    if (loginBtn) loginBtn.disabled = true;
    if (registerBtn) registerBtn.disabled = true;

    termsCheckbox?.addEventListener('change', (e) => {
        if (loginBtn) loginBtn.disabled = !e.target.checked;
        if (registerBtn) registerBtn.disabled = !e.target.checked;
    });

    if (localStorage.getItem('polybot-terms-accepted') === 'true') {
        if (termsCheckbox) {
            termsCheckbox.checked = true;
            if (loginBtn) loginBtn.disabled = false;
            if (registerBtn) registerBtn.disabled = false;
        }
    }

    viewTermsLink?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (termsModal) termsModal.classList.remove('hidden');
        const acceptBtn = document.getElementById('accept-terms-btn');
        if (acceptBtn) acceptBtn.style.display = '';
    });

    function showLogin() {
        if (loginOverlay) loginOverlay.classList.remove('hidden');
        if (appContainer) appContainer.classList.add('hidden');
    }

    function showApp() {
        if (loginOverlay) loginOverlay.classList.add('hidden');
        if (appContainer) appContainer.classList.remove('hidden');
        initApp();
    }

    async function doLogin() {
        const un = loginUsername?.value || '';
        const pw = loginPassword?.value || '';
        if (loginError) loginError.textContent = '';

        if (!termsCheckbox?.checked) {
            if (loginError) loginError.textContent = 'You must accept the terms to continue.';
            return;
        }

        if (!un || !pw) {
            if (loginError) loginError.textContent = 'Username and password are required.';
            return;
        }

        if (loginBtn) {
            loginBtn.disabled = true;
            loginBtn.textContent = 'Authenticating…';
        }

        try {
            const res = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: un, password: pw })
            });

            if (!res.ok) {
                const data = await safeJson(res);
                throw new Error(data.detail || 'Invalid username or password');
            }

            const data = await safeJson(res);
            sessionStorage.setItem('polybot-token', data.token || 'noauth');
            localStorage.setItem('polybot-terms-accepted', 'true');
            showApp();

        } catch (e) {
            if (loginError) loginError.textContent = e.message;
            if (loginBtn) loginBtn.disabled = false;
        } finally {
            if (loginBtn) loginBtn.textContent = 'Login';
        }
    }

    async function doRegister() {
        const un = loginUsername?.value || '';
        const pw = loginPassword?.value || '';
        if (loginError) loginError.textContent = '';

        if (!termsCheckbox?.checked) {
            if (loginError) loginError.textContent = 'You must accept the terms to continue.';
            return;
        }

        if (!un || !pw) {
            if (loginError) loginError.textContent = 'Username and password are required.';
            return;
        }

        if (registerBtn) {
            registerBtn.disabled = true;
            registerBtn.textContent = 'Registering…';
        }

        try {
            const res = await fetch('/api/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: un, password: pw })
            });

            if (!res.ok) {
                const data = await safeJson(res);
                throw new Error(data.detail || 'Registration failed');
            }

            showToast('Registration successful! Logging in...', 'success');
            sessionStorage.setItem('polybot-token', `${un}:${pw}`);
            localStorage.setItem('polybot-terms-accepted', 'true');
            showApp();

        } catch (e) {
            if (loginError) loginError.textContent = e.message;
        } finally {
            if (registerBtn) {
                registerBtn.disabled = false;
                registerBtn.textContent = 'Register';
            }
        }
    }

    loginBtn?.addEventListener('click', doLogin);
    registerBtn?.addEventListener('click', doRegister);
    loginPassword?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && termsCheckbox?.checked) doLogin(); });
    loginUsername?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && termsCheckbox?.checked) doLogin(); });

    document.getElementById('accept-terms-btn')?.addEventListener('click', () => {
        if (termsModal) termsModal.classList.add('hidden');
        if (termsCheckbox) {
            termsCheckbox.checked = true;
            termsCheckbox.dispatchEvent(new Event('change'));
        }
    });

    document.getElementById('close-terms-btn')?.addEventListener('click', () => {
        if (termsModal) termsModal.classList.add('hidden');
    });

    logoutBtn?.addEventListener('click', async () => {
        const ok = await showConfirm('Logout', 'Are you sure you want to logout?', 'info');
        if (ok) {
            sessionStorage.removeItem('polybot-token');
            showLogin();
        }
    });

    // ── 6. Navigation ────────────────────────────────────────────
    const navItems = document.querySelectorAll('.nav-item[data-page]');
    const pageSections = document.querySelectorAll('.page-section');

    function navigateTo(pageId) {
        navItems.forEach(n => n.classList.toggle('active', n.dataset.page === pageId));
        pageSections.forEach(s => {
            s.classList.remove('active');
            if (s.id === `page-${pageId}`) s.classList.add('active');
        });

        if (pageId === 'dashboard') fetchDashboardData();
        if (pageId === 'portfolio') fetchPositions();
        if (pageId === 'history') fetchHistory();
        if (pageId === 'markets') fetchAnalyses();

        closeMobileSidebar();
    }

    navItems.forEach(btn => {
        btn.addEventListener('click', () => navigateTo(btn.dataset.page));
    });

    const sidebar = document.getElementById('sidebar');
    const sidebarBackdrop = document.getElementById('sidebar-backdrop');

    document.getElementById('mobile-menu-btn')?.addEventListener('click', () => {
        if (sidebar) sidebar.classList.add('open');
        if (sidebarBackdrop) sidebarBackdrop.classList.add('show');
    });

    function closeMobileSidebar() {
        if (sidebar) sidebar.classList.remove('open');
        if (sidebarBackdrop) sidebarBackdrop.classList.remove('show');
    }

    sidebarBackdrop?.addEventListener('click', closeMobileSidebar);

    // ── 7. Market Tabs ───────────────────────────────────────────
    const tabDiscover = document.getElementById('tab-discover');
    const tabRecommendation = document.getElementById('tab-recommendation');
    const tabAnalysis = document.getElementById('tab-analysis');
    const contentDiscover = document.getElementById('tab-content-discover');
    const contentRecommendation = document.getElementById('tab-content-recommendation');
    const contentAnalysis = document.getElementById('tab-content-analysis');

    function switchMarketTab(tab) {
        [tabDiscover, tabRecommendation, tabAnalysis].forEach(t => t?.classList.remove('active'));
        [contentDiscover, contentRecommendation, contentAnalysis].forEach(c => c?.classList.add('hidden'));

        if (tab === 'discover') {
            tabDiscover?.classList.add('active');
            contentDiscover?.classList.remove('hidden');
        } else if (tab === 'recommendation') {
            tabRecommendation?.classList.add('active');
            contentRecommendation?.classList.remove('hidden');
        } else {
            tabAnalysis?.classList.add('active');
            contentAnalysis?.classList.remove('hidden');
        }
    }

    tabDiscover?.addEventListener('click', () => switchMarketTab('discover'));
    tabRecommendation?.addEventListener('click', () => switchMarketTab('recommendation'));
    tabAnalysis?.addEventListener('click', () => switchMarketTab('analysis'));

    // ── 8. Bot Control ───────────────────────────────────────────
    const toggleBotBtn = document.getElementById('toggle-bot-btn');
    const engineDot = document.getElementById('engine-dot');
    const engineLabel = document.getElementById('engine-label');

    async function fetchStatus() {
        try {
            const res = await apiFetch('/api/status');
            if (res.ok) {
                const data = await safeJson(res);
                isBotActive = data.active;
                if (data.config?.selected_queries) {
                    data.config.selected_queries.forEach(q => selectedQueries.add(String(q)));
                }
                updateBotUI(data);
            }
        } catch (e) {
            console.error('Failed to fetch status', e);
        }
    }

    function updateBotUI(data = null) {
        const processCard = document.getElementById('bot-process-card');
        if (isBotActive) {
            if (engineDot) engineDot.classList.add('active');
            if (engineLabel) engineLabel.textContent = 'Engine Running';
            if (toggleBotBtn) {
                toggleBotBtn.innerHTML = `
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
          Stop Engine`;
                toggleBotBtn.classList.remove('btn-primary');
                toggleBotBtn.classList.add('btn-red');
            }

            // Show monitor card
            if (processCard) processCard.classList.remove('hidden');

            // Start polling status if not already polling
            if (!pollInterval) {
                pollInterval = setInterval(fetchStatus, 3000);
            }
        } else {
            if (engineDot) engineDot.classList.remove('active');
            if (engineLabel) engineLabel.textContent = 'Engine Offline';
            if (toggleBotBtn) {
                toggleBotBtn.innerHTML = `
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          Start Engine`;
                toggleBotBtn.classList.add('btn-primary');
                toggleBotBtn.classList.remove('btn-red');
            }

            // Hide monitor card
            if (processCard) processCard.classList.add('hidden');

            // Stop polling status
            if (pollInterval) {
                clearInterval(pollInterval);
                pollInterval = null;
            }
        }

        // If data is provided, update the monitor fields
        if (data && data.process_state) {
            const state = data.process_state;
            const statusBadge = document.getElementById('bot-monitor-status');
            const currentTask = document.getElementById('bot-monitor-current-task');
            const lastRun = document.getElementById('bot-monitor-last-run');
            const nextRun = document.getElementById('bot-monitor-next-run');
            const logsConsole = document.getElementById('bot-monitor-logs');

            if (statusBadge) {
                statusBadge.textContent = state.status;
                statusBadge.className = 'badge ' + (state.status.toLowerCase() === 'running' ? 'badge-green pulsing' : 'badge-secondary');
            }

            if (currentTask) {
                currentTask.textContent = state.current_action || 'Idle';
            }

            if (lastRun) {
                lastRun.textContent = state.last_run ? formatTime(state.last_run) : '--:--:--';
            }

            if (nextRun) {
                nextRun.textContent = state.next_run ? formatTime(state.next_run) : '--:--:--';
            }

            // Highlight pipeline steps based on the current step/action
            const stepScan = document.getElementById('step-scan');
            const stepPositions = document.getElementById('step-positions');
            const stepRisk = document.getElementById('step-risk');
            const stepTrade = document.getElementById('step-trade');

            const action = (state.current_action || '').toLowerCase();

            // Reset classes
            [stepScan, stepPositions, stepRisk, stepTrade].forEach(step => {
                if (step) step.className = 'pipeline-step';
            });

            if (state.status.toLowerCase() === 'running') {
                if (action.includes('scan')) {
                    if (stepScan) stepScan.classList.add('active');
                } else if (action.includes('position') || action.includes('bid/ask')) {
                    if (stepScan) stepScan.classList.add('completed');
                    if (stepPositions) stepPositions.classList.add('active');
                } else if (action.includes('risk') || action.includes('analyzing')) {
                    if (stepScan) stepScan.classList.add('completed');
                    if (stepPositions) stepPositions.classList.add('completed');
                    if (stepRisk) stepRisk.classList.add('active');
                } else if (action.includes('trade') || action.includes('order')) {
                    if (stepScan) stepScan.classList.add('completed');
                    if (stepPositions) stepPositions.classList.add('completed');
                    if (stepRisk) stepRisk.classList.add('completed');
                    if (stepTrade) stepTrade.classList.add('active');
                }
            } else if (state.status.toLowerCase() === 'sleeping') {
                [stepScan, stepPositions, stepRisk, stepTrade].forEach(step => {
                    if (step) step.classList.add('completed');
                });
            }

            if (logsConsole && data.logs) {
                const allowedActions = ['TRADE', 'ANALYSIS', 'POSITION', 'BOT_SCAN', 'LIVE_ORDER'];
                const filteredLogs = data.logs.filter(l => {
                    const actionText = l.action || '';
                    return allowedActions.some(allowed => actionText.includes(allowed));
                });

                logsConsole.innerHTML = filteredLogs.slice(0, 15).map(l => {
                    const actionText = l.action || 'LOG';
                    const messageText = l.message || '';
                    const timeText = formatTime(l.timestamp);
                    return `[${timeText}] [${actionText}] ${messageText}`;
                }).join('\n');
                if (!filteredLogs.length) {
                    logsConsole.innerHTML = '[Console] Waiting for trading or analysis activities...';
                }
                logsConsole.scrollTop = logsConsole.scrollHeight;
            }

            // Trigger updates of dashboard and positions
            if (state.status.toLowerCase() === 'running') {
                fetchDashboardData();
                fetchPositions();
            }
        }
    }

    toggleBotBtn?.addEventListener('click', async () => {
        if (!isBotActive) {
            if (selectedQueries.size === 0) {
                showToast("Select at least one market in the Discover or AI Analysis tab to start the continuous engine.", "info");
                navigateTo('markets');
                if (!selectedSector) openSectorModal();
                return;
            }

            toggleBotBtn.disabled = true;
            try {
                const res = await apiFetch('/api/bot/start', {
                    method: 'POST',
                    body: {
                        sector: selectedSector || 'all',
                        subsections: Array.from(selectedSubsectors),
                        model: document.getElementById('model-select')?.value || 'gemini',
                        selected_queries: Array.from(selectedQueries)
                    }
                });

                if (res.ok) {
                    isBotActive = true;
                    updateBotUI();
                    showToast('Engine loop started successfully.', 'success');
                } else {
                    const data = await safeJson(res);
                    showToast(data.detail || 'Failed to start engine.', 'error');
                }
            } catch (e) {
                showToast('Error starting engine.', 'error');
            } finally {
                toggleBotBtn.disabled = false;
            }
            return;
        }

        const ok = await showConfirm('Stop Engine', 'Stop the continuous AI analysis engine?', 'danger');
        if (!ok) return;

        toggleBotBtn.disabled = true;
        try {
            const res = await apiFetch('/api/bot/stop', { method: 'POST' });
            if (res.ok) {
                isBotActive = false;
                updateBotUI();
                showToast('Engine stopped.', 'success');
            } else {
                showToast('Failed to stop engine.', 'error');
            }
        } catch (e) {
            showToast('Error stopping engine.', 'error');
        } finally {
            toggleBotBtn.disabled = false;
        }
    });

    // ── 9. Sector / Subsector Wizard ─────────────────────────────
    const sectorModal = document.getElementById('sector-modal');
    const sectorGrid = document.getElementById('sector-grid');
    const subsectionGrid = document.getElementById('subsection-grid');

    function openSectorModal() {
        currentStep = 1;
        selectedSector = null;
        selectedSubsectors.clear();
        if (sectorModal) sectorModal.classList.remove('hidden');
        updateWizardUI();
        loadSectors();
    }

    function closeSectorModal() {
        if (sectorModal) sectorModal.classList.add('hidden');
    }

    function updateWizardUI() {
        document.getElementById('wizard-step-1')?.classList.toggle('hidden', currentStep !== 1);
        document.getElementById('wizard-step-2')?.classList.toggle('hidden', currentStep !== 2);

        for (let i = 1; i <= 2; i++) {
            const ind = document.getElementById(`step-${i}-indicator`);
            if (!ind) continue;
            ind.classList.remove('active', 'completed');
            if (i < currentStep) ind.classList.add('completed');
            else if (i === currentStep) ind.classList.add('active');
        }

        const line = document.getElementById('step-line-1');
        if (line) line.classList.toggle('completed', currentStep > 1);

        const backBtn = document.getElementById('wizard-back-btn');
        const nextBtn = document.getElementById('wizard-next-btn');
        const confirmBtn = document.getElementById('confirm-sector-btn');

        if (backBtn) backBtn.disabled = currentStep === 1;

        if (currentStep === 1) {
            if (nextBtn) { nextBtn.classList.remove('hidden'); nextBtn.disabled = !selectedSector; }
            if (confirmBtn) confirmBtn.classList.add('hidden');
        } else {
            if (nextBtn) nextBtn.classList.add('hidden');
            if (confirmBtn) { confirmBtn.classList.remove('hidden'); confirmBtn.disabled = selectedSubsectors.size === 0; }
        }
    }

    async function loadSectors() {
        if (sectorGrid) sectorGrid.innerHTML = '<div class="empty-state" style="padding:24px;">Loading sectors…</div>';

        try {
            const res = await apiFetch('/api/sectors');
            const data = await safeJson(res);
            sectorsPayload = data.sectors || [];

            if (sectorsPayload.length > 0 && !selectedSector) {
                selectedSector = 'all';
                await loadMarketQueries();
            }
            renderSectors();
            renderSectorBar();
        } catch (e) {
            console.error('Sector fetch error:', e);
            sectorsPayload = [
                { id: 'all', name: 'All Sectors', subsections: [] },
                { id: 'politics', name: 'Politics', subsections: ['US Election', 'US Politics'] },
                { id: 'crypto', name: 'Crypto', subsections: ['Bitcoin', 'Ethereum'] }
            ];
            if (!selectedSector) selectedSector = 'all';
            renderSectors();
            renderSectorBar();
        }
    }

    function renderSectors() {
        if (!sectorGrid) return;
        if (!sectorsPayload.length) {
            sectorGrid.innerHTML = '<div class="empty-state">No sectors found.</div>';
            return;
        }

        sectorGrid.innerHTML = sectorsPayload.map(s => `
      <button class="sector-chip ${selectedSector === s.id ? 'active' : ''}" data-sector="${escapeHtml(s.id)}">
        <span class="sector-chip-name">${escapeHtml(s.name)}</span>
        <span class="sector-chip-count">${(s.subsections || []).length} subsectors</span>
      </button>
    `).join('');

        sectorGrid.querySelectorAll('.sector-chip').forEach(btn => {
            btn.addEventListener('click', () => {
                selectedSector = btn.dataset.sector;
                selectedSubsectors.clear();
                renderSectors();
                updateWizardUI();
            });
        });
    }

    function renderSubsections() {
        const sector = sectorsPayload.find(s => s.id === selectedSector);
        if (!sector || !subsectionGrid) return;

        const subs = sector.subsections || [];
        if (!subs.length) {
            subsectionGrid.innerHTML = `
        <div class="empty-state" style="padding: 24px;">
          No subsectors found. <button class="btn btn-primary btn-sm" id="use-general-btn" style="margin-top: 8px;">Use General</button>
        </div>`;
            document.getElementById('use-general-btn')?.addEventListener('click', () => {
                selectedSubsectors.clear();
                selectedSubsectors.add('General');
                renderSubsections();
                updateWizardUI();
            });
            return;
        }

        const allSelected = subs.every(s => selectedSubsectors.has(s));

        let html = `<button class="sector-chip ${allSelected ? 'active' : ''}" id="select-all-subsectors" style="min-width: 130px;">
      <span class="sector-chip-name">All</span>
      <span class="sector-chip-count">${subs.length} total</span>
    </button>`;

        html += subs.map(sub => `
      <button class="sector-chip ${selectedSubsectors.has(sub) ? 'active' : ''}" data-sub="${escapeHtml(sub)}" style="min-width: 130px;">
        <span class="sector-chip-name">${escapeHtml(sub)}</span>
      </button>
    `).join('');

        subsectionGrid.innerHTML = html;

        document.getElementById('select-all-subsectors')?.addEventListener('click', () => {
            if (allSelected) selectedSubsectors.clear();
            else subs.forEach(s => selectedSubsectors.add(s));
            renderSubsections();
            updateWizardUI();
        });

        subsectionGrid.querySelectorAll('.sector-chip[data-sub]').forEach(btn => {
            btn.addEventListener('click', () => {
                const sub = btn.dataset.sub;
                if (selectedSubsectors.has(sub)) selectedSubsectors.delete(sub);
                else selectedSubsectors.add(sub);
                renderSubsections();
                updateWizardUI();
            });
        });
    }

    document.getElementById('wizard-next-btn')?.addEventListener('click', () => {
        if (currentStep === 1 && selectedSector) {
            currentStep = 2;
            const title = document.getElementById('selected-sector-title');
            if (title) title.textContent = sectorsPayload.find(s => s.id === selectedSector)?.name || selectedSector;
            renderSubsections();
            updateWizardUI();
        }
    });

    document.getElementById('wizard-back-btn')?.addEventListener('click', () => {
        if (currentStep === 2) { currentStep = 1; updateWizardUI(); }
    });

    document.getElementById('confirm-sector-btn')?.addEventListener('click', async () => {
        if (!selectedSector || selectedSubsectors.size === 0) return;
        closeSectorModal();
        navigateTo('markets');
        switchMarketTab('discover');

        renderSectorBar();
        await loadMarketQueries();
    });

    document.getElementById('close-sector-modal')?.addEventListener('click', closeSectorModal);
    document.getElementById('cancel-sector-btn')?.addEventListener('click', closeSectorModal);
    sectorModal?.addEventListener('click', (e) => { if (e.target === sectorModal) closeSectorModal(); });

    document.getElementById('load-sectors-btn')?.addEventListener('click', openSectorModal);

    // ── 10. Market Discovery ─────────────────────────────────────
    const marketGrid = document.getElementById('market-grid');
    const marketSearch = document.getElementById('market-search');
    const marketSort = document.getElementById('market-sort');
    const analyzeSelectedBtn = document.getElementById('analyze-selected-btn');
    const subsectorBarEl = document.getElementById('subsector-bar');
    const selectAllCb = document.getElementById('select-all-markets');

    selectAllCb?.addEventListener('change', (e) => {
        const isChecked = e.target.checked;
        if (isChecked) {
            fetchedQueries.forEach(q => selectedQueries.add(String(q.id)));
        } else {
            selectedQueries.clear();
        }
        marketGrid.querySelectorAll('.market-cb').forEach(cb => {
            cb.checked = isChecked;
        });
        updateAnalyzeBtn();
    });

    function renderSectorBar() {
        const bar = document.getElementById('sector-bar');
        if (!bar) return;

        let html = `<button class="sector-pill" id="load-sectors-btn" style="border-style:dashed;">Load Sectors...</button>`;
        sectorsPayload.forEach(s => {
            html += `<button class="sector-pill ${selectedSector === s.id ? 'active' : ''}" data-sector-pill="${escapeHtml(s.id)}">${escapeHtml(s.name)}</button>`;
        });
        bar.innerHTML = html;

        document.getElementById('load-sectors-btn')?.addEventListener('click', openSectorModal);

        bar.querySelectorAll('.sector-pill[data-sector-pill]').forEach(pill => {
            pill.addEventListener('click', async () => {
                selectedSector = pill.dataset.sectorPill;
                selectedSubsectors.clear();
                const sector = sectorsPayload.find(s => s.id === selectedSector);
                if (sector && sector.subsections?.length) {
                    sector.subsections.forEach(sub => selectedSubsectors.add(sub));
                }
                renderSectorBar();
                renderSubsectorBar();
                await loadMarketQueries();
            });
        });

        renderSubsectorBar();
    }

    function renderSubsectorBar() {
        if (!subsectorBarEl) return;
        const sector = sectorsPayload.find(s => s.id === selectedSector);
        if (!sector || !sector.subsections?.length) {
            subsectorBarEl.classList.add('hidden');
            return;
        }

        subsectorBarEl.classList.remove('hidden');
        const subs = sector.subsections;

        let html = `<button class="subsector-chip ${subs.every(s => selectedSubsectors.has(s)) ? 'active' : ''}" id="sub-all">All</button>`;
        html += subs.map(sub =>
            `<button class="subsector-chip ${selectedSubsectors.has(sub) ? 'active' : ''}" data-subsec="${escapeHtml(sub)}">${escapeHtml(sub)}</button>`
        ).join('');

        subsectorBarEl.innerHTML = html;

        document.getElementById('sub-all')?.addEventListener('click', async () => {
            const allSelected = subs.every(s => selectedSubsectors.has(s));
            if (allSelected) selectedSubsectors.clear();
            else subs.forEach(s => selectedSubsectors.add(s));
            renderSubsectorBar();
            await loadMarketQueries();
        });

        subsectorBarEl.querySelectorAll('.subsector-chip[data-subsec]').forEach(chip => {
            chip.addEventListener('click', async () => {
                const sub = chip.dataset.subsec;
                if (selectedSubsectors.has(sub)) selectedSubsectors.delete(sub);
                else selectedSubsectors.add(sub);
                renderSubsectorBar();
                await loadMarketQueries();
            });
        });
    }

    async function loadMarketQueries() {
        if (!marketGrid) return;
        marketGrid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1;">
        <div class="loading-skeleton" style="width:60px;height:60px;border-radius:50%;margin:0 auto 12px;"></div>
        <p>Fetching markets...</p>
      </div>`;

        if (selectAllCb) selectAllCb.checked = false;
        fetchedQueries = [];
        updateAnalyzeBtn();

        try {
            const subsStr = Array.from(selectedSubsectors).join(',');
            const res = await apiFetch(`/api/queries?sector=${encodeURIComponent(selectedSector || 'all')}&subsector=${encodeURIComponent(subsStr)}`);
            if (!res.ok) throw new Error(await res.text());
            const data = await safeJson(res);
            fetchedQueries = data.queries || [];
            addFrontendLog('MARKETS_FETCHED', `Fetched ${fetchedQueries.length} market(s).`, 'info', { sector: selectedSector, subsectors: Array.from(selectedSubsectors) });
            renderMarketCards();
        } catch (e) {
            console.error('Query fetch error:', e);
            addFrontendLog('MARKETS_FETCH_FAILED', 'Failed to fetch markets.', 'error', { error: e.message });
            marketGrid.innerHTML = '<div class="error-state" style="grid-column:1/-1;">Failed to fetch markets. Please try again.</div>';
        }
    }

    function renderMarketCards() {
        if (!marketGrid) return;

        let filtered = [...fetchedQueries];

        const search = marketSearch?.value?.toLowerCase() || '';
        if (search) {
            filtered = filtered.filter(q =>
                q.question?.toLowerCase().includes(search) ||
                q.description?.toLowerCase().includes(search)
            );
        }

        const sortBy = marketSort?.value || 'volume';
        filtered.sort((a, b) => {
            if (sortBy === 'question') return (a.question || '').localeCompare(b.question || '');
            return (Number(b[sortBy]) || 0) - (Number(a[sortBy]) || 0);
        });

        if (selectAllCb && filtered.length > 0) {
            selectAllCb.checked = filtered.every(q => selectedQueries.has(String(q.id)));
        }

        if (!filtered.length) {
            marketGrid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;"><p>No matching markets found.</p></div>';
            return;
        }

        marketGrid.innerHTML = filtered.map(q => {
            const yesPct = q.yes_price ? (q.yes_price * 100).toFixed(1) : '--';
            const noPct = q.no_price ? (q.no_price * 100).toFixed(1) : '--';

            const volNum = Number(q.volume);
            const vol = (!isNaN(volNum) && volNum > 0) ? '$' + Math.round(volNum).toLocaleString() : '--';

            const isChecked = selectedQueries.has(String(q.id));

            return `
        <div class="market-card" data-id="${q.id}">
          <div class="market-card-top">
            <input type="checkbox" class="checkbox-custom market-card-checkbox market-cb" data-id="${q.id}" ${isChecked ? 'checked' : ''} />
            <div class="market-card-question">${escapeHtml(q.question)}</div>
          </div>
          <div class="market-card-prices">
            <div class="price-chip yes">
              <span class="price-chip-label">Yes</span>
              ${yesPct}¢
            </div>
            <div class="price-chip no">
              <span class="price-chip-label">No</span>
              ${noPct}¢
            </div>
          </div>
          <div class="market-card-meta" style="justify-content: space-between;">
            <span class="meta-chip">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
              <strong>${vol}</strong> vol
            </span>
            <button class="btn btn-primary btn-sm analyze-single-btn" data-id="${q.id}">
               <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
               Analyze
            </button>
          </div>
        </div>`;
        }).join('');

        marketGrid.querySelectorAll('.market-cb').forEach(cb => {
            cb.addEventListener('change', () => {
                if (cb.checked) selectedQueries.add(String(cb.dataset.id));
                else selectedQueries.delete(cb.dataset.id);
                updateAnalyzeBtn();
            });
        });

        marketGrid.querySelectorAll('.analyze-single-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                runAnalysis([btn.dataset.id]);
            });
        });

        marketGrid.querySelectorAll('.market-card').forEach(card => {
            card.addEventListener('click', (e) => {
                if (e.target.closest('.analyze-single-btn')) return;

                // If clicking on the top section (checkbox or question), toggle the checkbox
                const cardTop = e.target.closest('.market-card-top');
                if (cardTop) {
                    const cb = cardTop.querySelector('.market-cb');
                    if (cb && e.target !== cb) {
                        cb.checked = !cb.checked;
                        cb.dispatchEvent(new Event('change'));
                    }
                    return;
                }

                openMarketDetail(card.dataset.id);
            });
        });

        updateAnalyzeBtn();
    }

    function updateAnalyzeBtn() {
        if (analyzeSelectedBtn) {
            analyzeSelectedBtn.disabled = selectedQueries.size === 0;
            const count = selectedQueries.size;
            analyzeSelectedBtn.innerHTML = `Analyze Selected (One-off) ${count > 0 ? `(${count})` : ''}`;
        }
    }

    marketSearch?.addEventListener('input', renderMarketCards);
    marketSort?.addEventListener('change', renderMarketCards);

    async function runAnalysis(queryIdsArray) {
        if (!queryIdsArray || queryIdsArray.length === 0) {
            addFrontendLog('ANALYZE_SELECTED_SKIPPED', 'Analyze skipped because no markets are selected.', 'warn');
            showToast('Select at least one market to analyze.', 'info');
            return;
        }

        const model = document.getElementById('model-select')?.value || 'gemini';
        const analysisGrid = document.getElementById('analysis-grid');

        switchMarketTab('analysis');

        if (analysisGrid) {
            analysisGrid.innerHTML = '';
            queryIdsArray.forEach(qid => {
                const q = fetchedQueries.find(item => String(item.id) === String(qid));
                const question = q ? q.question : 'Market ' + qid;
                analysisGrid.innerHTML += `
          <div class="analysis-card rec-hold processing pulsing" id="analysis-card-${qid}" data-id="${qid}">
            <div class="analysis-card-top">
              <div class="analysis-card-question">${escapeHtml(question)}</div>
              <span class="badge badge-secondary">ANALYZING</span>
            </div>
            <div class="analysis-card-preview" style="display:flex; flex-direction:column; gap:8px; margin-top:12px; height: 50px;">
              <div class="shimmer-line" style="width:100%; height:10px; border-radius:4px;"></div>
              <div class="shimmer-line" style="width:85%; height:10px; border-radius:4px;"></div>
              <div class="shimmer-line" style="width:60%; height:10px; border-radius:4px;"></div>
            </div>
            <div class="analysis-card-footer" style="margin-top:16px;">
              <span class="analysis-card-time text-muted">Running AI agents...</span>
              <div class="spinner-small"></div>
            </div>
          </div>
        `;
            });
        }

        addFrontendLog('ANALYZE_SELECTED_START', `Starting analysis-only run for ${queryIdsArray.length} market(s).`, 'info', {
            query_ids: queryIdsArray,
            model
        });

        let completedCount = 0;
        let failedCount = 0;

        const promises = queryIdsArray.map(async (qid) => {
            const q = fetchedQueries.find(item => String(item.id) === String(qid));
            const marketSnapshot = q ? { ...q, id: String(q.id) } : null;

            try {
                const res = await apiFetch('/api/analyze-selected', {
                    method: 'POST',
                    body: {
                        query_ids: [String(qid)],
                        model: model,
                        markets: marketSnapshot ? [marketSnapshot] : []
                    }
                });

                if (!res.ok) {
                    throw new Error(await res.text());
                }

                const data = await safeJson(res);
                if (data.results && data.results.length > 0) {
                    const analysis = data.results[0];

                    // Update cache
                    analysesCache = analysesCache.filter(x => x.token_id !== qid);
                    analysesCache.push(analysis);

                    // Replace placeholder card
                    const cardEl = document.getElementById(`analysis-card-${qid}`);
                    if (cardEl) {
                        cardEl.outerHTML = renderSingleAnalysisCard(analysis);

                        // Bind listeners to new card
                        const newCard = document.getElementById(`analysis-card-${qid}`);
                        if (newCard) {
                            newCard.addEventListener('click', (e) => {
                                e.stopPropagation();
                                openAnalysisModal(qid);
                            });
                            newCard.querySelector('.view-analysis-btn')?.addEventListener('click', (e) => {
                                e.stopPropagation();
                                openAnalysisModal(qid);
                            });
                        }
                    }
                    completedCount++;
                } else {
                    throw new Error('No analysis results returned.');
                }
            } catch (err) {
                console.error(`Analysis failed for query ${qid}:`, err);
                failedCount++;
                const cardEl = document.getElementById(`analysis-card-${qid}`);
                if (cardEl) {
                    cardEl.className = 'analysis-card rec-no';
                    cardEl.innerHTML = `
            <div class="analysis-card-top">
              <div class="analysis-card-question">${escapeHtml(q ? q.question : 'Market ' + qid)}</div>
              <span class="badge badge-red">FAILED</span>
            </div>
            <div class="analysis-card-preview" style="color:var(--red); margin-top:12px;">
              AI analysis failed. Please verify API keys and network connectivity.
            </div>
            <div class="analysis-card-footer" style="margin-top:16px;">
              <span class="analysis-card-time text-muted">Error occurred</span>
            </div>
          `;
                }
            }
        });

        await Promise.all(promises);

        if (completedCount > 0) {
            showToast(`Analysis complete: ${completedCount} succeeded` + (failedCount > 0 ? `, ${failedCount} failed` : ''), 'success');
        } else if (failedCount > 0) {
            showToast(`Analysis failed for all selected markets.`, 'error');
        }

        // Refresh state and other widgets
        fetchDashboardData();
    }

    analyzeSelectedBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        addFrontendLog('ANALYZE_SELECTED_BUTTON', 'Analyze Selected button handler fired.', 'info', { selected_count: selectedQueries.size });
        runAnalysis(Array.from(selectedQueries));
    });

    // ── 11. Market Detail & Calculator (Live Data) ────────────────
    const calcAmount = document.getElementById('calc-usd');
    const calcSide = document.getElementById('calc-side');
    const calcAction = document.getElementById('calc-action');

    function updateCalculator() {
        if (!currentDetailMarket) return;
        const inputVal = Number(calcAmount.value) || 0;
        const side = calcSide.value; // 'yes' or 'no'
        const action = calcAction ? calcAction.value : 'buy';

        const basePrice = side === 'yes' ? currentDetailMarket.yes_price : currentDetailMarket.no_price;

        const calcShares = document.getElementById('calc-shares');
        const calcPayout = document.getElementById('calc-payout');
        const labelInput = document.getElementById('calc-input-label');
        const labelOut1 = document.getElementById('calc-output1-label');
        const labelOut2 = document.getElementById('calc-output2-label');

        if (!basePrice || basePrice <= 0 || !calcShares || !calcPayout) return;

        if (action === 'buy') {
            if (labelInput) labelInput.textContent = 'Amount ($)';
            if (labelOut1) labelOut1.textContent = 'Est. Shares:';
            if (labelOut2) labelOut2.textContent = 'Potential Payout:';

            let totalShares = 0;
            let remainingUsd = inputVal;
            let worstPriceTouched = basePrice;

            let asksToSweep = side === 'yes' ? liveOrderBooks.yes : liveOrderBooks.no;

            if (asksToSweep && asksToSweep.length > 0) {
                for (let ask of asksToSweep) {
                    let costForThisLevel = ask.size * ask.price;
                    worstPriceTouched = ask.price; // Track the highest tier we hit

                    if (remainingUsd > costForThisLevel) {
                        remainingUsd -= costForThisLevel;
                    } else {
                        break;
                    }
                }
            }

            // Polymarket UI Formula: Add 0.5% slippage to the worst price touched
            let polymarketLimitPrice = worstPriceTouched * 1.005;
            polymarketLimitPrice = Math.min(polymarketLimitPrice, 0.999); // Hard cap at 99.9 cents

            // Calculate shares based on this buffered limit price
            totalShares = inputVal / polymarketLimitPrice;

            const payout = totalShares * 1;
            const roi = inputVal > 0 ? ((payout - inputVal) / inputVal) * 100 : 0;

            // Polymarket displays the worst swept price as the "Avg Price" in their UI
            calcShares.innerHTML = `${totalShares.toFixed(2)} <span style="font-size:10px; color:var(--text-muted); font-weight:normal;">(Avg ${(worstPriceTouched * 100).toFixed(1)}¢)</span>`;
            calcPayout.textContent = `${formatUsd(payout)} (+${roi.toFixed(1)}%)`;
            calcPayout.className = side === 'yes' ? 'text-green' : 'text-red';

        } else {
            if (labelInput) labelInput.textContent = 'Shares to Sell';
            if (labelOut1) labelOut1.textContent = 'Est. Price:';
            if (labelOut2) labelOut2.textContent = 'You\'ll Receive:';

            // 0.5% slippage penalty applied downwards for selling
            const sellPrice = Math.max(0.001, basePrice * 0.995);
            const receive = inputVal * sellPrice;

            calcShares.textContent = `$${sellPrice.toFixed(3)}/sh`;
            calcPayout.textContent = `${formatUsd(receive)}`;
            calcPayout.className = 'text-green';
        }
    }
    calcAmount?.addEventListener('input', updateCalculator);
    calcSide?.addEventListener('change', updateCalculator);
    calcAction?.addEventListener('change', updateCalculator);

    async function loadLiveOrderBook(market) {
        const bidsEl = document.getElementById('ob-bids');
        const asksEl = document.getElementById('ob-asks');
        if (!bidsEl || !asksEl) return;

        // Only show loading skeleton on first load (avoid flicker on auto-refresh)
        if (!bidsEl.children.length || bidsEl.querySelector('.text-muted')) {
            bidsEl.innerHTML = '<div class="text-muted" style="font-size:11px;">Loading live book...</div>';
            asksEl.innerHTML = '<div class="text-muted" style="font-size:11px;">Loading live book...</div>';
        }

        try {
            // Fetch via backend proxy (avoids CORS, resolves CLOB token IDs server-side)
            const res = await apiFetch(`/api/orderbook/${market.id}`);
            if (!res.ok) throw new Error(`Orderbook proxy error: ${res.status}`);
            const data = await res.json();

            const yesBook = data.yes || {};
            const noBook = data.no || {};

            // Store sorted asks (ascending price) for the calculator to sweep
            liveOrderBooks.yes = (yesBook.asks || []).map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) })).sort((a, b) => a.price - b.price);
            liveOrderBooks.no = (noBook.asks || []).map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) })).sort((a, b) => a.price - b.price);

            // Display the live YES book in the UI (Bids highest first, Asks lowest first)
            let bidsHtml = '', asksHtml = '';

            const displayBids = (yesBook.bids || []).map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) })).sort((a, b) => b.price - a.price);
            let cumulativeBidTotal = 0;
            for (let i = 0; i < Math.min(4, displayBids.length); i++) {
                const rawSize = displayBids[i].size;
                const rawPrice = displayBids[i].price;
                cumulativeBidTotal += rawSize * rawPrice;

                const size = Math.round(rawSize).toLocaleString();
                const price = (rawPrice * 100).toFixed(1).replace(/\.0$/, '') + '¢';
                const total = '$' + cumulativeBidTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

                bidsHtml += `<div style="display:grid; grid-template-columns: 1fr 1fr 1.2fr;"><span class="text-green">${price}</span><span class="text-secondary" style="text-align:right;">${size}</span><span class="text-secondary" style="text-align:right;">${total}</span></div>`;
            }

            const displayAsks = (yesBook.asks || []).map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) })).sort((a, b) => a.price - b.price);
            let cumulativeAskTotal = 0;
            for (let i = 0; i < Math.min(4, displayAsks.length); i++) {
                const rawSize = displayAsks[i].size;
                const rawPrice = displayAsks[i].price;
                cumulativeAskTotal += rawSize * rawPrice;

                const size = Math.round(rawSize).toLocaleString();
                const price = (rawPrice * 100).toFixed(1).replace(/\.0$/, '') + '¢';
                const total = '$' + cumulativeAskTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

                asksHtml += `<div style="display:grid; grid-template-columns: 1fr 1fr 1.2fr;"><span class="text-red">${price}</span><span class="text-secondary" style="text-align:right;">${size}</span><span class="text-secondary" style="text-align:right;">${total}</span></div>`;
            }

            bidsEl.innerHTML = bidsHtml || '<div class="text-muted">No bids</div>';
            asksEl.innerHTML = asksHtml || '<div class="text-muted">No asks</div>';

            // Trigger the calculator to update with the new live data
            updateCalculator();

        } catch (e) {
            console.error("Failed to load real order book:", e);
            // Only show error on first load, keep existing data on refresh failures
            if (bidsEl.querySelector('.text-muted')) {
                bidsEl.innerHTML = '<div class="text-red" style="font-size:11px;">Failed to load</div>';
                asksEl.innerHTML = '<div class="text-red" style="font-size:11px;">Failed to load</div>';
            }
            updateCalculator();
        }
    }

    function openMarketDetail(id) {
        const q = fetchedQueries.find(item => item.id === id);
        if (!q) return;
        currentDetailMarket = q;

        const titleEl = document.getElementById('market-detail-title');
        const volEl = document.getElementById('mkt-detail-vol');
        const liqEl = document.getElementById('mkt-detail-liq');
        const sourceEl = document.getElementById('mkt-detail-source');
        const descEl = document.getElementById('mkt-detail-desc');

        if (titleEl) titleEl.textContent = q.question;
        if (volEl) volEl.textContent = q.volume ? '$' + Math.round(q.volume).toLocaleString() : '--';
        if (liqEl) liqEl.textContent = q.liquidity ? '$' + Math.round(q.liquidity).toLocaleString() : '--';

        if (sourceEl) {
            if (q.resolution_source || q.url) {
                sourceEl.href = q.url || q.resolution_source;
                sourceEl.textContent = "Polymarket Page / Oracle";
            } else {
                sourceEl.textContent = "--";
            }
        }

        if (descEl) descEl.textContent = q.description || 'No specific rules or description provided by the oracle for this market.';

        // Load actual live data and start auto-refresh
        if (orderBookPollInterval) clearInterval(orderBookPollInterval);
        loadLiveOrderBook(q);
        orderBookPollInterval = setInterval(() => {
            if (currentDetailMarket) loadLiveOrderBook(currentDetailMarket);
        }, 5000);

        if (calcAmount) calcAmount.value = 100;
        updateCalculator();

        const modal = document.getElementById('market-detail-modal');
        if (modal) modal.classList.remove('hidden');
    }

    document.getElementById('close-market-detail')?.addEventListener('click', () => {
        if (orderBookPollInterval) { clearInterval(orderBookPollInterval); orderBookPollInterval = null; }
        currentDetailMarket = null;
        document.getElementById('market-detail-modal')?.classList.add('hidden');
    });

    // ── 12. Analysis Cards ───────────────────────────────────────
    const analysisGrid = document.getElementById('analysis-grid');
    const analysisSearch = document.getElementById('analysis-search');
    const analysisFilterRec = document.getElementById('analysis-filter-rec');
    const analysisModal = document.getElementById('analysis-modal');

    async function fetchAnalyses() {
        try {
            const res = await apiFetch('/api/analyses');
            const data = await safeJson(res);
            analysesCache = data.analyses || [];
            renderAnalysisCards();
        } catch (e) {
            console.error('Fetch analyses error:', e);
        }
    }

    function renderAnalysisCards() {
        if (!analysisGrid) return;

        let filtered = [...analysesCache];

        const search = analysisSearch?.value?.toLowerCase() || '';
        if (search) {
            filtered = filtered.filter(a =>
                a.question?.toLowerCase().includes(search) ||
                a.reasoning?.toLowerCase().includes(search)
            );
        }

        const recFilter = analysisFilterRec?.value || 'all';
        if (recFilter !== 'all') {
            filtered = filtered.filter(a => a.recommended_side?.toLowerCase() === recFilter);
        }

        if (!filtered.length) {
            analysisGrid.innerHTML = '<div class="empty-state" style="grid-column: 1/-1;">No matching analyses found.</div>';
            return;
        }

        analysisGrid.innerHTML = filtered.map(renderSingleAnalysisCard).join('');

        analysisGrid.querySelectorAll('.analysis-cb').forEach(cb => {
            cb.addEventListener('change', (e) => {
                e.stopPropagation();
                if (cb.checked) selectedQueries.add(String(cb.dataset.id));
                else selectedQueries.delete(cb.dataset.id);
                updateAnalyzeBtn();
            });
            cb.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        });

        analysisGrid.querySelectorAll('.view-analysis-btn, .analysis-card').forEach(el => {
            el.addEventListener('click', (e) => {
                if (e.target.closest('.analysis-cb')) return;
                const id = el.dataset.id || el.closest('.analysis-card').dataset.id;
                openAnalysisModal(id);
            });
        });
    }

    function renderSingleAnalysisCard(a) {
        const rec = a.recommended_side?.toUpperCase() || 'HOLD';
        const recClass = `rec-${rec.toLowerCase()}`;
        const isChecked = selectedQueries.has(String(a.token_id));
        return `
      <div class="analysis-card ${recClass}" id="analysis-card-${a.token_id}" data-id="${a.token_id}">
        <div class="analysis-card-top">
          <input type="checkbox" class="checkbox-custom analysis-cb" data-id="${a.token_id}" ${isChecked ? 'checked' : ''} style="margin-right: 8px;" />
          <div class="analysis-card-question">${escapeHtml(a.question || 'Unknown Market')}</div>
          <span class="badge ${rec === 'YES' ? 'badge-green' : rec === 'NO' ? 'badge-red' : 'badge-secondary'}">${rec}</span>
        </div>
        <div class="analysis-card-preview">
          ${escapeHtml(a.reasoning || '').substring(0, 100)}...
        </div>
        <div class="analysis-card-footer">
          <span class="analysis-card-time">Conf: ${a.confidence || 0}%</span>
          <button class="btn btn-secondary btn-sm view-analysis-btn" data-id="${a.token_id}">View Details</button>
        </div>
      </div>
    `;
    }

    analysisSearch?.addEventListener('input', renderAnalysisCards);
    analysisFilterRec?.addEventListener('change', renderAnalysisCards);
    document.getElementById('refresh-analyses-btn')?.addEventListener('click', fetchAnalyses);

    function openAnalysisModal(tokenId) {
        const a = analysesCache.find(x => x.token_id === tokenId);
        if (!a) return;
        currentAnalysis = a;

        document.getElementById('analysis-modal-title').textContent = a.question || 'Analysis Detail';
        document.getElementById('modal-rec').textContent = a.recommended_side || 'HOLD';
        document.getElementById('modal-conf').textContent = (a.confidence || 0) + '%';

        const mkt = fetchedQueries.find(q => q.id === tokenId) || currentDetailMarket;
        document.getElementById('modal-yes').textContent = a.yes_price ? '$' + a.yes_price.toFixed(3) : '--';
        document.getElementById('modal-no').textContent = a.no_price ? '$' + a.no_price.toFixed(3) : '--';

        document.getElementById('modal-reasoning').textContent = a.reasoning || 'No reasoning provided.';

        const sourcesSec = document.getElementById('modal-sources-section');
        const sourcesList = document.getElementById('modal-sources');
        if (a.sources && a.sources.length > 0) {
            if (sourcesSec) sourcesSec.classList.remove('hidden');
            if (sourcesList) sourcesList.innerHTML = a.sources.map(s => `<li><a href="${s}" target="_blank">${s}</a></li>`).join('');
        } else {
            if (sourcesSec) sourcesSec.classList.add('hidden');
        }

        if (analysisModal) analysisModal.classList.remove('hidden');
        updateQuickTradeEstimate();

        fetchAndRenderAnalysisHistory(tokenId);
    }

    async function fetchAndRenderAnalysisHistory(tokenId) {
        try {
            const res = await apiFetch('/api/analyses-history/' + tokenId);
            if (!res.ok) return;
            const data = await safeJson(res);
            const history = data.history || [];
            renderAnalysisHistoryChart(history);
        } catch (e) {
            console.error('Failed to fetch analysis history', e);
        }
    }

    function renderAnalysisHistoryChart(history) {
        const ctx = document.getElementById('analysis-history-chart');
        if (!ctx) return;
        if (analysisHistoryChart) analysisHistoryChart.destroy();

        if (!history || history.length === 0) return;

        const labels = history.map(h => {
            const d = new Date(h.timestamp);
            return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
        });

        const confData = history.map(h => h.confidence || 0);
        const yesData = history.map(h => h.yes_price || 0);
        const noData = history.map(h => h.no_price || 0);

        const textColor = document.documentElement.getAttribute('data-theme') === 'dark' ? '#94a3b8' : '#6b7280';
        const gridColor = document.documentElement.getAttribute('data-theme') === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';

        analysisHistoryChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'AI Confidence (%)',
                        data: confData,
                        borderColor: '#6366f1',
                        backgroundColor: 'transparent',
                        borderWidth: 2,
                        tension: 0.2,
                        yAxisID: 'y'
                    },
                    {
                        label: 'YES Price ($)',
                        data: yesData,
                        borderColor: '#22c55e',
                        backgroundColor: 'transparent',
                        borderWidth: 2,
                        tension: 0.2,
                        yAxisID: 'y1'
                    },
                    {
                        label: 'NO Price ($)',
                        data: noData,
                        borderColor: '#ef4444',
                        backgroundColor: 'transparent',
                        borderWidth: 2,
                        tension: 0.2,
                        yAxisID: 'y1'
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: true,
                        labels: { color: textColor, font: { size: 11 } }
                    }
                },
                scales: {
                    x: { ticks: { color: textColor }, grid: { display: false } },
                    y: {
                        type: 'linear',
                        display: true,
                        position: 'left',
                        min: 0,
                        max: 100,
                        ticks: { color: textColor },
                        grid: { color: gridColor },
                        title: { display: true, text: 'Confidence (%)', color: textColor }
                    },
                    y1: {
                        type: 'linear',
                        display: true,
                        position: 'right',
                        min: 0,
                        max: 1,
                        ticks: { color: textColor },
                        grid: { drawOnChartArea: false },
                        title: { display: true, text: 'Price ($)', color: textColor }
                    }
                }
            }
        });
    }

    function updateQuickTradeEstimate() {
        const estimateEl = document.getElementById('modal-trade-estimate');
        if (!estimateEl || !currentAnalysis) return;

        const sideValue = document.getElementById('modal-trade-side')?.value || 'buy_yes';
        const amount = Number(document.getElementById('modal-trade-amount')?.value || 0);

        let action = 'BUY';
        let side = 'YES';
        if (sideValue === 'buy_no') { action = 'BUY'; side = 'NO'; }
        else if (sideValue === 'sell_yes') { action = 'SELL'; side = 'YES'; }
        else if (sideValue === 'sell_no') { action = 'SELL'; side = 'NO'; }

        const price = side === 'YES' ? currentAnalysis.yes_price : currentAnalysis.no_price;

        if (amount <= 0 || !price || price <= 0) {
            estimateEl.innerHTML = '';
            return;
        }

        if (action === 'BUY') {
            const shares = amount / price;
            estimateEl.innerHTML = `Est. Shares to get: <span class="text-green" style="font-weight:700;">${shares.toFixed(4)} ${side}</span> <span style="color:var(--text-muted); font-size:11px;">(@ $${price.toFixed(3)}/sh)</span>`;
        } else {
            const proceeds = amount;
            const sharesNeeded = amount / price;
            estimateEl.innerHTML = `Est. Shares to sell: <span class="text-red" style="font-weight:700;">${sharesNeeded.toFixed(4)} ${side}</span> to receive <span class="text-green" style="font-weight:700;">$${proceeds.toFixed(2)} USD</span> <span style="color:var(--text-muted); font-size:11px;">(@ $${price.toFixed(3)}/sh)</span>`;
        }
    }

    document.getElementById('modal-trade-amount')?.addEventListener('input', updateQuickTradeEstimate);
    document.getElementById('modal-trade-side')?.addEventListener('change', updateQuickTradeEstimate);

    document.getElementById('close-analysis-modal')?.addEventListener('click', () => {
        if (analysisModal) analysisModal.classList.add('hidden');
    });

    document.getElementById('modal-trade-btn')?.addEventListener('click', async () => {
        if (!currentAnalysis) return;
        const sideValue = document.getElementById('modal-trade-side')?.value || 'buy_yes';
        const amount = Number(document.getElementById('modal-trade-amount')?.value || 0);

        if (amount <= 0) {
            showToast('Please enter a valid amount', 'error');
            return;
        }

        let action = 'BUY';
        let side = 'YES';
        if (sideValue === 'buy_no') { action = 'BUY'; side = 'NO'; }
        else if (sideValue === 'sell_yes') { action = 'SELL'; side = 'YES'; }
        else if (sideValue === 'sell_no') { action = 'SELL'; side = 'NO'; }

        const price = side === 'YES' ? currentAnalysis.yes_price : currentAnalysis.no_price;

        try {
            const res = await apiFetch('/api/trade', {
                method: 'POST',
                body: {
                    question: currentAnalysis.question || '',
                    side: side,
                    action: action,
                    amount: amount,
                    token_id: currentAnalysis.token_id,
                    price: price || 0.5,
                    category: currentAnalysis.category || "General"
                }
            });

            if (res.ok) {
                showToast(`Executed ${action} trade for $${amount} on ${side}`, 'success');
                if (analysisModal) analysisModal.classList.add('hidden');
                fetchDashboardData();
            } else {
                const err = await safeJson(res);
                showToast(err.detail || 'Trade failed', 'error');
            }
        } catch (e) {
            showToast('Network error executing trade', 'error');
        }
    });

    // ── 13. Settings & Reset ───────────────────────────────────────
    const resetSimulatorBtn = document.getElementById('reset-simulator-btn');
    resetSimulatorBtn?.addEventListener('click', async () => {
        const ok = await showConfirm('Reset Simulator', 'Are you sure you want to completely reset the simulator? This will clear all balance, positions, and history.', 'danger');
        if (!ok) return;

        try {
            const res = await apiFetch('/api/reset', { method: 'POST' });
            if (!res.ok) throw new Error(await res.text());
            showToast('Simulator reset successfully.', 'success');

            navigateTo('dashboard');
            fetchDashboardData();
            fetchPositions();
            fetchHistory();

        } catch (e) {
            showToast('Failed to reset simulator: ' + e.message, 'error');
        }
    });

    async function fetchConfig() {
        try {
            const res = await apiFetch('/api/config');
            if (!res.ok) return;
            const data = await safeJson(res);
            if (data.config) {
                const readiness = data.live_readiness || {};
                const isLive = String(data.config.LIVE_TRADING).toLowerCase() === 'true' && readiness.ready === true;

                const modeSelect = document.getElementById('setting-trading-mode');
                if (modeSelect) {
                    modeSelect.value = isLive ? 'live' : 'paper';
                    const liveOption = Array.from(modeSelect.options).find(o => o.value === 'live');
                    if (liveOption) {
                        liveOption.disabled = readiness.ready !== true;
                        liveOption.textContent = readiness.ready === true ? 'Live' : 'Live (locked until CLOB credentials are configured)';
                    }
                }
                const minConf = document.getElementById('setting-min-confidence');
                if (minConf) minConf.value = data.config.MIN_CONFIDENCE || 70;

                const maxSpread = document.getElementById('setting-max-spread-limit');
                if (maxSpread) maxSpread.value = data.config.MAX_SPREAD_LIMIT !== undefined ? Math.round(data.config.MAX_SPREAD_LIMIT * 100) : 10;

                const minEdge = document.getElementById('setting-min-edge');
                if (minEdge) minEdge.value = data.config.MIN_EDGE !== undefined ? Math.round(data.config.MIN_EDGE * 100) : 5;

                const minLiq = document.getElementById('setting-min-liquidity');
                if (minLiq) minLiq.value = data.config.MIN_LIQUIDITY !== undefined ? data.config.MIN_LIQUIDITY : 50;

                const minDepth = document.getElementById('setting-min-depth');
                if (minDepth) minDepth.value = data.config.MIN_DEPTH !== undefined ? data.config.MIN_DEPTH : 500;

                const liberalMode = document.getElementById('setting-liberal-mode');
                if (liberalMode) liberalMode.value = String(data.config.LIBERAL_MODE).toLowerCase() === 'true' ? 'true' : 'false';

                const simulateProfit = document.getElementById('setting-simulate-profit');
                if (simulateProfit) simulateProfit.value = String(data.config.SIMULATE_PROFIT).toLowerCase() === 'true' ? 'true' : 'false';

                const modeDisplay = document.getElementById('trading-mode-display');
                if (modeDisplay) {
                    modeDisplay.textContent = isLive ? 'Live' : 'Paper';
                    modeDisplay.className = `trading-mode-value ${isLive ? 'live' : ''}`;
                }
            }
        } catch (e) {
            console.error('Failed to fetch config', e);
        }
    }

    document.getElementById('save-settings-btn')?.addEventListener('click', async () => {
        const mode = document.getElementById('setting-trading-mode')?.value;
        const minConf = document.getElementById('setting-min-confidence')?.value;
        const maxSpread = document.getElementById('setting-max-spread-limit')?.value;
        const minEdge = document.getElementById('setting-min-edge')?.value;
        const minLiq = document.getElementById('setting-min-liquidity')?.value;
        const minDepth = document.getElementById('setting-min-depth')?.value;
        const liberalMode = document.getElementById('setting-liberal-mode')?.value;
        const simulateProfit = document.getElementById('setting-simulate-profit')?.value;

        if (mode === 'live') {
            const ok = await showConfirm('Live Trading Locked', 'Live mode requires signed Polymarket CLOB execution credentials and backend approval. Save as paper mode instead?', 'danger');
            if (!ok) return;
        }

        try {
            const res = await apiFetch('/api/config', {
                method: 'POST',
                body: {
                    LIVE_TRADING: false,
                    MIN_CONFIDENCE: Number(minConf),
                    MAX_SPREAD_LIMIT: Number(maxSpread) / 100,
                    MIN_EDGE: Number(minEdge) / 100,
                    MIN_LIQUIDITY: Number(minLiq),
                    MIN_DEPTH: Number(minDepth),
                    LIBERAL_MODE: liberalMode === 'true',
                    SIMULATE_PROFIT: simulateProfit === 'true'
                }
            });
            if (res.ok) {
                showToast('Settings saved successfully.', 'success');
                fetchConfig();
            } else {
                const errText = await res.text();
                showToast('Failed to save settings: ' + errText, 'error');
            }
        } catch (e) {
            showToast('Error saving settings: ' + e.message, 'error');
        }
    });

    // ── 14. Data Fetching Functions ────────────────────────────────
    function renderBalanceChart(historyData, currentBalance) {
        const ctx = document.getElementById('balance-chart');
        if (!ctx) return;
        if (balanceChart) balanceChart.destroy();

        let labels = [];
        let data = [];

        if (historyData && historyData.length > 0) {
            const chartData = [...historyData].reverse();
            labels = chartData.map(t => formatTime(t.timestamp));
            data = chartData.map(t => t.balance_after);
        } else {
            labels = ['Start', 'Now'];
            data = [currentBalance, currentBalance];
        }

        const gridColor = document.documentElement.getAttribute('data-theme') === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
        const textColor = document.documentElement.getAttribute('data-theme') === 'dark' ? '#94a3b8' : '#6b7280';

        balanceChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Balance ($)',
                    data: data,
                    borderColor: '#6366f1',
                    backgroundColor: 'rgba(99, 102, 241, 0.1)',
                    borderWidth: 2,
                    fill: true,
                    tension: 0.2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { ticks: { color: textColor }, grid: { display: false } },
                    y: { ticks: { color: textColor }, grid: { color: gridColor } }
                }
            }
        });
    }

    function updateChartTheme() {
        const gridColor = document.documentElement.getAttribute('data-theme') === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
        const textColor = document.documentElement.getAttribute('data-theme') === 'dark' ? '#94a3b8' : '#6b7280';

        if (balanceChart) {
            balanceChart.options.scales.x.ticks.color = textColor;
            balanceChart.options.scales.y.ticks.color = textColor;
            balanceChart.options.scales.y.grid.color = gridColor;
            balanceChart.update();
        }

        if (analysisHistoryChart) {
            analysisHistoryChart.options.scales.x.ticks.color = textColor;
            analysisHistoryChart.options.scales.y.ticks.color = textColor;
            analysisHistoryChart.options.scales.y.grid.color = gridColor;
            if (analysisHistoryChart.options.scales.y.title) {
                analysisHistoryChart.options.scales.y.title.color = textColor;
            }
            if (analysisHistoryChart.options.scales.y1) {
                analysisHistoryChart.options.scales.y1.ticks.color = textColor;
                if (analysisHistoryChart.options.scales.y1.title) {
                    analysisHistoryChart.options.scales.y1.title.color = textColor;
                }
            }
            if (analysisHistoryChart.options.plugins.legend) {
                analysisHistoryChart.options.plugins.legend.labels.color = textColor;
            }
            analysisHistoryChart.update();
        }
    }

    async function fetchDashboardData() {
        try {
            const [balRes, posRes, histRes] = await Promise.all([
                apiFetch('/api/balance'),
                apiFetch('/api/positions'),
                apiFetch('/api/history')
            ]);

            if (!balRes.ok || !posRes.ok || !histRes.ok) return;

            const balData = await safeJson(balRes);
            const posData = await safeJson(posRes);
            const histData = await safeJson(histRes);

            const balanceNum = balData.balance || 0;
            const positions = posData.positions || [];
            const history = histData.history || [];

            const elHeaderBal = document.getElementById('header-balance');
            const elKpiBal = document.getElementById('kpi-balance');
            const elKpiPos = document.getElementById('kpi-positions');
            const elHeaderPos = document.getElementById('header-positions');
            const elKpiTrades = document.getElementById('kpi-trades');
            const elKpiWinrate = document.getElementById('kpi-winrate');

            if (elHeaderBal) elHeaderBal.textContent = formatUsd(balanceNum);
            if (elKpiBal) elKpiBal.textContent = formatUsd(balanceNum);
            if (elKpiPos) elKpiPos.textContent = positions.length;
            if (elHeaderPos) elHeaderPos.textContent = positions.length;
            if (elKpiTrades) elKpiTrades.textContent = history.length;

            const wins = history.filter(t => (t.pnl || 0) > 0).length;
            const closed = history.filter(t => t.side.startsWith('CLOSE')).length;
            if (elKpiWinrate) elKpiWinrate.textContent = closed > 0 ? Math.round((wins / closed) * 100) + '%' : '--';

            const tbody = document.getElementById('dashboard-history-body');
            if (tbody) {
                if (!history.length) {
                    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No trades yet. Start the engine to begin.</td></tr>';
                } else {
                    tbody.innerHTML = history.slice(0, 5).map(t => {
                        const displaySide = t.side === 'YES' || t.side === 'NO' ? `BUY ${t.side}` : t.side.replace('CLOSE', 'SELL');
                        return `
            <tr>
              <td>${formatTime(t.timestamp)}</td>
              <td class="truncate" style="max-width:200px;" title="${escapeHtml(t.question)}">${escapeHtml(t.question)}</td>
              <td><span class="badge badge-${t.side.includes('YES') ? 'green' : 'red'}">${escapeHtml(displaySide)}</span></td>
              <td style="text-align:right;">${formatUsd(t.amount)}</td>
              <td style="text-align:right;">$${t.price.toFixed(3)}</td>
              <td>${escapeHtml(t.status)}</td>
            </tr>
          `}).join('');
                }
            }

            renderMarketRecommendations(history);
            renderBalanceChart(history, balanceNum);
        } catch (e) { console.error('fetchDashboardData error:', e); }
    }

    let hasLiveAIRecommendations = false;

    function renderMarketRecommendations(history) {
        if (hasLiveAIRecommendations) return;
        const profList = document.getElementById('profitable-queries-list');
        const stableList = document.getElementById('stable-queries-list');
        if (!profList || !stableList) return;

        if (!history || history.length === 0) {
            profList.innerHTML = '<div class="empty-state" style="padding:16px;">No trade data available yet.</div>';
            stableList.innerHTML = '<div class="empty-state" style="padding:16px;">No trade data available yet.</div>';
            return;
        }

        const queryStats = {};
        history.forEach(t => {
            const q = t.question || 'Unknown';
            const c = t.category || 'Other';
            if (!queryStats[q]) {
                queryStats[q] = { pnl: 0, wins: 0, losses: 0, total: 0, category: c };
            }
            const pnl = t.pnl || 0;
            queryStats[q].pnl += pnl;
            if (t.side.startsWith('SELL') || t.side.startsWith('CLOSE')) {
                queryStats[q].total++;
                if (pnl > 0) queryStats[q].wins++;
                else queryStats[q].losses++;
            }
        });

        const queries = Object.keys(queryStats).map(q => ({ question: q, ...queryStats[q] }));
        const byCategory = {};
        queries.forEach(q => {
            if (!byCategory[q.category]) byCategory[q.category] = [];
            byCategory[q.category].push(q);
        });

        let profitableHtml = '';
        let stableHtml = '';

        for (const [cat, qs] of Object.entries(byCategory)) {
            const profitable = qs.filter(q => q.pnl > 0).sort((a, b) => b.pnl - a.pnl).slice(0, 3);
            if (profitable.length > 0) {
                profitableHtml += `<div style="margin-bottom: 12px;"><h5 style="font-size:11px; color:var(--text-primary); margin-bottom:6px;">${escapeHtml(cat)}</h5>`;
                profitableHtml += profitable.map(q => `
          <div style="display:flex; justify-content:space-between; align-items:center; background:var(--bg-input); padding:8px 12px; border-radius:6px; border:1px solid var(--border); margin-bottom:4px; cursor:pointer;" onclick="window.marketSearchAndSelect('${escapeHtml(q.question).replace(/'/g, "\\'")}')">
            <span class="truncate" style="max-width: 65%; font-size:11px; font-weight:600;" title="${escapeHtml(q.question)}">${escapeHtml(q.question)}</span>
            <span style="color:var(--green); font-family:var(--font-mono); font-size:11px; font-weight:700;">+${formatUsd(q.pnl)}</span>
          </div>
        `).join('');
                profitableHtml += `</div>`;
            }

            const stable = qs.filter(q => q.total >= 1).map(q => ({
                ...q, winRate: q.wins / q.total
            })).sort((a, b) => b.winRate - a.winRate || b.pnl - a.pnl).slice(0, 3);

            if (stable.length > 0) {
                stableHtml += `<div style="margin-bottom: 12px;"><h5 style="font-size:11px; color:var(--text-primary); margin-bottom:6px;">${escapeHtml(cat)}</h5>`;
                stableHtml += stable.map(q => `
          <div style="display:flex; justify-content:space-between; align-items:center; background:var(--bg-input); padding:8px 12px; border-radius:6px; border:1px solid var(--border); margin-bottom:4px; cursor:pointer;" onclick="window.marketSearchAndSelect('${escapeHtml(q.question).replace(/'/g, "\\'")}')">
            <span class="truncate" style="max-width: 65%; font-size:11px; font-weight:600;" title="${escapeHtml(q.question)}">${escapeHtml(q.question)}</span>
            <span style="color:var(--blue); font-family:var(--font-mono); font-size:11px; font-weight:700;">${Math.round(q.winRate * 100)}% Win Rate</span>
          </div>
        `).join('');
                stableHtml += `</div>`;
            }
        }

        if (!profitableHtml) profitableHtml = '<div class="empty-state" style="padding:16px; font-size:12px;">No profitable queries found yet.</div>';
        if (!stableHtml) stableHtml = '<div class="empty-state" style="padding:16px; font-size:12px;">No completed trades to analyze stability.</div>';

        profList.innerHTML = profitableHtml;
        stableList.innerHTML = stableHtml;
    }

    window.marketSearchAndSelect = (question) => {
        navigateTo('markets');
        switchMarketTab('discover');
        const searchInput = document.getElementById('market-search');
        if (searchInput) {
            searchInput.value = question;
            searchInput.dispatchEvent(new Event('input'));
        }
    };

    document.getElementById('generate-ai-recommendations-btn')?.addEventListener('click', async () => {
        const btn = document.getElementById('generate-ai-recommendations-btn');
        const status = document.getElementById('ai-recommendations-status');
        if (btn) btn.disabled = true;
        if (status) status.style.display = 'block';

        try {
            const res = await apiFetch('/api/ai_recommendations', {
                method: 'POST',
                body: { model: document.getElementById('model-select')?.value || 'gemini' }
            });
            if (res.ok) {
                const data = await safeJson(res);
                hasLiveAIRecommendations = true;
                renderLiveAIRecommendations(data.recommendations || { profitable: [], stable: [] });
            } else {
                showToast('Failed to generate AI recommendations', 'error');
            }
        } catch (e) {
            console.error(e);
            showToast('Error connecting to backend for recommendations', 'error');
        } finally {
            if (btn) btn.disabled = false;
            if (status) status.style.display = 'none';
        }
    });

    function renderLiveAIRecommendations(recs) {
        const profList = document.getElementById('profitable-queries-list');
        const stableList = document.getElementById('stable-queries-list');
        if (!profList || !stableList) return;

        // Group profitable by category
        const profByCategory = {};
        (recs.profitable || []).forEach(q => {
            const c = q.category || 'Other';
            if (!profByCategory[c]) profByCategory[c] = [];
            profByCategory[c].push(q);
        });

        let profitableHtml = '';
        for (const [cat, qs] of Object.entries(profByCategory)) {
            profitableHtml += `<div style="margin-bottom: 12px;"><h5 style="font-size:11px; color:var(--text-primary); margin-bottom:6px;">${escapeHtml(cat)}</h5>`;
            profitableHtml += qs.map(q => `
        <div style="background:var(--bg-input); padding:10px 12px; border-radius:6px; border:1px solid var(--border); margin-bottom:6px; cursor:pointer;" onclick="window.marketSearchAndSelect('${escapeHtml(q.question).replace(/'/g, "\\'")}')">
          <div style="display:flex; justify-content:space-between; margin-bottom: 4px;">
            <span class="truncate" style="max-width: 65%; font-size:12px; font-weight:600;" title="${escapeHtml(q.question)}">${escapeHtml(q.question)}</span>
            <span style="color:var(--green); font-family:var(--font-mono); font-size:11px; font-weight:700;">+${formatUsd(Number(q.pnl) || 0)} Est. PnL</span>
          </div>
          <div style="font-size:11px; color:var(--text-muted); line-height: 1.4;">${escapeHtml(q.reasoning || '')}</div>
        </div>
      `).join('');
            profitableHtml += `</div>`;
        }

        // Group stable by category
        const stableByCategory = {};
        (recs.stable || []).forEach(q => {
            const c = q.category || 'Other';
            if (!stableByCategory[c]) stableByCategory[c] = [];
            stableByCategory[c].push(q);
        });

        let stableHtml = '';
        for (const [cat, qs] of Object.entries(stableByCategory)) {
            stableHtml += `<div style="margin-bottom: 12px;"><h5 style="font-size:11px; color:var(--text-primary); margin-bottom:6px;">${escapeHtml(cat)}</h5>`;
            stableHtml += qs.map(q => `
        <div style="background:var(--bg-input); padding:10px 12px; border-radius:6px; border:1px solid var(--border); margin-bottom:6px; cursor:pointer;" onclick="window.marketSearchAndSelect('${escapeHtml(q.question).replace(/'/g, "\\'")}')">
          <div style="display:flex; justify-content:space-between; margin-bottom: 4px;">
            <span class="truncate" style="max-width: 65%; font-size:12px; font-weight:600;" title="${escapeHtml(q.question)}">${escapeHtml(q.question)}</span>
            <span style="color:var(--blue); font-family:var(--font-mono); font-size:11px; font-weight:700;">${Math.round((Number(q.winRate) || 0) * 100)}% Win Rate</span>
          </div>
          <div style="font-size:11px; color:var(--text-muted); line-height: 1.4;">${escapeHtml(q.reasoning || '')}</div>
        </div>
      `).join('');
            stableHtml += `</div>`;
        }

        if (!profitableHtml) profitableHtml = '<div class="empty-state" style="padding:16px; font-size:12px;">No profitable queries found.</div>';
        if (!stableHtml) stableHtml = '<div class="empty-state" style="padding:16px; font-size:12px;">No stable queries found.</div>';

        profList.innerHTML = profitableHtml;
        stableList.innerHTML = stableHtml;
    }

    async function fetchPositions() {
        try {
            // 1. Fetch balance
            const balRes = await apiFetch('/api/balance');
            if (balRes.ok) {
                const balData = await safeJson(balRes);
                portfolioData.balance = balData.balance || 0;
            }

            // 2. Fetch positions
            const res = await apiFetch('/api/portfolio');
            if (!res.ok) return;
            const data = await safeJson(res);
            portfolioData.positions = data.portfolio || [];

            // 3. Fetch history
            const histRes = await apiFetch('/api/history');
            if (histRes.ok) {
                const histData = await safeJson(histRes);
                portfolioData.history = histData.history || [];
            }

            // 4. Render Table
            const tbody = document.getElementById('positions-body');
            if (tbody) {
                if (!portfolioData.positions || !portfolioData.positions.length) {
                    tbody.innerHTML = '<tr><td colspan="11" class="empty-state">No positions found.</td></tr>';
                } else {
                    // Filter only active positions for table display (matching original dashboard view behavior)
                    const activePos = portfolioData.positions.filter(p =>
                        ['CREATED', 'ANALYZED', 'BUY_PLACED', 'BUY_FILLED', 'HOLDING', 'PARTIAL_SELL', 'STOPPED'].includes(p.status) &&
                        parseFloat(p.shares || p.size || 0) > 0
                    );

                    if (!activePos.length) {
                        tbody.innerHTML = '<tr><td colspan="11" class="empty-state">No active positions.</td></tr>';
                    } else {
                        tbody.innerHTML = activePos.map(p => {
                            const sideClass = p.side.toLowerCase() === 'yes' ? 'green' : 'red';
                            const isClosed = p.status === 'SOLD' || p.status === 'CLOSED';
                            const isStopped = p.status === 'STOPPED';
                            const pnl = p.pnl || 0;
                            const pnlClass = pnl >= 0 ? 'green' : 'red';
                            const pnlSign = pnl >= 0 ? '+' : '';
                            const roi = p.roi || 0;
                            const roiClass = roi >= 0 ? 'green' : 'red';
                            const roiSign = roi >= 0 ? '+' : '';

                            // Build action buttons
                            let actionsHtml = '';
                            if (isClosed) {
                                actionsHtml = `<button class="btn btn-secondary btn-sm archive-pos-btn" data-id="${p.market_id}">Archive</button>`;
                            } else {
                                const autoBtnText = p.auto_trading_enabled && !isStopped ? 'Stop Auto' : 'Resume Auto';
                                const autoBtnClass = p.auto_trading_enabled && !isStopped ? 'btn-red' : 'btn-primary';
                                actionsHtml = `
                  <div style="display: flex; gap: 4px; justify-content: center;">
                    <button class="btn ${autoBtnClass} btn-sm toggle-auto-btn" data-id="${p.market_id}" data-enabled="${p.auto_trading_enabled && !isStopped}">${autoBtnText}</button>
                    <button class="btn btn-secondary btn-sm manual-sell-btn" data-id="${p.market_id}" data-side="${p.side}" data-shares="${p.shares || p.size}" data-price="${p.current_price || p.entry_price}" data-question="${escapeHtml(p.question)}">Sell</button>
                  </div>
                `;
                            }

                            const autoTradingStatusIcon = p.auto_trading_enabled && !isClosed && !isStopped ? '▶' : '⏸';
                            const autoTradingStatusColor = p.auto_trading_enabled && !isClosed && !isStopped ? 'var(--green)' : 'var(--text-muted)';
                            const autoTradingText = p.auto_trading_enabled && !isClosed && !isStopped ? 'Active' : 'Stopped';

                            return `
                <tr>
                  <td class="truncate" style="max-width:250px; cursor:pointer; font-weight: 600; text-decoration: underline;" title="Click to view activity log" onclick="window.openPositionLogModal('${p.market_id}')">
                    ${escapeHtml(p.question)}
                  </td>
                  <td><span class="badge badge-${sideClass}">${escapeHtml(p.side)}</span></td>
                  <td><span class="badge badge-${p.status === 'HOLDING' ? 'green' : p.status === 'STOPPED' ? 'orange' : 'ghost'}">${escapeHtml(p.status)}</span></td>
                  <td>
                    <span style="color: ${autoTradingStatusColor}; font-size: 11px; margin-right: 4px;">${autoTradingStatusIcon}</span>
                    <span style="font-size: 12px; font-weight: 500;">${autoTradingText}</span>
                  </td>
                  <td style="text-align:right; font-family:var(--font-mono); font-size:12px;">${(p.shares || p.size || 0).toFixed(4)}</td>
                  <td style="text-align:right; font-family:var(--font-mono); font-size:12px;">$${(p.entry_price || 0).toFixed(4)}</td>
                  <td style="text-align:right; font-family:var(--font-mono); font-size:12px;">$${(p.current_price || 0).toFixed(4)}</td>
                  <td style="text-align:right; font-family:var(--font-mono); font-size:12px;" class="text-${pnlClass}">${pnlSign}${formatUsd(pnl)}</td>
                  <td style="text-align:right; font-family:var(--font-mono); font-size:12px;" class="text-${roiClass}">${roiSign}${roi.toFixed(2)}%</td>
                  <td><span class="badge badge-purple">${escapeHtml(p.category || 'Paper')}</span></td>
                  <td style="text-align:center;">${actionsHtml}</td>
                </tr>
              `;
                        }).join('');

                        // Bind event listeners for buttons
                        tbody.querySelectorAll('.archive-pos-btn').forEach(btn => {
                            btn.addEventListener('click', async (e) => {
                                e.stopPropagation();
                                const marketId = btn.dataset.id;
                                await archivePosition(marketId);
                            });
                        });

                        tbody.querySelectorAll('.toggle-auto-btn').forEach(btn => {
                            btn.addEventListener('click', async (e) => {
                                e.stopPropagation();
                                const marketId = btn.dataset.id;
                                const enabled = btn.dataset.enabled === 'true';
                                await toggleAutoTrading(marketId, enabled);
                            });
                        });

                        tbody.querySelectorAll('.manual-sell-btn').forEach(btn => {
                            btn.addEventListener('click', async (e) => {
                                e.stopPropagation();
                                const marketId = btn.dataset.id;
                                const side = btn.dataset.side;
                                const shares = parseFloat(btn.dataset.shares);
                                const price = parseFloat(btn.dataset.price);
                                const question = btn.dataset.question;
                                await triggerManualSell(marketId, side, shares, price, question);
                            });
                        });
                    }
                }
            }

            // 5. Render Dashboard Charts & KPIs
            renderPortfolioDashboard();
        } catch (e) {
            console.error('fetchPositions error:', e);
        }
    }

    function renderPortfolioDashboard() {
        const startInput = document.getElementById('portfolio-start-date');
        const endInput = document.getElementById('portfolio-end-date');
        const queryInput = document.getElementById('portfolio-query-filter');

        let startDate = startInput?.value ? new Date(startInput.value + 'T00:00:00') : null;
        let endDate = endInput?.value ? new Date(endInput.value + 'T23:59:59') : null;
        let queryFilter = queryInput?.value ? queryInput.value.toLowerCase() : '';

        // Filter Positions and History based on Date Range
        const closedPositionsInPeriod = [];
        const activePositionsInPeriod = [];
        const tradesInPeriod = [];

        // Helper to get close date
        function getCloseDate(pos) {
            if (pos.activity_log && pos.activity_log.length) {
                const sellEvent = pos.activity_log.find(e => ['SELL', 'MANUAL_SELL', 'STOP_LOSS', 'TAKE_PROFIT', 'EXPIRY_CLOSE'].includes(e.action));
                if (sellEvent) return new Date(sellEvent.timestamp);
            }
            return new Date(pos.updated_at || pos.timestamp || pos.created_at);
        }

        portfolioData.positions.forEach(pos => {
            const qMatch = !queryFilter || (pos.question || '').toLowerCase().includes(queryFilter) || (pos.category || '').toLowerCase().includes(queryFilter);
            if (!qMatch) return;

            const isClosed = pos.status === 'SOLD' || pos.status === 'CLOSED';
            const openDate = new Date(pos.created_at || pos.timestamp);

            if (isClosed) {
                const closeDate = getCloseDate(pos);
                if ((!startDate || closeDate >= startDate) && (!endDate || closeDate <= endDate)) {
                    closedPositionsInPeriod.push({ ...pos, closeDate });
                }
            } else {
                if ((!startDate || openDate >= startDate) && (!endDate || openDate <= endDate)) {
                    activePositionsInPeriod.push(pos);
                }
            }
        });

        portfolioData.history.forEach(t => {
            const qMatch = !queryFilter || (t.question || '').toLowerCase().includes(queryFilter) || (t.category || '').toLowerCase().includes(queryFilter);
            if (!qMatch) return;

            const tradeDate = new Date(t.timestamp);
            if ((!startDate || tradeDate >= startDate) && (!endDate || tradeDate <= endDate)) {
                tradesInPeriod.push(t);
            }
        });

        // ── 1. Calculate KPI Metrics ────────────────────────────────
        const activePositionsAll = portfolioData.positions.filter(pos => pos.status !== 'SOLD' && pos.status !== 'CLOSED' && pos.status !== 'ARCHIVED');

        // Total Investment (from filtered active positions)
        const totalInvestment = activePositionsInPeriod.reduce((sum, pos) => sum + (pos.invested_amount || pos.cost || (pos.shares * pos.entry_price) || pos.amount || 0), 0);

        // Total Profit & Loss
        let totalProfit = 0;
        let totalLoss = 0;
        closedPositionsInPeriod.forEach(pos => {
            const pnl = pos.realized_pnl || pos.pnl || 0;
            if (pnl > 0) totalProfit += pnl;
            else if (pnl < 0) totalLoss += pnl;
        });

        const periodTradesCount = tradesInPeriod.length;

        // ── 2. Render KPI UI ────────────────────────────────────────
        const invKpi = document.getElementById('port-investment-kpi');
        const profitKpi = document.getElementById('port-profit-kpi');
        const lossKpi = document.getElementById('port-loss-kpi');
        const tradesKpi = document.getElementById('port-trades-kpi');

        if (invKpi) invKpi.textContent = formatUsd(totalInvestment);
        if (profitKpi) profitKpi.textContent = '+' + formatUsd(totalProfit);
        if (lossKpi) lossKpi.textContent = '-' + formatUsd(Math.abs(totalLoss));
        if (tradesKpi) tradesKpi.textContent = periodTradesCount;

        // ── 3. Render PnL Progression Line Chart ────────────────────
        renderPnlProgressionChart(closedPositionsInPeriod);

        // ── 4. Render Sector Exposure Chart ─────────────────────────
        renderSectorExposureChart(activePositionsAll);
    }

    function renderPnlProgressionChart(closedPositions) {
        const canvas = document.getElementById('portfolio-pnl-chart');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        if (portfolioPnlChart) {
            portfolioPnlChart.destroy();
        }

        const sorted = [...closedPositions].sort((a, b) => a.closeDate - b.closeDate);

        let cumulativePnl = 0;
        const labels = ['Start'];
        const data = [0];

        sorted.forEach(pos => {
            cumulativePnl += (pos.realized_pnl || pos.pnl || 0);
            labels.push(pos.closeDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
            data.push(cumulativePnl);
        });

        const isProfit = cumulativePnl >= 0;
        const lineColor = isProfit ? '#10b981' : '#ef4444';
        const gradient = ctx.createLinearGradient(0, 0, 0, 200);
        gradient.addColorStop(0, isProfit ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)');
        gradient.addColorStop(1, isProfit ? 'rgba(16, 185, 129, 0.0)' : 'rgba(239, 68, 68, 0.0)');

        portfolioPnlChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Cumulative P&L ($)',
                    data: data,
                    borderColor: lineColor,
                    borderWidth: 2,
                    backgroundColor: gradient,
                    fill: true,
                    tension: 0.3,
                    pointRadius: sorted.length > 20 ? 0 : 3,
                    pointHoverRadius: 5,
                    pointBackgroundColor: lineColor
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        mode: 'index',
                        intersect: false,
                        callbacks: {
                            label: function (context) {
                                return 'PnL: ' + formatUsd(context.parsed.y);
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: { color: '#888', font: { size: 10 } }
                    },
                    y: {
                        grid: { color: 'rgba(128,128,128,0.1)' },
                        ticks: { color: '#888', font: { size: 10 } }
                    }
                }
            }
        });
    }

    function renderSectorExposureChart(activePositions) {
        const canvas = document.getElementById('portfolio-exposure-chart');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        if (portfolioExposureChart) {
            portfolioExposureChart.destroy();
        }

        const sectors = {};
        activePositions.forEach(pos => {
            const cat = pos.category || 'Other';
            const val = pos.current_value || pos.value || 0;
            sectors[cat] = (sectors[cat] || 0) + val;
        });

        const labels = Object.keys(sectors);
        const data = Object.values(sectors);

        if (labels.length === 0) {
            portfolioExposureChart = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    labels: ['No Active Holdings'],
                    datasets: [{
                        data: [1],
                        backgroundColor: ['rgba(128,128,128,0.15)'],
                        borderWidth: 0
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            position: 'bottom',
                            labels: { color: '#888', font: { size: 11 } }
                        },
                        tooltip: { enabled: false }
                    }
                }
            });
            return;
        }

        const colors = [
            '#6366f1', // Indigo
            '#10b981', // Emerald
            '#f59e0b', // Amber
            '#ec4899', // Pink
            '#3b82f6', // Blue
            '#8b5cf6', // Violet
            '#a855f7'  // Purple
        ];

        portfolioExposureChart = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: labels,
                datasets: [{
                    data: data,
                    backgroundColor: colors.slice(0, labels.length),
                    borderWidth: 1,
                    borderColor: 'rgba(255,255,255,0.05)'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: {
                            color: '#888',
                            font: { size: 10, weight: '600' },
                            boxWidth: 8,
                            padding: 8
                        }
                    },
                    tooltip: {
                        callbacks: {
                            label: function (context) {
                                const total = context.dataset.data.reduce((a, b) => a + b, 0);
                                const val = context.parsed;
                                const pct = ((val / total) * 100).toFixed(1);
                                return `${context.label}: ${formatUsd(val)} (${pct}%)`;
                            }
                        }
                    }
                },
                cutout: '65%'
            }
        });
    }

    function initPortfolioDashboardListeners() {
        const startInput = document.getElementById('portfolio-start-date');
        const endInput = document.getElementById('portfolio-end-date');
        const filterBtn = document.getElementById('portfolio-filter-btn');
        const btn7d = document.getElementById('portfolio-quick-7d');
        const btn30d = document.getElementById('portfolio-quick-30d');
        const btnAll = document.getElementById('portfolio-quick-all');

        if (startInput && endInput) {
            const today = new Date();
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(today.getDate() - 30);

            const formatDate = (d) => {
                const yyyy = d.getFullYear();
                const mm = String(d.getMonth() + 1).padStart(2, '0');
                const dd = String(d.getDate()).padStart(2, '0');
                return `${yyyy}-${mm}-${dd}`;
            };

            startInput.value = formatDate(thirtyDaysAgo);
            endInput.value = formatDate(today);
        }

        filterBtn?.addEventListener('click', () => {
            renderPortfolioDashboard();
        });

        btn7d?.addEventListener('click', () => {
            const today = new Date();
            const sevenDaysAgo = new Date();
            sevenDaysAgo.setDate(today.getDate() - 7);

            const formatDate = (d) => {
                const yyyy = d.getFullYear();
                const mm = String(d.getMonth() + 1).padStart(2, '0');
                const dd = String(d.getDate()).padStart(2, '0');
                return `${yyyy}-${mm}-${dd}`;
            };

            if (startInput) startInput.value = formatDate(sevenDaysAgo);
            if (endInput) endInput.value = formatDate(today);
            renderPortfolioDashboard();
        });

        btn30d?.addEventListener('click', () => {
            const today = new Date();
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(today.getDate() - 30);

            const formatDate = (d) => {
                const yyyy = d.getFullYear();
                const mm = String(d.getMonth() + 1).padStart(2, '0');
                const dd = String(d.getDate()).padStart(2, '0');
                return `${yyyy}-${mm}-${dd}`;
            };

            if (startInput) startInput.value = formatDate(thirtyDaysAgo);
            if (endInput) endInput.value = formatDate(today);
            renderPortfolioDashboard();
        });

        btnAll?.addEventListener('click', () => {
            if (startInput) startInput.value = '';
            if (endInput) endInput.value = '';
            renderPortfolioDashboard();
        });
    }

    async function archivePosition(marketId) {
        try {
            const res = await apiFetch(`/api/portfolio/${marketId}/archive`, { method: 'POST' });
            if (res.ok) {
                showToast('Position archived successfully', 'success');
                fetchPositions();
            } else {
                const data = await safeJson(res);
                showToast('Archive failed: ' + (data.detail || 'Unknown error'), 'error');
            }
        } catch (e) {
            showToast('Archive failed: ' + e.message, 'error');
        }
    }

    async function toggleAutoTrading(marketId, currentlyEnabled) {
        const path = currentlyEnabled ? 'stop-auto-trading' : 'resume-auto-trading';
        try {
            const res = await apiFetch(`/api/portfolio/${marketId}/${path}`, { method: 'POST' });
            if (res.ok) {
                showToast(`Auto-trading ${currentlyEnabled ? 'stopped' : 'resumed'} successfully`, 'success');
                fetchPositions();
            } else {
                const data = await safeJson(res);
                showToast('Action failed: ' + (data.detail || 'Unknown error'), 'error');
            }
        } catch (e) {
            showToast('Action failed: ' + e.message, 'error');
        }
    }

    const sellModal = document.getElementById('sell-position-modal');
    const sellModalAmount = document.getElementById('sell-modal-amount');
    const sellModalEstShares = document.getElementById('sell-modal-est-shares');
    const sellModalEstReceive = document.getElementById('sell-modal-est-receive');

    function updateSellModalEstimate() {
        if (!currentSellPosition || !sellModalAmount || !sellModalEstShares || !sellModalEstReceive) return;
        const amount = Number(sellModalAmount.value) || 0;
        const sharesHeld = currentSellPosition.shares;
        const price = currentSellPosition.price;

        let sharesToSell = amount / price;
        if (sharesToSell > sharesHeld) {
            sharesToSell = sharesHeld;
        }
        const receiveVal = sharesToSell * price;

        sellModalEstShares.textContent = sharesToSell.toFixed(4);
        sellModalEstReceive.textContent = '$' + receiveVal.toFixed(2);
    }

    sellModalAmount?.addEventListener('input', updateSellModalEstimate);

    document.getElementById('sell-modal-sell-all')?.addEventListener('click', () => {
        if (!currentSellPosition || !sellModalAmount) return;
        const maxVal = currentSellPosition.shares * currentSellPosition.price;
        sellModalAmount.value = maxVal.toFixed(2);
        updateSellModalEstimate();
    });

    const closeSellModal = () => {
        sellModal?.classList.add('hidden');
        currentSellPosition = null;
    };

    document.getElementById('close-sell-modal')?.addEventListener('click', closeSellModal);
    document.getElementById('cancel-sell-btn')?.addEventListener('click', closeSellModal);

    document.getElementById('execute-sell-btn')?.addEventListener('click', async () => {
        if (!currentSellPosition || !sellModalAmount) return;
        const amount = Number(sellModalAmount.value) || 0;
        const maxVal = currentSellPosition.shares * currentSellPosition.price;

        if (amount <= 0 || amount > maxVal + 0.01) {
            showToast('Invalid sell amount', 'error');
            return;
        }

        try {
            const res = await apiFetch(`/api/portfolio/${currentSellPosition.marketId}/manual-sell`, {
                method: 'POST',
                body: {
                    side: currentSellPosition.side,
                    amount: amount,
                    price: currentSellPosition.price,
                    question: currentSellPosition.question
                }
            });
            if (res.ok) {
                showToast('Manual sell executed successfully', 'success');
                closeSellModal();
                fetchPositions();
            } else {
                const data = await safeJson(res);
                showToast('Manual sell failed: ' + (data.detail || 'Unknown error'), 'error');
            }
        } catch (e) {
            showToast('Manual sell failed: ' + e.message, 'error');
        }
    });

    async function triggerManualSell(marketId, side, shares, price, question) {
        currentSellPosition = { marketId, side, shares, price, question };

        const maxVal = (shares * price).toFixed(2);
        const qEl = document.getElementById('sell-modal-question');
        if (qEl) qEl.textContent = question;

        const sideEl = document.getElementById('sell-modal-side');
        if (sideEl) {
            sideEl.textContent = side;
            sideEl.className = 'badge ' + (side.toLowerCase() === 'yes' ? 'badge-green' : 'badge-red');
        }

        const shEl = document.getElementById('sell-modal-shares');
        if (shEl) shEl.textContent = shares.toFixed(4);

        const prEl = document.getElementById('sell-modal-price');
        if (prEl) prEl.textContent = '$' + price.toFixed(4);

        const valEl = document.getElementById('sell-modal-value');
        if (valEl) valEl.textContent = '$' + maxVal;

        if (sellModalAmount) {
            sellModalAmount.value = maxVal;
        }

        updateSellModalEstimate();

        sellModal?.classList.remove('hidden');
    }

    window.openPositionLogModal = async function (marketId) {
        const modal = document.getElementById('position-log-modal');
        const tbody = document.getElementById('pos-log-body');
        if (!modal || !tbody) return;

        tbody.innerHTML = '<tr><td colspan="12" class="empty-state">Loading activity logs...</td></tr>';
        modal.classList.remove('hidden');

        try {
            const res = await apiFetch(`/api/portfolio/${marketId}/logs`);
            if (!res.ok) {
                tbody.innerHTML = '<tr><td colspan="12" class="empty-state text-red">Failed to load logs.</td></tr>';
                return;
            }
            const data = await safeJson(res);

            const elStatus = document.getElementById('pos-log-status');
            const elShares = document.getElementById('pos-log-shares');
            const elPnl = document.getElementById('pos-log-pnl');
            const elAuto = document.getElementById('pos-log-autotrade');
            const elTitle = document.getElementById('pos-log-title');

            if (elTitle) elTitle.textContent = `Activity Log: ${data.question}`;
            if (elStatus) elStatus.textContent = data.status || '--';
            if (elShares) elShares.textContent = (data.shares || 0).toFixed(4);
            if (elPnl) {
                const pnl = data.unrealized_pnl || 0;
                const roi = data.roi || 0;
                elPnl.textContent = `${pnl >= 0 ? '+' : ''}${formatUsd(pnl)} (${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%)`;
                elPnl.className = `modal-kpi-value text-${pnl >= 0 ? 'green' : 'red'}`;
            }
            if (elAuto) {
                elAuto.textContent = data.auto_trading_enabled ? 'Enabled' : 'Disabled';
                elAuto.style.color = data.auto_trading_enabled ? 'var(--green)' : 'var(--text-muted)';
            }

            const logs = data.logs || [];
            if (!logs.length) {
                tbody.innerHTML = '<tr><td colspan="12" class="empty-state">No events recorded.</td></tr>';
            } else {
                tbody.innerHTML = logs.map(l => {
                    const d = l.details || {};
                    const amt = d.amount !== undefined && d.amount !== null ? formatUsd(d.amount) : '--';
                    const sh = d.shares !== undefined && d.shares !== null ? Number(d.shares).toFixed(4) : '--';
                    const entry = d.entry_price !== undefined && d.entry_price !== null ? `$${Number(d.entry_price).toFixed(4)}` : '--';
                    const exitCurrentValue = d.exit_price ?? d.current_price ?? d.price;
                    const exitCurrent = exitCurrentValue !== undefined && exitCurrentValue !== null ? `$${Number(exitCurrentValue).toFixed(4)}` : '--';

                    let pnlText = '--';
                    const pnlVal = d.pnl ?? d.profit_loss;
                    if (pnlVal !== undefined && pnlVal !== null) {
                        const pnlNum = Number(pnlVal);
                        const roiNum = Number(d.roi ?? 0);
                        const pnlSign = pnlNum >= 0 ? '+' : '';
                        pnlText = `${pnlSign}${formatUsd(pnlNum)} (${roiNum >= 0 ? '+' : ''}${roiNum.toFixed(2)}%)`;
                    }

                    const confText = d.confidence !== undefined && d.confidence !== null ? `${d.confidence}%` : '--';
                    const edgeText = d.edge !== undefined && d.edge !== null ? `${(Number(d.edge) * 100).toFixed(2)}%` : '--';
                    const riskText = d.risk_status || d.risk || '--';

                    return `
            <tr>
              <td style="white-space:nowrap; font-size:11px;">${formatTime(l.timestamp)}</td>
              <td><span class="badge badge-secondary">${escapeHtml(l.action)}</span></td>
              <td><span class="badge badge-ghost">${escapeHtml(l.source || 'BOT')}</span></td>
              <td style="text-align:right; font-family:var(--font-mono);">${amt}</td>
              <td style="text-align:right; font-family:var(--font-mono);">${sh}</td>
              <td style="text-align:right; font-family:var(--font-mono);">${entry}</td>
              <td style="text-align:right; font-family:var(--font-mono);">${exitCurrent}</td>
              <td style="text-align:right; font-family:var(--font-mono);">${pnlText}</td>
              <td>${confText}</td>
              <td>${edgeText}</td>
              <td><span class="badge badge-ghost">${escapeHtml(riskText)}</span></td>
              <td style="font-size:11px; max-width:260px; overflow:hidden; text-overflow:ellipsis;" title="${escapeHtml(d.reason || '')}">${escapeHtml(d.reason || '')}</td>
            </tr>
          `;
                }).join('');
            }
        } catch (e) {
            console.error('Error opening position logs:', e);
            tbody.innerHTML = '<tr><td colspan="12" class="empty-state text-red">Error loading logs.</td></tr>';
        }
    }

    document.getElementById('close-pos-log-modal')?.addEventListener('click', () => {
        document.getElementById('position-log-modal')?.classList.add('hidden');
    });

    document.getElementById('portfolio-query-filter')?.addEventListener('input', () => {
        // Debounce filtering slightly or apply on 'Enter' (here we do apply filter explicitly for UX)
    });

    document.getElementById('system-logs-btn')?.addEventListener('click', () => {
        ensureOperationLogPanel();
        const panel = document.getElementById('operation-log-panel');
        if (panel) {
            panel.classList.remove('collapsed');
        }
    });

    document.getElementById('refresh-positions-btn')?.addEventListener('click', fetchPositions);

    function openInvoiceModal(trade) {
        const invoiceModal = document.getElementById('invoice-modal');
        const content = document.getElementById('invoice-content');
        if (!invoiceModal || !content) return;

        content.innerHTML = `
        <div class="invoice-row"><span class="invoice-lbl">Market</span><span class="invoice-val" style="text-align:right; max-width:60%;">${escapeHtml(trade.question)}</span></div>
        <div class="invoice-row"><span class="invoice-lbl">Side</span><span class="invoice-val">${escapeHtml(trade.side)}</span></div>
        <div class="invoice-row"><span class="invoice-lbl">Status</span><span class="invoice-val">${escapeHtml(trade.status)}</span></div>
        <div class="invoice-row"><span class="invoice-lbl">Amount</span><span class="invoice-val">${formatUsd(trade.amount)}</span></div>
        <div class="invoice-row"><span class="invoice-lbl">Shares</span><span class="invoice-val">${trade.shares.toFixed(4)}</span></div>
        <div class="invoice-row"><span class="invoice-lbl">Price</span><span class="invoice-val">$${trade.price.toFixed(4)}</span></div>
        <div class="invoice-row"><span class="invoice-lbl">Confidence</span><span class="invoice-val">${trade.confidence}%</span></div>
        ${trade.pnl !== undefined ? `<div class="invoice-row"><span class="invoice-lbl">P&L</span><span class="invoice-val ${trade.pnl >= 0 ? 'text-green' : 'text-red'}">${trade.pnl >= 0 ? '+' : ''}${formatUsd(trade.pnl)}</span></div>` : ''}
        <div class="invoice-row"><span class="invoice-lbl">Reasoning</span><span class="invoice-val" style="text-align:right; max-width:60%; font-size: 11px;">${escapeHtml(trade.reasoning || '--')}</span></div>
        <div class="invoice-row"><span class="invoice-lbl">Time</span><span class="invoice-val">${formatTime(trade.timestamp)}</span></div>
    `;
        invoiceModal.classList.remove('hidden');
    }

    document.getElementById('close-invoice-modal')?.addEventListener('click', () => {
        document.getElementById('invoice-modal')?.classList.add('hidden');
    });

    async function fetchHistory() {
        try {
            const res = await apiFetch('/api/history');
            if (!res.ok) return;
            const data = await safeJson(res);
            const tbody = document.getElementById('history-body');
            if (tbody) {
                if (!data.history || !data.history.length) {
                    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No trade history.</td></tr>';
                } else {
                    tbody.innerHTML = data.history.map((t, i) => {
                        const displaySide = t.side === 'YES' || t.side === 'NO' ? `BUY ${t.side}` : t.side.replace('CLOSE', 'SELL');
                        const rationale = t.reasoning || t.summary || 'No rationale recorded.';
                        const aiProb = t.ai_probability !== undefined ? t.ai_probability : '--';
                        const edge = t.edge !== undefined ? t.edge : '--';
                        return `
            <tr>
              <td>${formatTime(t.timestamp)}</td>
              <td class="truncate" style="max-width:250px;" title="${escapeHtml(t.question)}">${escapeHtml(t.question)}</td>
              <td><span class="badge badge-${t.side.includes('YES') ? 'green' : 'red'}">${escapeHtml(displaySide)}</span></td>
              <td style="text-align:right;">${formatUsd(t.amount)}</td>
              <td style="text-align:right;">$${t.price.toFixed(3)}</td>
              <td>${t.confidence || '--'}%</td>
              <td>${escapeHtml(t.status)}</td>
              <td style="text-align:center;">
                <button class="btn btn-ghost btn-sm view-invoice-btn" data-idx="${i}">Invoice</button>
                <button class="btn btn-secondary btn-sm toggle-audit-btn" onclick="this.closest('tr').nextElementSibling.classList.toggle('hidden')">Audit</button>
              </td>
            </tr>
            <tr class="hidden">
              <td colspan="8" style="padding:16px; background:var(--bg-input); border-bottom:1px solid var(--border);">
                <div style="font-size:12px; line-height:1.6; color:var(--text-secondary);">
                  <strong style="color:var(--text-primary);">Gemini Analysis Summary:</strong><br/>
                  ${escapeHtml(rationale)}<br/><br/>
                  <div style="display:flex; gap:16px;">
                    <div><strong>AI Probability:</strong> ${aiProb}%</div>
                    <div><strong>Edge:</strong> ${edge}%</div>
                  </div>
                  <div style="margin-top:8px; font-family:var(--font-mono); font-size:11px; color:var(--text-muted);">
                    <strong>Workflow:</strong> Scanned Market &rarr; Analysed via AI Model &rarr; Evaluated Edge & Confidence &rarr; Executed via CLOB API
                  </div>
                </div>
              </td>
            </tr>
          `}).join('');

                    tbody.querySelectorAll('.view-invoice-btn').forEach(btn => {
                        btn.addEventListener('click', () => {
                            const idx = parseInt(btn.dataset.idx, 10);
                            openInvoiceModal(data.history[idx]);
                        });
                    });
                }
            }
        } catch (e) { console.error('fetchHistory error:', e); }
    }

    async function updateTicker() {
        const track = document.getElementById('ticker-track');
        if (!track) return;
        try {
            const res = await apiFetch('/api/ticker');
            if (!res.ok) return;
            const data = await safeJson(res);

            if (data.prices) {
                const ticks = Object.entries(data.prices).map(([symbol, info]) => {
                    const isUp = info.change >= 0;
                    const colorClass = isUp ? 'text-green' : 'text-red';
                    const sign = isUp ? '+' : '';
                    return `<span class="tick"><strong style="color:var(--text-primary);">${symbol}</strong> $${info.price.toFixed(2)} <span class="${colorClass}">${sign}${info.change}%</span></span>`;
                }).join('<span style="color:var(--border); margin:0 10px;">|</span>');
                track.innerHTML = ticks;
            }
        } catch (e) {
            console.error('Ticker fetch error:', e);
        }
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const modals = [
                'terms-modal',
                'analysis-modal',
                'market-detail-modal',
                'invoice-modal',
                'position-log-modal',
                'sector-modal',
                'sell-position-modal'
            ];
            modals.forEach(id => {
                const el = document.getElementById(id);
                if (el) el.classList.add('hidden');
            });
            if (typeof closeConfirm === 'function') closeConfirm(false);
            if (typeof closeSectorModal === 'function') closeSectorModal();
            if (typeof closeSellModal === 'function') closeSellModal();
        }
    });

    // ── Initialization ─────────────────────────────────────────────
    function initApp() {
        const token = sessionStorage.getItem('polybot-token');
        if (token && token.includes(':')) {
            const username = token.split(':')[0];
            const userDisplay = document.getElementById('sidebar-username-display');
            if (userDisplay) {
                userDisplay.textContent = `User: ${username}`;
            }
        }

        fetchDashboardData();
        loadSectors();
        fetchConfig();
        fetchStatus();
        fetchOperationLogs();
        initPortfolioDashboardListeners();

        if (typeof updateTicker === 'function') {
            updateTicker();
            setInterval(updateTicker, 30000);
        }
    }

    if (sessionStorage.getItem('polybot-token')) {
        showApp();
    } else {
        showLogin();
    }

});