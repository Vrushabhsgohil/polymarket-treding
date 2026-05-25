document.addEventListener('DOMContentLoaded', () => {

    // ── Authentication ───────────────────────────────────────────────────────────
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
        let [resource, config] = args;
        const token = localStorage.getItem('poly_auth_token');

        if (token && resource.startsWith('/api/')) {
            config = config || {};
            config.headers = config.headers || {};
            config.headers['Authorization'] = `Bearer ${token}`;
        }

        const response = await originalFetch(resource, config);
        if (response.status === 401 && resource !== '/api/login') {
            document.getElementById('login-overlay').classList.remove('hidden');
            localStorage.removeItem('poly_auth_token');
        }
        return response;
    };

    document.getElementById('login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const pw = document.getElementById('login-password').value;
        try {
            const res = await originalFetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: pw })
            });
            if (res.ok) {
                const data = await res.json();
                if (data.token !== 'noauth') {
                    localStorage.setItem('poly_auth_token', data.token);
                }
                document.getElementById('login-overlay').classList.add('hidden');
                document.getElementById('login-password').value = '';
                fetchDashboardData();
                fetchAnalyses();
            } else {
                alert('Invalid password');
            }
        } catch (err) {
            alert('Login error');
        }
    });

    const token = localStorage.getItem('poly_auth_token');
    if (token) {
        document.getElementById('login-overlay').classList.add('hidden');
    } else {
        // We check /api/login with an empty password to see if auth is disabled.
        originalFetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: '' })
        }).then(r => r.json()).then(data => {
            if (data.token === 'noauth') {
                document.getElementById('login-overlay').classList.add('hidden');
                fetchDashboardData();
                fetchAnalyses();
            }
        }).catch(e => console.error(e));
    }

    // ── Market Clock ───────────────────────────────────────────────────────────
    function updateMarketClock() {
        const el = document.getElementById('market-clock');
        if (!el) return;
        el.textContent = new Date().toLocaleTimeString([], { hour12: false });
    }
    updateMarketClock();
    setInterval(updateMarketClock, 1000);

    // ── Navigation ─────────────────────────────────────────────────────────────
    const navItems = document.querySelectorAll('.nav-item');
    const sections = document.querySelectorAll('.page-section');
    const pageTitle = document.getElementById('page-title');

    navItems.forEach(item => {
        item.addEventListener('click', e => {
            e.preventDefault();
            const targetId = item.getAttribute('data-target');

            navItems.forEach(n => n.classList.remove('active'));
            item.classList.add('active');

            const label = item.querySelector('span')?.textContent.trim() || item.textContent.trim();
            pageTitle.textContent = label;

            sections.forEach(section => {
                const match = section.id === `section-${targetId}`;
                section.classList.toggle('active', match);
                section.classList.toggle('hidden', !match);
            });

            if (targetId === 'dashboard') fetchDashboardData();
            if (targetId === 'history') fetchHistory();
            if (targetId === 'positions') fetchPositions();
            if (targetId === 'analytics') fetchAnalyses();
        });
    });

    // ── Bot Control ────────────────────────────────────────────────────────────
    const toggleBotBtn = document.getElementById('toggle-bot-btn');
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    let isBotActive = false;

    async function fetchBotStatus() {
        try {
            const data = await fetch('/api/status').then(r => r.json());
            isBotActive = data.active;
            updateBotUI();
        } catch (e) { console.error('Bot status error:', e); }
    }

    function updateBotUI() {
        if (isBotActive) {
            statusDot.classList.add('active');
            statusText.textContent = 'Engine Live';
            statusText.style.color = 'var(--success)';
            toggleBotBtn.textContent = 'Stop Engine';
            toggleBotBtn.classList.remove('btn-accent');
            toggleBotBtn.classList.add('btn-red');
        } else {
            statusDot.classList.remove('active');
            statusText.textContent = 'Engine Offline';
            statusText.style.color = 'var(--text-muted)';
            toggleBotBtn.textContent = 'Start Engine';
            toggleBotBtn.classList.remove('btn-red');
            toggleBotBtn.classList.add('btn-accent');
        }
    }

    // ── Sector Selection Modal ───────────────────────────────────────────────
    const sectorModal = document.getElementById('sector-modal');
    const closeSectorModal = document.getElementById('close-sector-modal');
    const cancelSectorBtn = document.getElementById('cancel-sector-btn');
    const confirmSectorBtn = document.getElementById('confirm-sector-btn');
    const sectorGrid = document.getElementById('sector-grid');
    const subsectionGrid = document.getElementById('subsection-grid');
    const selectedSectorLbl = document.getElementById('selected-sector-label');

    let sectorsPayload = [];
    let selectedSector = null;
    let selectedSubsections = new Set();

    function openSectorModal() {
        sectorModal?.classList.remove('hidden');
        loadSectors();
    }

    function closeSectorSelectionModal() {
        sectorModal?.classList.add('hidden');
    }

    async function loadSectors() {
        if (!sectorGrid || !subsectionGrid) return;
        sectorGrid.innerHTML = '<div class="empty-state mini">Loading Polymarket sectors…</div>';
        subsectionGrid.innerHTML = '<div class="empty-state mini">Select a sector first.</div>';

        try {
            const data = await fetch('/api/sectors').then(r => r.json());
            sectorsPayload = data.sectors || [];
            renderSectors();
        } catch (e) {
            console.error('Sector fetch error:', e);
            sectorsPayload = [
                { id: 'trending', name: 'Trending', subsections: [] },
                { id: 'politics', name: 'Politics', subsections: [] },
                { id: 'sports', name: 'Sports', subsections: ['NBA', 'NFL', 'MLB', 'NHL', 'Soccer'] },
                { id: 'crypto', name: 'Crypto', subsections: ['Bitcoin', 'Ethereum', 'Solana'] },
                { id: 'finance', name: 'Finance', subsections: [] },
                { id: 'tech', name: 'Tech', subsections: [] }
            ];
            renderSectors();
        }
    }

    function renderSectors() {
        if (!sectorsPayload.length) {
            sectorGrid.innerHTML = '<div class="empty-state mini">No sectors found.</div>';
            return;
        }

        sectorGrid.innerHTML = sectorsPayload.map(sector => `
      <button class="sector-chip ${selectedSector === sector.id ? 'active' : ''}" data-sector="${escapeHtml(sector.id)}">
        <span>${escapeHtml(sector.name)}</span>
        <small>${(sector.subsections || []).length} subsections</small>
      </button>
    `).join('');

        sectorGrid.querySelectorAll('.sector-chip').forEach(btn => {
            btn.addEventListener('click', () => {
                selectedSector = btn.dataset.sector;
                selectedSubsections.clear();
                renderSectors();
                renderSubsections();
            });
        });

        if (!selectedSector && sectorsPayload[0]) {
            selectedSector = sectorsPayload[0].id;
            renderSectors();
            renderSubsections();
        }
    }

    function renderSubsections() {
        const sector = sectorsPayload.find(s => s.id === selectedSector);
        if (!sector) return;

        selectedSectorLbl.textContent = sector.name;
        const subs = sector.subsections || [];

        if (!subs.length) {
            subsectionGrid.innerHTML = '<div class="empty-state mini">This sector has no detected subsection. Bot will analyze the full sector.</div>';
            return;
        }

        const isAllSelected = selectedSubsections.has('ALL') || selectedSubsections.size === 0;

        let html = `
      <label class="subsection-option">
        <input type="checkbox" value="ALL" class="all-subs-checkbox" ${isAllSelected ? 'checked' : ''}>
        <span style="font-weight:bold;">All Subsections</span>
      </label>
    `;

        html += subs.map(sub => `
      <label class="subsection-option">
        <input type="checkbox" value="${escapeHtml(sub)}" class="sub-checkbox" ${selectedSubsections.has(sub) && !isAllSelected ? 'checked' : ''}>
        <span>${escapeHtml(sub)}</span>
      </label>
    `).join('');

        subsectionGrid.innerHTML = html;

        const allCheckbox = subsectionGrid.querySelector('.all-subs-checkbox');
        const subCheckboxes = subsectionGrid.querySelectorAll('.sub-checkbox');

        allCheckbox.addEventListener('change', () => {
            if (allCheckbox.checked) {
                selectedSubsections.clear();
                selectedSubsections.add('ALL');
                subCheckboxes.forEach(cb => cb.checked = false);
            } else {
                selectedSubsections.delete('ALL');
            }
        });

        subCheckboxes.forEach(input => {
            input.addEventListener('change', () => {
                if (input.checked) {
                    selectedSubsections.add(input.value);
                    selectedSubsections.delete('ALL');
                    allCheckbox.checked = false;
                } else {
                    selectedSubsections.delete(input.value);
                    if (selectedSubsections.size === 0) {
                        allCheckbox.checked = true;
                        selectedSubsections.add('ALL');
                    }
                }
            });
        });
    }

    async function startBotWithSelection() {
        if (!selectedSector) return;
        toggleBotBtn.disabled = true;
        confirmSectorBtn.disabled = true;
        confirmSectorBtn.textContent = 'Starting…';

        try {
            const payload = {
                sector: selectedSector,
                subsections: Array.from(selectedSubsections),
            };

            const res = await fetch('/api/bot/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            if (!res.ok) throw new Error(await res.text());
            isBotActive = true;
            updateBotUI();
            closeSectorSelectionModal();
        } catch (e) {
            console.error('Start bot error:', e);
            alert('Unable to start bot. Check backend logs.');
        } finally {
            toggleBotBtn.disabled = false;
            confirmSectorBtn.disabled = false;
            confirmSectorBtn.textContent = 'Start Bot With Selection';
        }
    }

    toggleBotBtn.addEventListener('click', async () => {
        if (!isBotActive) {
            openSectorModal();
            return;
        }

        toggleBotBtn.disabled = true;
        try {
            const res = await fetch('/api/bot/stop', { method: 'POST' });
            if (res.ok) { isBotActive = false; updateBotUI(); }
        } catch (e) { console.error('Stop bot error:', e); }
        finally { toggleBotBtn.disabled = false; }
    });

    closeSectorModal?.addEventListener('click', closeSectorSelectionModal);
    cancelSectorBtn?.addEventListener('click', closeSectorSelectionModal);
    confirmSectorBtn?.addEventListener('click', startBotWithSelection);
    sectorModal?.addEventListener('click', e => { if (e.target === sectorModal) closeSectorSelectionModal(); });

    // ── Data Helpers ───────────────────────────────────────────────────────────
    function formatTime(iso) {
        return new Date(iso).toLocaleString();
    }

    // ── Balance ────────────────────────────────────────────────────────────────
    async function fetchBalance() {
        try {
            const data = await fetch('/api/balance').then(r => r.json());
            if (data.balance !== undefined)
                document.getElementById('balance-display').textContent = `$${data.balance.toFixed(2)}`;
        } catch (e) { console.error('Balance error:', e); }
    }

    // ── Trade History ──────────────────────────────────────────────────────────
    async function fetchHistory() {
        try {
            const data = await fetch('/api/history').then(r => r.json());
            const history = data.history || [];
            window.allHistory = history; // Store globally for modal access

            document.getElementById('stat-total-trades').textContent = history.length;

            const tbodyFull = document.getElementById('full-history-body');
            const tbodyRecent = document.getElementById('recent-activity-body');

            if (history.length === 0) {
                tbodyFull.innerHTML = '<tr><td colspan="7" class="empty-state">No trade history available</td></tr>';
                tbodyRecent.innerHTML = '<tr><td colspan="5" class="empty-state">No recent activity</td></tr>';
                return;
            }

            let htmlFull = '', htmlRecent = '';

            history.forEach((trade, index) => {
                let sideClass = 'badge-hold';
                if (trade.side.toUpperCase().includes('YES')) {
                    sideClass = 'yes';
                } else if (trade.side.toUpperCase().includes('NO')) {
                    sideClass = 'no';
                }
                const statusClass = trade.status === 'Success' || trade.status === 'Win' ? 'success' : 'failed';

                const marketName = trade.question || trade.token_id || 'Unknown Market';

                htmlFull += `
          <tr>
            <td>${formatTime(trade.timestamp)}</td>
            <td style="font-size:13px;color:var(--t-primary);max-width:300px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${marketName}">${marketName}</td>
            <td><span class="badge ${sideClass}">${trade.side}</span></td>
            <td>${trade.price ? '$' + parseFloat(trade.price).toFixed(4) : 'Market'}</td>
            <td>$${parseFloat(trade.amount).toFixed(2)}</td>
            <td><span class="badge ${statusClass}">${trade.status}</span></td>
            <td>
              <button class="btn btn-ghost btn-xs text-accent" onclick="_openInvoiceModal(${index})" style="padding: 2px 8px; border-radius: 4px; border: 1px solid rgba(59,130,246,0.2); font-size:10px;">
                Receipt
              </button>
            </td>
          </tr>`;

                if (index < 5) {
                    htmlRecent += `
            <tr>
              <td>${formatTime(trade.timestamp)}</td>
              <td style="font-size:13px;color:var(--t-primary);max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${marketName}">${marketName}</td>
              <td><span class="badge ${sideClass}">${trade.side}</span></td>
              <td>$${parseFloat(trade.amount).toFixed(2)}</td>
              <td><span class="badge ${statusClass}">${trade.status}</span></td>
            </tr>`;
                }
            });

            tbodyFull.innerHTML = htmlFull;
            tbodyRecent.innerHTML = htmlRecent;

            updateChart(history);
        } catch (e) { console.error('History error:', e); }
    }

    // ── Positions ──────────────────────────────────────────────────────────────
    async function fetchPositions() {
        try {
            const data = await fetch('/api/positions').then(r => r.json());
            const positions = data.positions || [];

            document.getElementById('stat-active-positions').textContent = positions.length;

            const tbody = document.getElementById('positions-body');
            if (positions.length === 0) {
                tbody.innerHTML = '<tr><td colspan="3" class="empty-state">No active positions</td></tr>';
                return;
            }

            tbody.innerHTML = positions.map(pos => `
        <tr>
          <td>${pos.asset}</td>
          <td>${parseFloat(pos.size).toFixed(4)} shares</td>
          <td>$${parseFloat(pos.value).toFixed(2)}</td>
        </tr>`).join('');
        } catch (e) { console.error('Positions error:', e); }
    }

    function fetchDashboardData() {
        fetchBalance();
        fetchHistory();
        fetchPositions();
        fetchBotStatus();
    }

    // ════════════════════════════════════════════════════════════════════════════
    // AI ANALYTICS
    // ════════════════════════════════════════════════════════════════════════════
    let allAnalyses = [];

    function getRecClass(side) {
        if (side === 'YES') return 'yes';
        if (side === 'NO') return 'no';
        return 'hold';
    }

    function buildConfidenceRingSVG(confidence, side) {
        const r = 21;
        const circumference = 2 * Math.PI * r;
        const offset = circumference - (confidence / 100) * circumference;
        const cls = `ring-${getRecClass(side)}`;
        return `
      <svg viewBox="0 0 52 52">
        <circle class="ring-bg" cx="26" cy="26" r="${r}"/>
        <circle class="ring-fill ${cls}" cx="26" cy="26" r="${r}"
          stroke-dasharray="${circumference.toFixed(2)}"
          stroke-dashoffset="${offset.toFixed(2)}"/>
      </svg>
      <div class="ring-label">${confidence}%</div>`;
    }

    function escapeHtml(text) {
        const d = document.createElement('div');
        d.textContent = text;
        return d.innerHTML;
    }

    function buildAnalysisCard(analysis, index) {
        const side = (analysis.recommended_side || 'HOLD').toUpperCase();
        const cls = getRecClass(side);
        const confidence = analysis.confidence || 0;
        const question = analysis.question || 'Unknown Market';
        const yesPrice = parseFloat(analysis.yes_price || 0).toFixed(2);
        const noPrice = parseFloat(analysis.no_price || 0).toFixed(2);
        const volume = parseFloat(analysis.volume || 0).toFixed(0);
        const reasoning = analysis.reasoning || '';
        const timestamp = analysis.timestamp ? formatTime(analysis.timestamp) : '--';
        const isMock = analysis.is_mock;

        const sideLabel = side === 'YES' ? '▲ BUY YES' : side === 'NO' ? '▼ BUY NO' : '⏸ HOLD';

        return `
      <div class="analysis-card rec-${cls}" data-index="${index}" onclick="window._openAnalysisModal(${index})">
        <div class="card-top-row">
          <div class="card-question">${escapeHtml(question)}</div>
          <span class="rec-badge badge-${cls}">${sideLabel}</span>
        </div>
        <div class="confidence-row">
          <div class="confidence-ring">${buildConfidenceRingSVG(confidence, side)}</div>
          <div class="confidence-details">
            <div class="conf-title">AI Confidence</div>
            <div class="conf-bar-track">
              <div class="conf-bar-fill bar-${cls}" style="width:${confidence}%"></div>
            </div>
          </div>
        </div>
        <div class="card-meta-row">
          <div class="card-meta-chip">YES <strong>$${yesPrice}</strong></div>
          <div class="card-meta-chip">NO <strong>$${noPrice}</strong></div>
          <div class="card-meta-chip">Vol <strong>$${Number(volume).toLocaleString()}</strong></div>
        </div>
        <div class="card-reasoning-preview">${escapeHtml(reasoning)}</div>
        <div class="card-footer">
          <span class="card-timestamp">${timestamp}</span>
          <div style="display:flex;gap:8px;align-items:center;">
            ${isMock ? '<span class="card-mock-badge">Simulation</span>' : ''}
            <button class="card-detail-btn" onclick="event.stopPropagation();window._openAnalysisModal(${index})">Read Analysis →</button>
          </div>
        </div>
      </div>`;
    }

    function getFilteredAndSorted() {
        const searchVal = (document.getElementById('analytics-search').value || '').toLowerCase();
        const sideFilter = document.getElementById('analytics-filter-side').value;
        const sortVal = document.getElementById('analytics-sort').value;

        let filtered = allAnalyses.filter(a => {
            const matchSearch = !searchVal || (a.question || '').toLowerCase().includes(searchVal);
            const matchSide = sideFilter === 'ALL' || (a.recommended_side || '').toUpperCase() === sideFilter;
            return matchSearch && matchSide;
        });

        filtered.sort((a, b) => {
            if (sortVal === 'confidence-desc') return (b.confidence || 0) - (a.confidence || 0);
            if (sortVal === 'volume-desc') return (parseFloat(b.volume) || 0) - (parseFloat(a.volume) || 0);
            return new Date(b.timestamp || 0) - new Date(a.timestamp || 0);
        });

        return filtered;
    }

    function renderAnalyses() {
        const container = document.getElementById('analytics-cards-container');
        const filtered = getFilteredAndSorted();

        document.getElementById('stat-total-analyzed').textContent = allAnalyses.length;
        document.getElementById('stat-active-recs').textContent = allAnalyses.filter(a =>
            ['YES', 'NO'].includes((a.recommended_side || '').toUpperCase()) && (a.confidence || 0) >= 75
        ).length;

        if (filtered.length === 0) {
            container.innerHTML = '<div class="empty-state" style="grid-column:1/-1;">No analyses match your filters.</div>';
            return;
        }

        container.innerHTML = filtered.map(analysis => {
            const idx = allAnalyses.indexOf(analysis);
            return buildAnalysisCard(analysis, idx);
        }).join('');
    }

    let ownedTokenIds = new Set();

    async function fetchAnalyses() {
        try {
            const [data, posData] = await Promise.all([
                fetch('/api/analyses').then(r => r.json()),
                fetch('/api/positions').then(r => r.json())
            ]);
            allAnalyses = data.analyses || [];
            const positions = posData.positions || [];
            ownedTokenIds = new Set(positions.map(p => p.token_id));
            renderAnalyses();
        } catch (e) { console.error('Analyses error:', e); }
    }

    // ── Modal ──────────────────────────────────────────────────────────────────
    const modal = document.getElementById('analysis-modal');

    window._openAnalysisModal = function (index) {
        const analysis = allAnalyses[index];
        if (!analysis) return;

        const side = (analysis.recommended_side || 'HOLD').toUpperCase();
        const cls = getRecClass(side);

        document.getElementById('modal-market-question').textContent = analysis.question || 'Unknown Market';
        document.getElementById('modal-confidence-value').textContent = `${analysis.confidence || 0}%`;
        document.getElementById('modal-yes-price').textContent = `$${parseFloat(analysis.yes_price || 0).toFixed(2)}`;
        document.getElementById('modal-no-price').textContent = `$${parseFloat(analysis.no_price || 0).toFixed(2)}`;
        document.getElementById('modal-reasoning-content').textContent = analysis.reasoning || 'No reasoning provided.';

        const badge = document.getElementById('modal-rec-badge');
        badge.textContent = side;
        badge.className = `badge rec-badge badge-${cls}`;

        const sources = analysis.sources || [];
        document.getElementById('modal-sources-list').innerHTML = sources.length === 0
            ? '<li>No sources referenced.</li>'
            : sources.map(src => `<li><a href="${escapeHtml(src)}" target="_blank" rel="noopener">${escapeHtml(src)}</a></li>`).join('');

        modal.classList.remove('hidden');

        const yesBtn = document.getElementById('manual-trade-yes-btn');
        const noBtn = document.getElementById('manual-trade-no-btn');
        const autoInvestedMsg = document.getElementById('auto-invested-msg');

        if (!autoInvestedMsg) {
            const msgDiv = document.createElement('div');
            msgDiv.id = 'auto-invested-msg';
            msgDiv.style.color = 'var(--text-success)';
            msgDiv.style.fontWeight = 'bold';
            msgDiv.style.marginTop = '10px';
            msgDiv.style.display = 'none';
            msgDiv.textContent = '✓ Bot has automatically invested in this market.';
            document.querySelector('.modal-actions').appendChild(msgDiv);
        }

        if (ownedTokenIds.has(analysis.token_id)) {
            yesBtn.style.display = 'none';
            noBtn.style.display = 'none';
            document.getElementById('auto-invested-msg').style.display = 'block';
        } else {
            yesBtn.style.display = 'inline-flex';
            noBtn.style.display = 'inline-flex';
            if (document.getElementById('auto-invested-msg')) {
                document.getElementById('auto-invested-msg').style.display = 'none';
            }
            yesBtn.onclick = () => submitManualTrade(analysis, 'YES');
            noBtn.onclick = () => submitManualTrade(analysis, 'NO');
        }
    };

    async function submitManualTrade(analysis, side) {
        const amountStr = document.getElementById('manual-trade-amount').value;
        const amount = parseFloat(amountStr);
        if (!amount || amount <= 0) {
            alert("Please enter a valid amount.");
            return;
        }
        const payload = {
            question: analysis.question,
            side: side,
            amount: amount,
            token_id: analysis.token_id || "",
            price: (side === 'YES' ? analysis.yes_price : analysis.no_price) || 0,
            category: "Manual"
        };
        try {
            const res = await fetch('/api/trade', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (res.ok) {
                alert("Trade executed successfully!");
                fetchDashboardData();
                modal.classList.add('hidden');
            } else {
                const error = await res.json();
                alert("Trade failed: " + (error.detail || "Unknown error"));
            }
        } catch (e) {
            alert("Error submitting trade.");
        }
    }

    document.getElementById('close-modal-btn').addEventListener('click', () => modal.classList.add('hidden'));
    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden'); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') modal.classList.add('hidden'); });

    // ── Invoice Modal ─────────────────────────────────────────────────────────
    const invoiceModal = document.getElementById('invoice-modal');
    const closeInvoiceBtn = document.getElementById('close-invoice-modal-btn');

    window._openInvoiceModal = function (index) {
        const trade = window.allHistory ? window.allHistory[index] : null;
        if (!trade) return;

        const content = document.getElementById('invoice-content');
        const isClose = trade.side.toUpperCase().includes('CLOSE');

        // Balance calculation
        const balanceAfter = parseFloat(trade.balance_after || 0);
        const amount = parseFloat(trade.amount || 0);
        const balanceBefore = isClose ? (balanceAfter - amount) : (balanceAfter + amount);

        const typeLabel = isClose ? 'Payout (Position Closed)' : 'Invest (Position Opened)';
        const typeColor = isClose ? 'var(--text-accent)' : 'var(--text-success)';

        let pnlHtml = '';
        if (isClose && trade.pnl !== undefined) {
            const pnlVal = parseFloat(trade.pnl || 0);
            const roiVal = parseFloat(trade.roi || 0);
            const pnlColor = pnlVal >= 0 ? 'var(--text-success)' : 'var(--text-danger)';
            const pnlSign = pnlVal >= 0 ? '+' : '';
            pnlHtml = `
        <div class="invoice-row">
          <span class="invoice-lbl">Profit / Loss</span>
          <span style="color: ${pnlColor}; font-weight: bold;">${pnlSign}$${pnlVal.toFixed(2)} (${pnlSign}${roiVal.toFixed(2)}%)</span>
        </div>
      `;
        }

        const priceLabel = isClose ? 'Exit Price' : 'Entry Price';
        let sideClass = 'badge-hold';
        if (trade.side.toUpperCase().includes('YES')) {
            sideClass = 'yes';
        } else if (trade.side.toUpperCase().includes('NO')) {
            sideClass = 'no';
        }

        content.innerHTML = `
      <div class="invoice-receipt">
        <div class="invoice-header" style="text-align: center; margin: 20px 0;">
          <div style="font-size: 32px; font-weight: 800; color: ${typeColor}; margin-bottom: 4px; font-family: var(--font-mono);">
            $${amount.toFixed(2)}
          </div>
          <div style="text-transform: uppercase; font-size: 10px; letter-spacing: 0.1em; color: var(--text-muted); font-weight: bold;">
            ${typeLabel}
          </div>
        </div>

        <div style="border-top: 1px dashed var(--border-subtle); margin: 16px 0;"></div>

        <div class="invoice-details">
          <div class="invoice-row">
            <span class="invoice-lbl">Market Reference</span>
            <span class="invoice-val" style="font-weight: 600; text-align: right; max-width: 260px; word-break: break-word;">${trade.question || 'Unknown'}</span>
          </div>

          <div class="invoice-row">
            <span class="invoice-lbl">Contracts Side</span>
            <span><span class="badge ${sideClass}">${trade.side}</span></span>
          </div>

          <div class="invoice-row">
            <span class="invoice-lbl">${priceLabel}</span>
            <span class="invoice-val font-mono">$${parseFloat(trade.price || 0).toFixed(4)}</span>
          </div>

          <div class="invoice-row">
            <span class="invoice-lbl">Contracts Size</span>
            <span class="invoice-val font-mono">${parseFloat(trade.shares || 0).toFixed(4)}</span>
          </div>

          ${pnlHtml}

          <div style="border-top: 1px dashed var(--border-subtle); margin: 16px 0;"></div>

          <div class="invoice-row">
            <span class="invoice-lbl">Balance Before</span>
            <span class="invoice-val font-mono">$${balanceBefore.toFixed(2)}</span>
          </div>

          <div class="invoice-row">
            <span class="invoice-lbl">Balance After</span>
            <span class="invoice-val font-mono" style="color: var(--text-accent); font-weight: bold; font-size: 15px;">$${balanceAfter.toFixed(2)}</span>
          </div>

          <div class="invoice-row">
            <span class="invoice-lbl">Execution Status</span>
            <span><span class="badge ${trade.status === 'Success' || trade.status === 'Win' ? 'success' : 'failed'}">${trade.status}</span></span>
          </div>

          <div class="invoice-row">
            <span class="invoice-lbl">Audit Timestamp</span>
            <span class="invoice-val">${new Date(trade.timestamp).toLocaleString()}</span>
          </div>
        </div>

        <div style="border-top: 1px solid var(--border-subtle); margin-top: 24px; padding-top: 16px; text-align: center; font-size: 10px; color: var(--text-muted); font-family: var(--font-mono);">
          POLYBOT AI AUDIT LOG ID: ${trade.token_id || 'manual'}-${new Date(trade.timestamp).getTime()}
        </div>
      </div>
    `;

        invoiceModal.classList.remove('hidden');
    };

    closeInvoiceBtn.addEventListener('click', () => invoiceModal.classList.add('hidden'));
    invoiceModal.addEventListener('click', e => { if (e.target === invoiceModal) invoiceModal.classList.add('hidden'); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') invoiceModal.classList.add('hidden'); });

    // ── Filter Listeners ───────────────────────────────────────────────────────
    document.getElementById('analytics-search').addEventListener('input', renderAnalyses);
    document.getElementById('analytics-filter-side').addEventListener('change', renderAnalyses);
    document.getElementById('analytics-sort').addEventListener('change', renderAnalyses);

    // ── Force Re-Analyse ───────────────────────────────────────────────────────
    document.getElementById('force-reanalyze-btn').addEventListener('click', async function () {
        this.disabled = true;
        this.textContent = 'Scanning…';
        try {
            await fetch('/api/analyses/refresh', { method: 'POST' });
            setTimeout(async () => {
                await fetchAnalyses();
                this.disabled = false;
                this.textContent = 'Scan Markets';
            }, 3000);
        } catch (e) {
            console.error('Re-analyse error:', e);
            this.disabled = false;
            this.textContent = 'Scan Markets';
        }
    });

    // ── Refresh Buttons ────────────────────────────────────────────────────────
    document.getElementById('refresh-dashboard')?.addEventListener('click', fetchDashboardData);
    document.getElementById('refresh-dashboard-table')?.addEventListener('click', fetchDashboardData);
    document.getElementById('refresh-history')?.addEventListener('click', fetchHistory);
    document.getElementById('refresh-positions')?.addEventListener('click', fetchPositions);
    document.getElementById('refresh-analytics')?.addEventListener('click', fetchAnalyses);

    // ── Initial Load ───────────────────────────────────────────────────────────
    fetchDashboardData();

    // ── Auto-Refresh (30s) ─────────────────────────────────────────────────────
    setInterval(() => {
        if (document.getElementById('section-dashboard').classList.contains('active')) fetchDashboardData();
        if (document.getElementById('section-analytics').classList.contains('active')) fetchAnalyses();
    }, 30000);

    // ── Charting ───────────────────────────────────────────────────────────────
    let balanceChart;
    function updateChart(history) {
        const canvas = document.getElementById('balanceChart');
        if (!canvas) return;

        const chartData = [...history].reverse();
        const labels = chartData.map(t => formatTime(t.timestamp).split(' ')[1] || '');
        const balances = chartData.map(t => parseFloat(t.balance_after) || 0);

        if (balanceChart) {
            balanceChart.data.labels = labels;
            balanceChart.data.datasets[0].data = balances;
            balanceChart.update();
        } else {
            const ctx = canvas.getContext('2d');
            const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
            gradient.addColorStop(0, 'rgba(139, 92, 246, 0.3)');
            gradient.addColorStop(1, 'rgba(139, 92, 246, 0)');
            balanceChart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'Balance',
                        data: balances,
                        borderColor: '#8b5cf6',
                        backgroundColor: gradient,
                        borderWidth: 2,
                        fill: true,
                        tension: 0.4,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                        pointHoverBorderColor: '#fff',
                        pointHoverBackgroundColor: '#8b5cf6',
                        pointHoverBorderWidth: 2
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: {
                        intersect: false,
                        mode: 'index'
                    },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            backgroundColor: 'rgba(5, 5, 10, 0.95)',
                            borderColor: 'rgba(255, 255, 255, 0.1)',
                            borderWidth: 1,
                            titleColor: '#94a3b8',
                            bodyColor: '#ffffff',
                            titleFont: { family: "'Inter', sans-serif", size: 11, weight: '600' },
                            bodyFont: { family: "'JetBrains Mono', monospace", size: 13, weight: '700' },
                            padding: 12,
                            cornerRadius: 8,
                            displayColors: false
                        }
                    },
                    scales: {
                        x: { display: false },
                        y: {
                            position: 'right',
                            border: { display: false },
                            grid: { color: 'rgba(54, 54, 80, 0.2)', drawTicks: false },
                            ticks: {
                                color: '#64748b',
                                font: { family: "'JetBrains Mono', monospace", size: 10 },
                                padding: 12,
                                maxTicksLimit: 5
                            }
                        }
                    }
                }
            });
        }
    }

    // ── Settings & Logout ───────────────────────────────────────────────────────────────
    const settingsModal = document.getElementById('settings-modal');
    document.getElementById('open-settings-btn')?.addEventListener('click', async (e) => {
        e.preventDefault();
        try {
            const data = await fetch('/api/config').then(r => r.json());
            const cfg = data.config || {};
            for (const key of Object.keys(cfg)) {
                const input = document.getElementById(`config-${key}`);
                if (input) input.value = cfg[key];
            }
            settingsModal.classList.remove('hidden');
        } catch (e) { console.error('Failed to load settings', e); }
    });

    document.getElementById('logout-btn')?.addEventListener('click', (e) => {
        e.preventDefault();
        localStorage.removeItem('poly_auth_token');
        window.location.reload();
    });

    document.getElementById('close-settings-btn')?.addEventListener('click', () => settingsModal.classList.add('hidden'));
    document.getElementById('save-settings-btn')?.addEventListener('click', async () => {
        const inputs = document.querySelectorAll('#settings-form input');
        const payload = {};
        inputs.forEach(inp => {
            const key = inp.id.replace('config-', '');
            let val = inp.value;
            if (inp.type === 'number') val = parseFloat(val);
            payload[key] = val;
        });
        try {
            const res = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (res.ok) {
                settingsModal.classList.add('hidden');
            } else {
                alert('Failed to save settings');
            }
        } catch (e) { alert('Error saving settings'); }
    });

});