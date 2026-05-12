const STATE = {
    apiKey: '',
    models: [],
    filteredModels: [],
    currentFilter: 'all',
    searchQuery: '',
    testingModel: null,
};

const CORS_PROXY = 'https://corsproxy.io/?';
const API_BASE = CORS_PROXY + encodeURIComponent('https://integrate.api.nvidia.com/v1');
const STORAGE_KEY = 'nvidia_api_key';

const TEST_CACHE = JSON.parse(localStorage.getItem('nvidia_test_cache') || '{}');

function saveCache() {
    localStorage.setItem('nvidia_test_cache', JSON.stringify(TEST_CACHE));
}

const DOM = {
    apiKey: document.getElementById('apiKey'),
    toggleKey: document.getElementById('toggleKey'),
    saveKeyBtn: document.getElementById('saveKeyBtn'),
    testKeyBtn: document.getElementById('testKeyBtn'),
    clearKeyBtn: document.getElementById('clearKeyBtn'),
    keyStatus: document.getElementById('keyStatus'),
    keyBadge: document.getElementById('keyBadge'),
    navBadge: document.getElementById('navBadge'),
    modelsSection: document.getElementById('modelsSection'),
    modelsList: document.getElementById('modelsList'),
    modelsCount: document.getElementById('modelsCount'),
    loader: document.getElementById('loader'),
    searchInput: document.getElementById('searchInput'),
    filterTabs: document.getElementById('filterTabs'),
    toastContainer: document.getElementById('toastContainer'),
};

function truncate(str, len = 60) {
    return str.length > len ? str.slice(0, len) + '...' : str;
}

function sanitize(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

function showToast(message, type = 'info', duration = 4000) {
    const icons = {
        success: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
        error: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
        warning: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
        info: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    };

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `${icons[type] || icons.info}<span>${sanitize(message)}</span><button class="toast-close">&times;</button>`;
    toast.querySelector('.toast-close').onclick = () => removeToast(toast);
    DOM.toastContainer.appendChild(toast);
    setTimeout(() => removeToast(toast), duration);
}

function removeToast(toast) {
    toast.style.animation = 'fadeOut 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
}

function showStatus(msg, type) {
    DOM.keyStatus.textContent = msg;
    DOM.keyStatus.className = `status show ${type}`;
}

function hideStatus() {
    DOM.keyStatus.className = 'status';
}

function updateUI(keyExists) {
    DOM.testKeyBtn.disabled = !keyExists;
    DOM.clearKeyBtn.disabled = !keyExists;
    DOM.saveKeyBtn.textContent = keyExists ? 'Update Key' : 'Save Key';
    DOM.keyBadge.textContent = keyExists ? 'Saved' : 'Not Set';
    DOM.keyBadge.className = `badge ${keyExists ? 'success' : ''}`;

    if (keyExists) {
        DOM.navBadge.textContent = 'Connected';
        DOM.navBadge.className = 'nav-badge connected';
    } else {
        DOM.navBadge.textContent = 'Not Connected';
        DOM.navBadge.className = 'nav-badge';
    }
}

async function apiFetch(endpoint, options = {}) {
    const url = `${API_BASE}${endpoint}`;
    const headers = {
        'Authorization': `Bearer ${STATE.apiKey}`,
        'Content-Type': 'application/json',
        ...options.headers,
    };

    const res = await fetch(url, { ...options, headers });

    if (res.status === 401 || res.status === 403) {
        throw new Error('Invalid API key. Please check and try again.');
    }
    if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
            const err = await res.json();
            msg = err.error?.message || err.message || msg;
        } catch {}
        throw new Error(msg);
    }
    return res.json();
}

async function testConnection() {
    await apiFetch('/models', { method: 'GET' });
}

async function fetchModels() {
    const data = await apiFetch('/models', { method: 'GET' });
    return data.data || [];
}

const ENDPOINT_MAP = {
    chat:      { endpoint: '/chat/completions', format: 'chat' },
    code:      { endpoint: '/chat/completions', format: 'chat' },
    embedding: { endpoint: '/embeddings',       format: 'embed' },
    image:     { endpoint: '/images/generations',format: 'image' },
    audio:     { endpoint: '/audio/speech',      format: 'audio' },
    video:     null,
    other:     null,
};

