/* ══════════════════════════════════════════════════════════════
   PolyBot — Application Logic
   Polymarket-Style AI Trading Terminal
   ══════════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {
    'use strict';

    // ── Global State Variables ───────────────────────────────────
    let balanceChart = null;
    let analysisHistoryChart = null;
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

    // Holds the real live order book data for the active modal
    let liveOrderBooks = { yes: [], no: [] };

    // ── 1. Utilities ─────────────────────────────────────────────
    function escapeHtml(str) {
        if (!str) return '';
        const d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    }

    async function apiFetch(url, opts = {}) {
        const token = sessionStorage.getItem('polybot-token');
        const headers = { ...(opts.headers || {}) };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
            headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(opts.body);
        }
        const res = await fetch(url, { ...opts, headers });
        if (res.status === 401) {
            sessionStorage.removeItem('polybot-token');
            showLogin();
            throw new Error('Unauthorized');
        }
        return res;
    }

    async function safeJson(res) {
        try { return await res.json(); } catch { return {}; }
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

    // ── 5. Auth / Login ──────────────────────────────────────────
    const loginOverlay = document.getElementById('login-overlay');
    const appContainer = document.getElementById('app-container');
    const loginBtn = document.getElementById('login-btn');
    const loginPassword = document.getElementById('login-password');
    const loginError = document.getElementById('login-error');
    const logoutBtn = document.getElementById('logout-btn');
    const termsModal = document.getElementById('terms-modal');
    const termsCheckbox = document.getElementById('terms-checkbox');
    const viewTermsLink = document.getElementById('view-terms-link');

    if (loginBtn) loginBtn.disabled = true;

    termsCheckbox?.addEventListener('change', (e) => {
        if (loginBtn) loginBtn.disabled = !e.target.checked;
    });

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
        const pw = loginPassword?.value || '';
        if (loginError) loginError.textContent = '';

        if (!termsCheckbox?.checked) {
            if (loginError) loginError.textContent = 'You must accept the terms to continue.';
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
                body: JSON.stringify({ password: pw })
            });

            if (!res.ok) {
                const data = await safeJson(res);
                throw new Error(data.detail || 'Invalid password');
            }

            const data = await safeJson(res);
            sessionStorage.setItem('polybot-token', data.token || 'noauth');
            localStorage.setItem('polybot-terms-accepted', 'true');
            showApp();

        } catch (e) {
            if (loginError) loginError.textContent = e.message;
            if (loginBtn) loginBtn.disabled = false;
        } finally {
            if (loginBtn) loginBtn.textContent = 'Authenticate';
        }
    }

    loginBtn?.addEventListener('click', doLogin);
    loginPassword?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && termsCheckbox?.checked) doLogin(); });

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
    const tabAnalysis = document.getElementById('tab-analysis');
    const contentDiscover = document.getElementById('tab-content-discover');
    const contentAnalysis = document.getElementById('tab-content-analysis');

    function switchMarketTab(tab) {
        if (tab === 'discover') {
            tabDiscover?.classList.add('active');
            tabAnalysis?.classList.remove('active');
            contentDiscover?.classList.remove('hidden');
            contentAnalysis?.classList.add('hidden');
        } else {
            tabAnalysis?.classList.add('active');
            tabDiscover?.classList.remove('active');
            contentAnalysis?.classList.remove('hidden');
            contentDiscover?.classList.add('hidden');
        }
    }

    tabDiscover?.addEventListener('click', () => switchMarketTab('discover'));
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
                if (isBotActive && data.config?.selected_queries) {
                    data.config.selected_queries.forEach(q => selectedQueries.add(q));
                }
                updateBotUI();
            }
        } catch (e) {
            console.error('Failed to fetch status', e);
        }
    }

    function updateBotUI() {
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
        }
    }

    toggleBotBtn?.addEventListener('click', async () => {
        if (!isBotActive) {
            if (selectedQueries.size === 0) {
                showToast("Select at least one market in the Discover tab to start the continuous engine.", "info");
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
        if (e.target.checked) {
            fetchedQueries.forEach(q => selectedQueries.add(q.id));
        } else {
            selectedQueries.clear();
        }
        renderMarketCards();
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

        selectedQueries.clear();
        if (selectAllCb) selectAllCb.checked = false;
        fetchedQueries = [];
        updateAnalyzeBtn();

        try {
            const subsStr = Array.from(selectedSubsectors).join(',');
            const res = await apiFetch(`/api/queries?sector=${encodeURIComponent(selectedSector || 'all')}&subsector=${encodeURIComponent(subsStr)}`);
            if (!res.ok) throw new Error(await res.text());
            const data = await safeJson(res);
            fetchedQueries = data.queries || [];
            renderMarketCards();
        } catch (e) {
            console.error('Query fetch error:', e);
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
            selectAllCb.checked = filtered.every(q => selectedQueries.has(q.id));
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

            const isChecked = selectedQueries.has(q.id);

            return `
        <div class="market-card" data-id="${q.id}">
          <div class="market-card-top">
            <input type="checkbox" class="checkbox-custom market-cb" data-id="${q.id}" ${isChecked ? 'checked' : ''} />
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
            cb.addEventListener('click', (e) => e.stopPropagation());
            cb.addEventListener('change', () => {
                if (cb.checked) selectedQueries.add(cb.dataset.id);
                else selectedQueries.delete(cb.dataset.id);
                renderMarketCards();
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
                if (e.target.closest('.market-cb') || e.target.closest('.analyze-single-btn')) return;
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
        if (!queryIdsArray || queryIdsArray.length === 0) return;

        const model = document.getElementById('model-select')?.value || 'gemini';
        const analysisGrid = document.getElementById('analysis-grid');

        switchMarketTab('analysis');
        if (analysisGrid) {
            analysisGrid.innerHTML = `
            <div class="empty-state" style="grid-column:1/-1;">
                <div class="loading-skeleton" style="width:60px;height:60px;border-radius:50%;margin:0 auto 16px; background:var(--accent);"></div>
                <h3 style="color:var(--text-primary); margin-bottom:8px;">AI is analyzing ${queryIdsArray.length} market(s)</h3>
                <p style="color:var(--text-secondary); font-size:13px;">Using ${model === 'gemini' ? 'Gemini' : 'Parallel'} model. Parsing order books and historical contexts...</p>
            </div>`;
        }

        try {
            const res = await apiFetch('/api/analyze-selected', {
                method: 'POST',
                body: { query_ids: queryIdsArray, model: model }
            });
            if (!res.ok) throw new Error(await res.text());

            showToast('Analysis complete!', 'success');
            await fetchAnalyses();
            fetchDashboardData();
        } catch (e) {
            showToast('Analysis failed', 'error');
            fetchAnalyses();
        }
    }

    analyzeSelectedBtn?.addEventListener('click', () => {
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

        bidsEl.innerHTML = '<div class="text-muted" style="font-size:11px;">Loading live book...</div>';
        asksEl.innerHTML = '<div class="text-muted" style="font-size:11px;">Loading live book...</div>';
        liveOrderBooks = { yes: [], no: [] };

        try {
            // 1. Fetch the full market data to get the distinct CLOB Token IDs for YES and NO
            const res = await fetch(`https://gamma-api.polymarket.com/markets/${market.id}`);
            if (!res.ok) throw new Error("Failed to fetch market details");
            const gammaData = await res.json();

            const clobTokenIds = gammaData.clobTokenIds || [];
            if (clobTokenIds.length < 2) throw new Error("Missing clobTokenIds");

            // 2. Fetch the live YES and NO order books in parallel
            const [yesRes, noRes] = await Promise.all([
                fetch(`https://clob.polymarket.com/book?token_id=${clobTokenIds[0]}`),
                fetch(`https://clob.polymarket.com/book?token_id=${clobTokenIds[1]}`)
            ]);

            const yesBook = await yesRes.json();
            const noBook = await noRes.json();

            // 3. Store sorted asks (ascending price) for the calculator to sweep
            liveOrderBooks.yes = (yesBook.asks || []).map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) })).sort((a, b) => a.price - b.price);
            liveOrderBooks.no = (noBook.asks || []).map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) })).sort((a, b) => a.price - b.price);

            // 4. Display the live YES book in the UI
            let bidsHtml = '', asksHtml = '';
            const displayBids = yesBook.bids || [];
            for (let i = 0; i < Math.min(4, displayBids.length); i++) {
                bidsHtml += `<div style="display:flex; justify-content:space-between;"><span class="text-secondary">${Math.round(parseFloat(displayBids[i].size))}</span><span class="text-green">${parseFloat(displayBids[i].price).toFixed(3)}</span></div>`;
            }

            const displayAsks = yesBook.asks || [];
            for (let i = 0; i < Math.min(4, displayAsks.length); i++) {
                asksHtml += `<div style="display:flex; justify-content:space-between;"><span class="text-red">${parseFloat(displayAsks[i].price).toFixed(3)}</span><span class="text-secondary">${Math.round(parseFloat(displayAsks[i].size))}</span></div>`;
            }

            bidsEl.innerHTML = bidsHtml || '<div class="text-muted">No bids</div>';
            asksEl.innerHTML = asksHtml || '<div class="text-muted">No asks</div>';

            // 5. Trigger the calculator to update with the new live data
            updateCalculator();

        } catch (e) {
            console.error("Failed to load real order book:", e);
            bidsEl.innerHTML = '<div class="text-red" style="font-size:11px;">Failed to load</div>';
            asksEl.innerHTML = '<div class="text-red" style="font-size:11px;">Failed to load</div>';
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

        // Load actual live data instead of mock
        loadLiveOrderBook(q);

        if (calcAmount) calcAmount.value = 100;
        updateCalculator();

        const modal = document.getElementById('market-detail-modal');
        if (modal) modal.classList.remove('hidden');
    }

    document.getElementById('close-market-detail')?.addEventListener('click', () => {
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

        analysisGrid.innerHTML = filtered.map(a => {
            const rec = a.recommended_side?.toUpperCase() || 'HOLD';
            const recClass = `rec-${rec.toLowerCase()}`;
            return `
        <div class="analysis-card ${recClass}" data-id="${a.token_id}">
          <div class="analysis-card-top">
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
        }).join('');

        analysisGrid.querySelectorAll('.view-analysis-btn, .analysis-card').forEach(el => {
            el.addEventListener('click', (e) => {
                const id = el.dataset.id || el.closest('.analysis-card').dataset.id;
                openAnalysisModal(id);
            });
        });
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
                body: JSON.stringify({
                    question: currentAnalysis.question || '',
                    side: side,
                    action: action,
                    amount: amount,
                    token_id: currentAnalysis.token_id,
                    price: price || 0.5,
                    category: currentAnalysis.category || "General"
                })
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
                const isLive = String(data.config.LIVE_TRADING).toLowerCase() === 'true';

                const modeSelect = document.getElementById('setting-trading-mode');
                if (modeSelect) modeSelect.value = isLive ? 'live' : 'paper';
                const minConf = document.getElementById('setting-min-confidence');
                if (minConf) minConf.value = data.config.MIN_CONFIDENCE || 70;

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

        try {
            const res = await apiFetch('/api/config', {
                method: 'POST',
                body: {
                    LIVE_TRADING: mode === 'live',
                    MIN_CONFIDENCE: Number(minConf)
                }
            });
            if (res.ok) {
                showToast('Settings saved successfully.', 'success');
                fetchConfig();
            } else {
                showToast('Failed to save settings.', 'error');
            }
        } catch (e) {
            showToast('Error saving settings.', 'error');
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
                    tbody.innerHTML = history.slice(0, 5).map(t => `
            <tr>
              <td>${formatTime(t.timestamp)}</td>
              <td class="truncate" style="max-width:200px;" title="${escapeHtml(t.question)}">${escapeHtml(t.question)}</td>
              <td><span class="badge badge-${t.side.includes('YES') ? 'green' : 'red'}">${escapeHtml(t.side)}</span></td>
              <td style="text-align:right;">${formatUsd(t.amount)}</td>
              <td style="text-align:right;">$${t.price.toFixed(3)}</td>
              <td>${escapeHtml(t.status)}</td>
            </tr>
          `).join('');
                }
            }

            renderBalanceChart(history, balanceNum);
        } catch (e) { console.error('fetchDashboardData error:', e); }
    }

    async function fetchPositions() {
        try {
            const res = await apiFetch('/api/positions');
            if (!res.ok) return;
            const data = await safeJson(res);
            const tbody = document.getElementById('positions-body');
            if (tbody) {
                if (!data.positions || !data.positions.length) {
                    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No active positions.</td></tr>';
                } else {
                    tbody.innerHTML = data.positions.map(p => `
            <tr>
              <td class="truncate" style="max-width:250px;" title="${escapeHtml(p.asset)}">${escapeHtml(p.asset)}</td>
              <td><span class="badge badge-${p.side.toLowerCase() === 'yes' ? 'green' : 'red'}">${escapeHtml(p.side)}</span></td>
              <td style="text-align:right;">${p.size.toFixed(2)}</td>
              <td style="text-align:right;">$${p.entry_price.toFixed(3)}</td>
              <td style="text-align:right;">$${(p.current_price || p.entry_price).toFixed(3)}</td>
              <td style="text-align:right;" class="text-${p.pnl >= 0 ? 'green' : 'red'}">${p.pnl >= 0 ? '+' : ''}${formatUsd(p.pnl || 0)}</td>
            </tr>
          `).join('');
                }
            }
        } catch (e) { console.error('fetchPositions error:', e); }
    }

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
                    tbody.innerHTML = data.history.map((t, i) => `
            <tr>
              <td>${formatTime(t.timestamp)}</td>
              <td class="truncate" style="max-width:250px;" title="${escapeHtml(t.question)}">${escapeHtml(t.question)}</td>
              <td><span class="badge badge-${t.side.includes('YES') ? 'green' : 'red'}">${escapeHtml(t.side)}</span></td>
              <td style="text-align:right;">${formatUsd(t.amount)}</td>
              <td style="text-align:right;">$${t.price.toFixed(3)}</td>
              <td>${t.confidence}%</td>
              <td>${escapeHtml(t.status)}</td>
              <td style="text-align:center;"><button class="btn btn-ghost btn-sm view-invoice-btn" data-idx="${i}">View</button></td>
            </tr>
          `).join('');

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

    // ── Initialization ─────────────────────────────────────────────
    function initApp() {
        fetchDashboardData();
        loadSectors();
        fetchConfig();
        fetchStatus();

        if (typeof updateTicker === 'function') {
            updateTicker();
            setInterval(updateTicker, 30000);
        }
    }

    if (sessionStorage.getItem('polybot-token') || localStorage.getItem('polybot-terms-accepted')) {
        showApp();
    } else {
        showLogin();
    }

});