function getModelEndpoint(cat, features) {
    if (features && Array.isArray(features) && features.length > 0) {
        if (features.includes('chat'))       return ENDPOINT_MAP.chat;
        if (features.includes('completions')) return { endpoint: '/completions', format: 'text' };
        if (features.includes('embedding'))   return ENDPOINT_MAP.embedding;
        if (features.includes('image'))       return ENDPOINT_MAP.image;
    }
    const fallback = ENDPOINT_MAP[cat];
    if (!fallback) return null;
    if (cat === 'image' || cat === 'audio' || cat === 'video' || cat === 'other') return null;
    return fallback;
}

function isModelTestable(model) {
    const id = model.id || model.name || '';
    const cat = categorizeModel(id);
    const features = model.supported_features || model.capabilities || [];
    return getModelEndpoint(cat, features) !== null;
}

async function testModel(modelId, modelData) {
    const cat = categorizeModel(modelId);
    const features = modelData?.supported_features || modelData?.capabilities || [];
    const ep = getModelEndpoint(cat, features);
    if (!ep) throw new Error('No testable endpoint for this model type');

    let payload;
    if (ep.format === 'chat') {
        payload = { model: modelId, messages: [{ role: 'user', content: '.' }], max_tokens: 1, stream: false };
    } else if (ep.format === 'embed') {
        payload = { model: modelId, input: '.', encoding_format: 'float' };
    } else if (ep.format === 'image') {
        payload = { model: modelId, prompt: '.', width: 32, height: 32 };
    } else {
        payload = { model: modelId, prompt: '.', max_tokens: 1 };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    const data = await apiFetch(ep.endpoint, {
        method: 'POST',
        body: JSON.stringify(payload),
        signal: controller.signal,
    });
    clearTimeout(timer);

    let ok = false;
    if (ep.format === 'chat') ok = !!data.choices?.[0]?.message?.content || !!data.choices?.[0]?.text;
    else if (ep.format === 'embed') ok = !!data.data?.[0]?.embedding;
    else if (ep.format === 'image') ok = !!(data.data?.[0]?.url || data.data?.[0]?.b64_json);
    else ok = !!data.choices?.[0]?.text;

    if (!ok) throw new Error('Empty response');
    return 'ok';
}

function categorizeModel(id) {
    const lower = id.toLowerCase();
    if (lower.includes('chat') || lower.includes('instruct') || lower.includes('llama') ||
        lower.includes('nemotron') || lower.includes('mixtral') || lower.includes('mistral') ||
        lower.includes('gemma') || lower.includes('phi') || lower.includes('qwen') ||
        lower.includes('deepseek') || lower.includes('command') || lower.includes('gpt') ||
        lower.includes('dbrx') || lower.includes('recurrent') || lower.includes('aya') ||
        lower.includes('stablelm') || lower.includes('solar') || lower.includes('vicuna') ||
        lower.includes('falcon') || lower.includes('mpt') || lower.includes('opt') ||
        lower.includes('bloom') || lower.includes('olmo')) {
        return 'chat';
    }
    if (lower.includes('embed') || lower.includes('retrieval') || lower.includes('bert') ||
        lower.includes('e5-') || lower.includes('bge-') || lower.includes('gte-')) {
        return 'embedding';
    }
    if (lower.includes('image') || lower.includes('img') || lower.includes('gen') ||
        lower.includes('stable-diffusion') || lower.includes('dall-e') || lower.includes('pixart') ||
        lower.includes('sana') || lower.includes('wuerstchen') || lower.includes('flux') ||
        lower.includes('sdxl') || lower.includes('sd3') || lower.includes('canny') ||
        lower.includes('controlnet') || lower.includes('inpaint') || lower.includes('upscale')) {
        return 'image';
    }
    if (lower.includes('code') || lower.includes('starcoder') || lower.includes('codellama') ||
        lower.includes('codegen') || lower.includes('incoder') || lower.includes('polycoder') ||
        lower.includes('deepseek-coder')) {
        return 'code';
    }
    if (lower.includes('audio') || lower.includes('whisper') || lower.includes('tts') ||
        lower.includes('speech') || lower.includes('clap') || lower.includes('hifi')) {
        return 'audio';
    }
    if (lower.includes('video') || lower.includes('cosmos') || lower.includes('videogpt')) {
        return 'video';
    }
    return 'other';
}

function renderModels() {
    const list = DOM.modelsList;
    DOM.modelsCount.textContent = STATE.filteredModels.length;

    if (STATE.filteredModels.length === 0) {
        list.innerHTML = `
            <div class="empty-state">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#555" stroke-width="1.5">
                    <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
                </svg>
                <p>No models match your criteria.</p>
            </div>`;
        return;
    }

    list.innerHTML = STATE.filteredModels.map(m => {
        const id = m.id || m.name || 'Unknown';
        const cat = categorizeModel(id);
        const testable = isModelTestable(m);
        const cached = TEST_CACHE[id];
        const pricing = m.pricing || {};
        const inputPrice = pricing.input ?? pricing.input_price ?? null;
        const outputPrice = pricing.output ?? pricing.output_price ?? null;
        const hasFreeTier = (inputPrice === 0 || inputPrice === null) && (outputPrice === 0 || outputPrice === null);
        const contextWindow = m.context_length || m.max_context_tokens || m.context_length_tokens || '—';
        const maxTokens = m.max_tokens || m.max_output_tokens || '—';
        const ownedBy = m.owned_by || 'NVIDIA';

        let testBtnHtml;
        if (cached) {
            const cls = cached.ok ? 'test-model-btn passed' : 'test-model-btn failed';
            const label = cached.ok ? 'Working' : 'Failed';
            const note = cached.ok ? '' : `<div class="model-result show error">${sanitize(cached.error)}</div>`;
            testBtnHtml = `
                <div class="model-test">
                    <button class="${cls}" disabled>${label}</button>
                    ${note}
                </div>`;
        } else if (!testable) {
            testBtnHtml = `
                <div class="model-test">
                    <button class="test-model-btn" disabled style="opacity:0.35" title="No testable endpoint available">N/A</button>
                </div>`;
        } else {
            testBtnHtml = `
                <div class="model-test">
                    <button class="test-model-btn" data-model-id="${sanitize(id)}">Test</button>
                    <div class="model-result" id="result-${sanitize(id).replace(/\s+/g, '-')}"></div>
                </div>`;
        }

        return `
        <div class="model-card" data-model-id="${sanitize(id)}">
            <div class="model-name" title="${sanitize(id)}">${sanitize(truncate(id, 50))}</div>
            <div class="model-tags">
                <span class="tag ${cat}">${cat}</span>
                ${hasFreeTier ? '<span class="tag" style="background:rgba(118,185,0,0.12);color:#76b900">FREE</span>' : ''}
                ${!testable ? '<span class="tag" style="background:rgba(255,68,68,0.1);color:#ff6666">SKIP</span>' : ''}
                <span class="tag">${sanitize(ownedBy)}</span>
            </div>
            <div class="model-stats">
                <span class="stat">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#555" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/></svg>
                    Context: <span class="stat-value">${contextWindow !== '—' ? contextWindow.toLocaleString() : '—'}</span>
                </span>
                <span class="stat">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#555" stroke-width="2"><polyline points="4 17 9 12 4 7"/><path d="M12 17h8"/></svg>
                    Max: <span class="stat-value">${maxTokens !== '—' ? maxTokens.toLocaleString() : '—'}</span>
                </span>
                <span class="stat ${hasFreeTier ? 'free' : ''}">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
                    ${hasFreeTier ? 'Free' : (inputPrice !== null || outputPrice !== null ? `$${inputPrice ?? 0}/$${outputPrice ?? 0}` : '—')}
                </span>
            </div>
            ${testBtnHtml}
        </div>`;
    }).join('');

    document.querySelectorAll('.test-model-btn:not([disabled])').forEach(btn => {
        btn.addEventListener('click', () => handleModelTest(btn.dataset.modelId, btn));
    });
}

function applyFilters() {
    const hideUntestable = document.getElementById('hideUntestable')?.checked;
    const sortTestable = document.getElementById('sortTestable')?.checked;
    const query = STATE.searchQuery.toLowerCase().trim();
    const filter = STATE.currentFilter;

    let filtered = STATE.models.filter(m => {
        const id = (m.id || m.name || '').toLowerCase();
        if (filter !== 'all' && categorizeModel(id) !== filter) return false;
        if (query && !id.includes(query)) return false;
        if (hideUntestable && !isModelTestable(m)) return false;
        return true;
    });

    if (sortTestable) {
        filtered.sort((a, b) => {
            const ta = isModelTestable(a) ? 0 : 1;
            const tb = isModelTestable(b) ? 0 : 1;
            return ta - tb;
        });
    }

    STATE.filteredModels = filtered;
    renderModels();
}

async function handleModelTest(modelId, btn) {
    if (STATE.testingModel) return;
    if (TEST_CACHE[modelId]) {
        showToast(`${truncate(modelId, 30)} already tested`, 'info', 1500);
        return;
    }

    const modelData = STATE.models.find(m => (m.id || m.name) === modelId);
    STATE.testingModel = modelId;

    if (btn) {
        btn.disabled = true;
        btn.textContent = '...';
        btn.className = 'test-model-btn testing';
    }

    try {
        await testModel(modelId, modelData);
        TEST_CACHE[modelId] = { ok: true };
        saveCache();
        renderModels();
    } catch (err) {
        TEST_CACHE[modelId] = { ok: false, error: err.message };
        saveCache();
        renderModels();
    } finally {
        STATE.testingModel = null;
    }
}

async function handleSaveKey() {
    const key = DOM.apiKey.value.trim();
    if (!key) {
        showStatus('Please enter an API key.', 'error');
        return;
    }
    if (!key.startsWith('nvapi-')) {
        showStatus('Invalid format. Key should start with nvapi-', 'error');
        return;
    }

    STATE.apiKey = key;
    showStatus('Validating key...', 'loading');

    try {
        await testConnection();
        localStorage.setItem(STORAGE_KEY, key);
        updateUI(true);
        showStatus('API key saved and validated!', 'success');
        showToast('API key connected successfully', 'success');
        DOM.apiKey.value = key;
        await loadAndShowModels();
    } catch (err) {
        showStatus(`Failed: ${err.message}`, 'error');
        showToast(`Connection failed: ${err.message}`, 'error');
        STATE.apiKey = '';
        updateUI(false);
    }
}

async function handleTestKey() {
    if (!STATE.apiKey) return;
    showStatus('Testing connection...', 'loading');

    try {
        await testConnection();
        showStatus('Connection successful! API key is valid.', 'success');
        showToast('API key is valid', 'success');
        DOM.navBadge.textContent = 'Connected';
        DOM.navBadge.className = 'nav-badge connected';
    } catch (err) {
        showStatus(`Connection failed: ${err.message}`, 'error');
        showToast(`Connection failed: ${err.message}`, 'error');
        DOM.navBadge.textContent = 'Connection Failed';
        DOM.navBadge.className = 'nav-badge error';
    }
}

function handleClearKey() {
    STATE.apiKey = '';
    STATE.models = [];
    STATE.filteredModels = [];
    for (const k in TEST_CACHE) delete TEST_CACHE[k];
    saveCache();
    localStorage.removeItem(STORAGE_KEY);
    DOM.apiKey.value = '';
    updateUI(false);
    hideStatus();
    DOM.modelsSection.style.display = 'none';
    DOM.navBadge.textContent = 'Not Connected';
    DOM.navBadge.className = 'nav-badge';
    showToast('API key and cache cleared', 'info');
}

function handleToggleVisibility() {
    DOM.apiKey.type = DOM.apiKey.type === 'password' ? 'text' : 'password';
}

function handleFilterClick(e) {
    const btn = e.target.closest('.filter-btn');
    if (!btn) return;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    STATE.currentFilter = btn.dataset.filter;
    applyFilters();
}

function handleSearch() {
    STATE.searchQuery = DOM.searchInput.value;
    applyFilters();
}

function clearTestCache() {
    for (const k in TEST_CACHE) delete TEST_CACHE[k];
    saveCache();
    renderModels();
}

async function batchVerifyTestable() {
    const testable = STATE.models.filter(m => isModelTestable(m) && !TEST_CACHE[m.id || m.name]);
    if (testable.length === 0) {
        showToast('All done! All testable models verified.', 'success');
        return;
    }
    showToast(`Verifying ${testable.length} models...`, 'info', 2000);
    const CONCURRENCY = 5;
    const ids = testable.map(m => m.id || m.name);
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
        const batch = ids.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async id => {
            try {
                const modelData = STATE.models.find(m => (m.id || m.name) === id);
                await testModel(id, modelData);
                TEST_CACHE[id] = { ok: true };
            } catch (err) {
                TEST_CACHE[id] = { ok: false, error: err.message };
            }
        }));
        renderModels();
        saveCache();
    }
    const working = ids.filter(id => TEST_CACHE[id]?.ok).length;
    showToast(`Done! ${working}/${ids.length} working`, working === ids.length ? 'success' : 'warning');
}

function addModelControls() {
    const filterBar = document.querySelector('.filter-bar');
    if (!filterBar || document.getElementById('modelControls')) return;

    const controls = document.createElement('div');
    controls.id = 'modelControls';
    controls.style.cssText = 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:4px';

    controls.innerHTML = `
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#888;cursor:pointer">
            <input type="checkbox" id="hideUntestable" style="accent-color:#76b900">
            Hide untestable
        </label>
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#888;cursor:pointer">
            <input type="checkbox" id="sortTestable" style="accent-color:#76b900" checked>
            Testable first
        </label>
        <button id="batchVerifyBtn" class="btn btn-secondary" style="padding:6px 14px;font-size:11px">Verify All</button>
        <button id="clearCacheBtn" class="btn btn-secondary" style="padding:6px 14px;font-size:11px">Reset Tests</button>
    `;

    filterBar.appendChild(controls);

    document.getElementById('hideUntestable').addEventListener('change', applyFilters);
    document.getElementById('sortTestable').addEventListener('change', applyFilters);
    document.getElementById('batchVerifyBtn').addEventListener('click', batchVerifyTestable);
    document.getElementById('clearCacheBtn').addEventListener('click', clearTestCache);
}

async function loadAndShowModels() {
    DOM.loader.classList.add('show');
    DOM.modelsSection.style.display = 'block';
    DOM.modelsList.innerHTML = '';

    try {
        const models = await fetchModels();
        STATE.models = models;
        addModelControls();
        applyFilters();
        const testable = models.filter(m => isModelTestable(m)).length;
        showToast(`Loaded ${models.length} models (${testable} testable)`, 'info', 4000);
    } catch (err) {
        DOM.modelsList.innerHTML = `
            <div class="empty-state">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ff4444" stroke-width="1.5">
                    <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
                </svg>
                <p>Failed to load models: ${sanitize(err.message)}</p>
            </div>`;
        showToast(`Failed to load models: ${err.message}`, 'error');
    } finally {
        DOM.loader.classList.remove('show');
    }
}

function init() {
    const savedKey = localStorage.getItem(STORAGE_KEY);
    if (savedKey) {
        STATE.apiKey = savedKey;
        DOM.apiKey.value = savedKey;
        updateUI(true);
        loadAndShowModels();
    } else {
        updateUI(false);
    }

    DOM.saveKeyBtn.addEventListener('click', handleSaveKey);
    DOM.testKeyBtn.addEventListener('click', handleTestKey);
    DOM.clearKeyBtn.addEventListener('click', handleClearKey);
    DOM.toggleKey.addEventListener('click', handleToggleVisibility);
    DOM.filterTabs.addEventListener('click', handleFilterClick);
    DOM.searchInput.addEventListener('input', handleSearch);

    DOM.apiKey.addEventListener('keydown', e => {
        if (e.key === 'Enter') handleSaveKey();
    });

    document.addEventListener('click', e => {
        const toast = e.target.closest('.toast');
        if (toast && e.target.tagName !== 'BUTTON') {
            removeToast(toast);
        }
    });
}

document.addEventListener('DOMContentLoaded', init);
