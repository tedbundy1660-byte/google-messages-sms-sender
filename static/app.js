// State Management
let appState = {
    contacts: [],
    stats: {},
    templates: [],
    blacklist: [],
    pairing: { is_paired: false, browser_running: false, status_text: 'Disconnected' },
    logs: [],
    customHeaders: ['name', 'phone'],
    mmsAttachment: null
};

let ws = null;
let countdownInterval = null;

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    lucide.createIcons();
    connectWebSocket();
    fetchInitialStatus();
    updateTemplatePreview();

    // Setup drag & drop for contacts
    const dropzone = document.getElementById('dropzone');
    if (dropzone) {
        ['dragenter', 'dragover'].forEach(eventName => {
            dropzone.addEventListener(eventName, (e) => {
                e.preventDefault();
                dropzone.classList.add('dropzone-active');
            }, false);
        });

        ['dragleave', 'drop'].forEach(eventName => {
            dropzone.addEventListener(eventName, (e) => {
                e.preventDefault();
                dropzone.classList.remove('dropzone-active');
            }, false);
        });

        dropzone.addEventListener('drop', (e) => {
            const dt = e.dataTransfer;
            const files = dt.files;
            if (files.length > 0) {
                uploadFile(files[0]);
            }
        });
    }
});

// WebSocket Connection
function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log('WebSocket connected');
    };

    ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            handleWsMessage(msg);
        } catch (e) {
            console.error('Error parsing WS message:', e);
        }
    };

    ws.onclose = () => {
        console.log('WebSocket disconnected. Reconnecting in 3s...');
        setTimeout(connectWebSocket, 3000);
    };
}

function handleWsMessage(msg) {
    switch (msg.type) {
        case 'init':
            appState.stats = msg.data.stats || {};
            appState.contacts = msg.data.contacts || [];
            appState.templates = msg.data.templates || [];
            appState.blacklist = msg.data.blacklist || [];
            appState.pairing = msg.data.pairing || {};
            if (msg.data.logs) {
                msg.data.logs.forEach(l => appendLog(l.timestamp, l.level, l.message));
            }
            updatePairingUI();
            updateStatsUI();
            renderContactsTable();
            renderTemplatesList();
            renderBlacklistTable();
            updateTemplatePreview();
            break;

        case 'pairing':
            appState.pairing = msg.data;
            updatePairingUI();
            break;

        case 'stats':
            appState.stats = msg.data;
            updateStatsUI();
            break;

        case 'contact_update':
            const updatedContact = msg.data;
            const idx = appState.contacts.findIndex(c => c.id === updatedContact.id);
            if (idx !== -1) {
                appState.contacts[idx] = updatedContact;
                updateContactRow(updatedContact);
            }
            break;

        case 'contacts_loaded':
            appState.contacts = msg.data;
            renderContactsTable();
            updateTemplatePreview();
            break;

        case 'templates_updated':
            appState.templates = msg.data;
            renderTemplatesList();
            break;

        case 'blacklist_updated':
            appState.blacklist = msg.data;
            renderBlacklistTable();
            break;

        case 'countdown':
            handleCountdown(msg.data.seconds, msg.data.reason);
            break;

        case 'log':
            appendLog(msg.data.timestamp, msg.data.level, msg.data.message);
            break;
    }
}

// Initial status load
async function fetchInitialStatus() {
    try {
        const res = await fetch('/api/status');
        const data = await res.json();
        appState.pairing = data.pairing;
        appState.stats = data.stats;
        updatePairingUI();
        updateStatsUI();
    } catch (e) {
        console.error('Failed to fetch status:', e);
    }
}

// Pairing Management
async function openPairingWindow() {
    appendLog(new Date().toLocaleTimeString(), 'info', 'Opening Google Messages browser...');
    try {
        const res = await fetch('/api/pair', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            appState.pairing = { is_paired: data.is_paired, browser_running: true, status_text: data.status_text };
            updatePairingUI();
        }
    } catch (e) {
        appendLog(new Date().toLocaleTimeString(), 'error', `Pairing error: ${e.message}`);
    }
}

async function closeBrowser() {
    try {
        await fetch('/api/browser/close', { method: 'POST' });
        appState.pairing = { is_paired: false, browser_running: false, status_text: 'Disconnected' };
        updatePairingUI();
        appendLog(new Date().toLocaleTimeString(), 'info', 'Browser session closed.');
    } catch (e) {
        console.error('Error closing browser:', e);
    }
}

function updatePairingUI() {
    const dot = document.getElementById('pairingDot');
    const text = document.getElementById('pairingText');
    const p = appState.pairing;

    if (p.is_paired) {
        dot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400 glow-green';
        text.innerText = 'Connected & Paired';
        text.className = 'font-medium text-emerald-400';
    } else if (p.browser_running) {
        dot.className = 'w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse';
        text.innerText = 'Pairing / QR Scan Needed';
        text.className = 'font-medium text-amber-400';
    } else {
        dot.className = 'w-2.5 h-2.5 rounded-full bg-gray-500';
        text.innerText = 'Disconnected';
        text.className = 'font-medium text-gray-400';
    }
}

// Tab Switching
function switchContactTab(tab) {
    const upBtn = document.getElementById('tabUploadBtn');
    const manBtn = document.getElementById('tabManualBtn');
    const upContent = document.getElementById('tabUploadContent');
    const manContent = document.getElementById('tabManualContent');

    if (tab === 'upload') {
        upBtn.className = 'px-2.5 py-1 rounded bg-blue-600 text-white font-medium';
        manBtn.className = 'px-2.5 py-1 rounded text-gray-400 hover:text-white';
        upContent.classList.remove('hidden');
        manContent.classList.add('hidden');
    } else {
        manBtn.className = 'px-2.5 py-1 rounded bg-blue-600 text-white font-medium';
        upBtn.className = 'px-2.5 py-1 rounded text-gray-400 hover:text-white';
        manContent.classList.remove('hidden');
        upContent.classList.add('hidden');
    }
}

// Contacts Upload Handling
function handleFileUpload(event) {
    const file = event.target.files[0];
    if (file) {
        uploadFile(file);
    }
}

async function uploadFile(file) {
    const formData = new FormData();
    formData.append('file', file);
    
    const template = document.getElementById('messageTemplate').value;
    if (template) formData.append('template', template);

    const countryCode = document.getElementById('countryCodeSelect').value;
    if (countryCode) formData.append('country_code', countryCode);

    appendLog(new Date().toLocaleTimeString(), 'info', `Uploading '${file.name}'...`);

    try {
        const res = await fetch('/api/contacts/upload', {
            method: 'POST',
            body: formData
        });
        const data = await res.json();
        if (data.success) {
            appendLog(new Date().toLocaleTimeString(), 'success', `✓ Loaded ${data.count} contacts.`);
            if (data.columns) {
                renderTagPills(data.columns);
            }
        } else {
            appendLog(new Date().toLocaleTimeString(), 'error', `Upload failed: ${data.detail}`);
        }
    } catch (e) {
        appendLog(new Date().toLocaleTimeString(), 'error', `Upload error: ${e.message}`);
    }
}

async function handleManualSubmit() {
    const text = document.getElementById('manualTextInput').value.trim();
    if (!text) {
        alert('Please enter at least one contact.');
        return;
    }

    const template = document.getElementById('messageTemplate').value;
    const countryCode = document.getElementById('countryCodeSelect').value;

    try {
        const res = await fetch('/api/contacts/manual', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, template, country_code: countryCode })
        });
        const data = await res.json();
        if (data.success) {
            appendLog(new Date().toLocaleTimeString(), 'success', `✓ Loaded ${data.count} contacts.`);
        }
    } catch (e) {
        appendLog(new Date().toLocaleTimeString(), 'error', `Error loading contacts: ${e.message}`);
    }
}

// Tag Insertion & Preview
function renderTagPills(columns) {
    const container = document.getElementById('tagPills');
    container.innerHTML = '';
    columns.forEach(col => {
        const btn = document.createElement('button');
        btn.className = 'tag-pill font-mono';
        btn.innerText = `{${col}}`;
        btn.onclick = () => insertTag(`{${col}}`);
        container.appendChild(btn);
    });
}

function insertTag(tag) {
    const textarea = document.getElementById('messageTemplate');
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;
    textarea.value = text.substring(0, start) + tag + text.substring(end);
    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = start + tag.length;
    updateTemplatePreview();
}

function resolveSpintaxClient(text) {
    const pattern = /\{([^{}]+)\}/;
    while (pattern.test(text)) {
        text = text.replace(pattern, (_, choices) => {
            const arr = choices.split('|');
            return arr[Math.floor(Math.random() * arr.length)];
        });
    }
    return text;
}

// Template & Single SMS Corrector
function updateTemplatePreview() {
    const tpl = document.getElementById('messageTemplate').value;
    const counter = document.getElementById('charCounter');
    const progressBar = document.getElementById('charProgressBar');
    const previewText = document.getElementById('previewText');
    const previewRecipient = document.getElementById('previewRecipient');
    const autoOptout = document.getElementById('autoOptoutCheckbox')?.checked;
    const optoutVal = document.getElementById('optoutSelect')?.value || 'Reply STOP to opt out';

    let sampleName = 'John Doe';
    let samplePhone = '+1234567890';
    if (appState.contacts.length > 0) {
        sampleName = appState.contacts[0].name || 'Recipient';
        samplePhone = appState.contacts[0].phone || '+1234567890';
    }

    previewRecipient.innerText = samplePhone;

    let rendered = tpl
        .replace(/\{name\}/gi, sampleName)
        .replace(/\{phone\}/gi, samplePhone);

    rendered = resolveSpintaxClient(rendered);

    // Auto-append opt-out to preview if checked
    if (autoOptout) {
        const lower = rendered.toLowerCase();
        if (!lower.includes('stop') && !lower.includes('unsubscribe') && !lower.includes('opt out')) {
            const optPhrase = resolveSpintaxClient(optoutVal);
            rendered = `${rendered.trim()}\n${optPhrase}`;
        }
    }

    previewText.innerText = rendered || '(Enter a message template to see preview)';

    const len = rendered.length;
    const pct = Math.min((len / 160) * 100, 100);

    if (len <= 160) {
        counter.innerText = `${len} / 160 chars (1 SMS segment)`;
        counter.className = 'font-mono font-bold text-emerald-400';
        progressBar.className = 'bg-emerald-500 h-1.5 rounded-full transition-all duration-200';
    } else {
        const segments = Math.ceil(len / 153);
        counter.innerText = `${len} / 160 chars (${segments} SMS segments - Multi-part)`;
        counter.className = 'font-mono font-bold text-amber-400';
        progressBar.className = 'bg-amber-500 h-1.5 rounded-full transition-all duration-200';
    }
    progressBar.style.width = `${pct}%`;
}

// 1-Click Single SMS Corrector & Shortener
function autoOptimizeSingleSms() {
    const textarea = document.getElementById('messageTemplate');
    let text = textarea.value;

    // 1. Remove excess white spaces and blank lines
    text = text.replace(/[ \t]+/g, ' ');
    text = text.replace(/\n\s*\n+/g, '\n').trim();

    // 2. Shorten common words/phrases if too long
    const shortenings = [
        [/\bplease\b/gi, 'pls'],
        [/\bappointment\b/gi, 'appt'],
        [/\bmessage\b/gi, 'msg'],
        [/\binformation\b/gi, 'info'],
        [/\btomorrow\b/gi, 'tmrw'],
        [/\bthanks\b/gi, 'thx'],
        [/\bthank you\b/gi, 'thanks'],
        [/\bdiscount\b/gi, 'deal'],
        [/\breply\b/gi, 'txt']
    ];

    if (text.length > 160) {
        for (const [pattern, repl] of shortenings) {
            text = text.replace(pattern, repl);
            if (text.length <= 160) break;
        }
    }

    // 3. If still over 160, safely trim
    if (text.length > 160) {
        text = text.substring(0, 160).trim();
    }

    textarea.value = text;
    updateTemplatePreview();
    appendLog(new Date().toLocaleTimeString(), 'info', '✓ Optimized message to single SMS limit (<= 160 chars).');
}

// Media Attachment (MMS)
async function handleMediaUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    appendLog(new Date().toLocaleTimeString(), 'info', `Uploading media attachment: ${file.name}...`);

    try {
        const res = await fetch('/api/upload-media', {
            method: 'POST',
            body: formData
        });
        const data = await res.json();
        if (data.success) {
            appState.mmsAttachment = data;
            document.getElementById('mediaUploadBox').classList.add('hidden');
            const preview = document.getElementById('mediaPreviewCard');
            preview.classList.remove('hidden');
            document.getElementById('mediaThumbnail').src = data.url;
            document.getElementById('mediaFileName').innerText = data.filename;
            document.getElementById('mmsStatus').innerText = 'MMS Image Attached';
            document.getElementById('mmsStatus').className = 'text-[11px] text-emerald-400 font-semibold';
            appendLog(new Date().toLocaleTimeString(), 'success', `✓ MMS attachment ready: ${data.filename}`);
        }
    } catch (e) {
        appendLog(new Date().toLocaleTimeString(), 'error', `Failed to upload media: ${e.message}`);
    }
}

function removeMediaAttachment() {
    appState.mmsAttachment = null;
    document.getElementById('mediaFileInput').value = '';
    document.getElementById('mediaPreviewCard').classList.add('hidden');
    document.getElementById('mediaUploadBox').classList.remove('hidden');
    document.getElementById('mmsStatus').innerText = 'No media attached';
    document.getElementById('mmsStatus').className = 'text-[11px] text-gray-500';
    appendLog(new Date().toLocaleTimeString(), 'info', 'Removed MMS media attachment.');
}

// Delay Presets
function setDelayPreset(min, max) {
    document.getElementById('minDelayInput').value = min;
    document.getElementById('maxDelayInput').value = max;
}

// Campaign Execution Controls
async function startCampaign() {
    const template = document.getElementById('messageTemplate').value.trim();
    if (!template) {
        alert('Please enter a message template.');
        return;
    }

    const minDelay = parseFloat(document.getElementById('minDelayInput').value) || 15.0;
    const maxDelay = parseFloat(document.getElementById('maxDelayInput').value) || 45.0;
    const batchSize = parseInt(document.getElementById('batchSizeInput').value) || 0;
    const batchDelay = parseFloat(document.getElementById('batchDelayInput').value) || 300.0;
    const countryCode = document.getElementById('countryCodeSelect').value;
    const autoOptout = document.getElementById('autoOptoutCheckbox')?.checked || false;
    const optoutText = document.getElementById('optoutSelect')?.value || '{Reply STOP to opt out|Text STOP to unsubscribe}';
    const enforceSingleSms = document.getElementById('enforceSingleSmsCheckbox')?.checked || false;

    const config = {
        min_delay_seconds: minDelay,
        max_delay_seconds: maxDelay,
        message_template: template,
        batch_size: batchSize,
        batch_delay_seconds: batchDelay,
        default_country_code: countryCode,
        auto_optout: autoOptout,
        optout_text: optoutText,
        enforce_single_sms: enforceSingleSms,
        max_character_limit: 160,
        image_path: appState.mmsAttachment ? appState.mmsAttachment.filepath : null
    };

    try {
        const res = await fetch('/api/campaign/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });
        const data = await res.json();
        if (!data.success) {
            alert(data.detail || 'Could not start campaign.');
        }
    } catch (e) {
        alert('Error starting campaign: ' + e.message);
    }
}

async function pauseCampaign() {
    await fetch('/api/campaign/pause', { method: 'POST' });
}

async function resumeCampaign() {
    await fetch('/api/campaign/resume', { method: 'POST' });
}

async function stopCampaign() {
    await fetch('/api/campaign/stop', { method: 'POST' });
}

async function resetCampaign() {
    if (confirm('Reset all contacts to pending?')) {
        await fetch('/api/campaign/reset', { method: 'POST' });
    }
}

async function retryFailedCampaign() {
    try {
        const res = await fetch('/api/campaign/retry-failed', { method: 'POST' });
        const data = await res.json();
        if (data.count === 0) {
            alert('No failed contacts found to retry.');
        } else {
            appendLog(new Date().toLocaleTimeString(), 'info', `✓ Reset ${data.count} failed contacts back to pending.`);
        }
    } catch (e) {
        alert('Error resetting failed contacts: ' + e.message);
    }
}

// UI Updaters
function updateStatsUI() {
    const s = appState.stats;
    document.getElementById('statTotal').innerText = s.total || 0;
    document.getElementById('statSent').innerText = s.sent || 0;
    document.getElementById('statFailed').innerText = s.failed || 0;
    document.getElementById('statPending').innerText = s.pending || 0;
    document.getElementById('statBlacklisted').innerText = s.blacklisted || 0;

    const pct = s.progress_percent || 0.0;
    document.getElementById('progressPercent').innerText = `${pct}%`;
    document.getElementById('progressBar').style.width = `${pct}%`;

    const btnStart = document.getElementById('btnStart');
    const btnPause = document.getElementById('btnPause');
    const btnResume = document.getElementById('btnResume');
    const btnStop = document.getElementById('btnStop');
    const statusLabel = document.getElementById('campaignStatusLabel');

    if (s.is_running) {
        btnStart.classList.add('hidden');
        btnStop.classList.remove('hidden');

        if (s.is_paused) {
            btnPause.classList.add('hidden');
            btnResume.classList.remove('hidden');
            statusLabel.innerText = 'Campaign Paused';
            statusLabel.className = 'text-amber-400 font-bold';
        } else if (s.is_batch_paused) {
            btnPause.classList.remove('hidden');
            btnResume.classList.add('hidden');
            statusLabel.innerText = `Batch Cooldown (${Math.round(s.batch_pause_remaining_seconds)}s remaining)`;
            statusLabel.className = 'text-indigo-400 font-bold';
        } else {
            btnPause.classList.remove('hidden');
            btnResume.classList.add('hidden');
            statusLabel.innerText = `Sending: [${s.current_index}/${s.total}] ${s.current_phone || ''}`;
            statusLabel.className = 'text-emerald-400 font-bold animate-pulse';
        }
    } else {
        btnStart.classList.remove('hidden');
        btnPause.classList.add('hidden');
        btnResume.classList.add('hidden');
        btnStop.classList.add('hidden');
        statusLabel.innerText = pct === 100.0 && s.total > 0 ? 'Campaign Completed!' : 'Ready to start';
        statusLabel.className = 'text-gray-400 font-medium';
        hideCountdown();
    }
}

function handleCountdown(seconds, reason) {
    const banner = document.getElementById('countdownBanner');
    const msg = document.getElementById('countdownMessage');
    const timer = document.getElementById('countdownTimer');

    banner.classList.remove('hidden');
    timer.innerText = `${seconds}s`;

    if (reason === 'batch_cooldown') {
        msg.innerText = '⏸ Batch rest period in progress...';
    } else {
        msg.innerText = '⏳ Anti-Spam randomized delay...';
    }

    if (seconds <= 0) {
        hideCountdown();
    }
}

function hideCountdown() {
    document.getElementById('countdownBanner').classList.add('hidden');
}

// Contacts Table Rendering & Filter
function filterContactsTable() {
    renderContactsTable();
}

function renderContactsTable() {
    const tbody = document.getElementById('contactsTableBody');
    const filter = document.getElementById('statusFilter').value.toLowerCase();
    const search = document.getElementById('contactSearch').value.toLowerCase().trim();

    const filtered = appState.contacts.filter(c => {
        const matchesStatus = (filter === 'all') || (c.status.toLowerCase() === filter);
        const matchesSearch = !search ||
            (c.phone && c.phone.toLowerCase().includes(search)) ||
            (c.name && c.name.toLowerCase().includes(search)) ||
            (c.message && c.message.toLowerCase().includes(search));
        return matchesStatus && matchesSearch;
    });

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="text-center py-8 text-gray-500 font-sans">${appState.contacts.length === 0 ? 'No contacts loaded yet.' : 'No contacts match the filter.'}</td></tr>`;
        return;
    }

    tbody.innerHTML = filtered.map(c => `
        <tr id="contact-row-${c.id}" class="hover:bg-gray-800/40 transition">
            <td class="py-2.5 px-3 text-gray-500 font-mono">${c.id}</td>
            <td class="py-2.5 px-3 text-gray-200 font-sans font-semibold">${c.name || '<span class="text-gray-500 font-normal">Unknown</span>'}</td>
            <td class="py-2.5 px-3 text-blue-400 font-mono">${c.phone}</td>
            <td class="py-2.5 px-3 text-gray-300 font-sans max-w-[200px] truncate" title="${escapeHtml(c.message)}">${escapeHtml(c.message)}</td>
            <td class="py-2.5 px-3">${getStatusBadge(c.status)}</td>
            <td class="py-2.5 px-3 text-xs text-gray-400 font-mono">${c.error ? `<span class="text-rose-400">${escapeHtml(c.error)}</span>` : (c.sent_at || '-')}</td>
        </tr>
    `).join('');
}

function updateContactRow(c) {
    const row = document.getElementById(`contact-row-${c.id}`);
    if (row) {
        row.children[4].innerHTML = getStatusBadge(c.status);
        row.children[5].innerHTML = c.error ? `<span class="text-rose-400">${escapeHtml(c.error)}</span>` : (c.sent_at || '-');
    }
}

function getStatusBadge(status) {
    switch (status.toLowerCase()) {
        case 'sent':
            return '<span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-emerald-950 text-emerald-400 border border-emerald-800/50">Sent ✓</span>';
        case 'sending':
            return '<span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-blue-950 text-blue-400 border border-blue-800/50 animate-pulse">Sending...</span>';
        case 'failed':
            return '<span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-rose-950 text-rose-400 border border-rose-800/50">Failed ✗</span>';
        case 'blacklisted':
            return '<span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-purple-950 text-purple-400 border border-purple-800/50">DNC / Blocked</span>';
        default:
            return '<span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-gray-800 text-gray-400 border border-gray-700">Pending</span>';
    }
}

// Log Terminal Stream
function appendLog(timestamp, level, message) {
    const logsContainer = document.getElementById('terminalLogs');
    const entry = document.createElement('div');
    
    let colorClass = 'text-gray-300';
    let icon = 'ℹ';
    if (level === 'success') { colorClass = 'text-emerald-400 font-semibold'; icon = '✓'; }
    else if (level === 'error') { colorClass = 'text-rose-400 font-semibold'; icon = '✗'; }
    else if (level === 'warning') { colorClass = 'text-amber-400'; icon = '⚠'; }

    entry.className = `flex items-start space-x-2 ${colorClass}`;
    entry.innerHTML = `<span class="text-gray-600 shrink-0 font-mono">[${timestamp}]</span> <span>${icon} ${escapeHtml(message)}</span>`;
    
    logsContainer.appendChild(entry);
    logsContainer.scrollTop = logsContainer.scrollHeight;
}

function clearLogs() {
    document.getElementById('terminalLogs').innerHTML = '<div class="text-gray-500">// Activity log cleared.</div>';
}

// ==========================================
// AI Marketing Copy Generator Modals
// ==========================================
function openMarketingModal() {
    document.getElementById('marketingModal').classList.remove('hidden');
    lucide.createIcons();
}

function closeMarketingModal() {
    document.getElementById('marketingModal').classList.add('hidden');
}

async function generateMarketingCopy() {
    const topic = document.getElementById('mktTopic').value;
    const business_name = document.getElementById('mktBizName').value.trim();
    const offer = document.getElementById('mktOffer').value.trim();
    const tone = document.getElementById('mktTone').value;

    const container = document.getElementById('mktResultsContainer');
    container.innerHTML = '<p class="text-xs text-purple-400 py-6 text-center animate-pulse">Generating high-converting marketing copy...</p>';

    try {
        const res = await fetch('/api/marketing/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ topic, business_name, offer, tone })
        });
        const data = await res.json();
        if (data.success && data.templates) {
            container.innerHTML = data.templates.map((tpl, idx) => `
                <div class="p-3 bg-purple-950/30 rounded-lg border border-purple-800/40 space-y-2">
                    <div class="flex items-center justify-between">
                        <span class="text-[10px] font-mono font-bold uppercase text-purple-300">Option #${idx + 1} (${data.topic.toUpperCase()}):</span>
                        <button onclick="applyMarketingTemplate(${idx})" class="px-2.5 py-1 bg-purple-600 hover:bg-purple-500 text-white rounded text-xs font-semibold transition">Use Template</button>
                    </div>
                    <p id="mkt-tpl-${idx}" class="text-xs text-gray-200 font-sans leading-relaxed italic bg-black/30 p-2 rounded">${escapeHtml(tpl)}</p>
                </div>
            `).join('');
            lucide.createIcons();
        }
    } catch (e) {
        container.innerHTML = `<p class="text-xs text-rose-400 py-4 text-center">Error: ${e.message}</p>`;
    }
}

function applyMarketingTemplate(idx) {
    const el = document.getElementById(`mkt-tpl-${idx}`);
    if (el) {
        document.getElementById('messageTemplate').value = el.innerText;
        updateTemplatePreview();
        closeMarketingModal();
        appendLog(new Date().toLocaleTimeString(), 'info', '✓ Applied marketing copy template to editor.');
    }
}

// ==========================================
// Templates Management Modals
// ==========================================
function openTemplatesModal() {
    document.getElementById('templatesModal').classList.remove('hidden');
    renderTemplatesList();
    lucide.createIcons();
}

function closeTemplatesModal() {
    document.getElementById('templatesModal').classList.add('hidden');
}

function renderTemplatesList() {
    const container = document.getElementById('templatesListContainer');
    if (!container) return;

    if (!appState.templates || appState.templates.length === 0) {
        container.innerHTML = '<p class="text-xs text-gray-500 py-4 text-center">No saved templates yet.</p>';
        return;
    }

    container.innerHTML = appState.templates.map(t => `
        <div class="p-3 bg-gray-900 rounded-lg border border-gray-800 hover:border-gray-700 transition flex items-center justify-between">
            <div class="space-y-1 flex-1 pr-4">
                <div class="flex items-center space-x-2">
                    <span class="text-xs font-bold text-white">${escapeHtml(t.name)}</span>
                    <span class="text-[10px] bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded font-mono">${escapeHtml(t.category || 'General')}</span>
                </div>
                <p class="text-xs text-gray-400 line-clamp-2 italic">${escapeHtml(t.content)}</p>
            </div>
            <div class="flex items-center space-x-1.5">
                <button onclick="applyTemplate('${t.id}')" class="px-2.5 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded text-xs font-semibold transition">Use</button>
                <button onclick="deleteTemplate('${t.id}')" class="p-1 text-gray-500 hover:text-rose-400 transition"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
            </div>
        </div>
    `).join('');
    lucide.createIcons();
}

async function saveCurrentTemplate() {
    const name = document.getElementById('newTemplateName').value.trim();
    const category = document.getElementById('newTemplateCategory').value.trim() || 'General';
    const content = document.getElementById('messageTemplate').value.trim();

    if (!name || !content) {
        alert('Please enter a template name and ensure the message composer is not empty.');
        return;
    }

    try {
        const res = await fetch('/api/templates', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, category, content })
        });
        const data = await res.json();
        if (data.success) {
            document.getElementById('newTemplateName').value = '';
            appendLog(new Date().toLocaleTimeString(), 'success', `✓ Saved template: '${name}'`);
        }
    } catch (e) {
        alert('Failed to save template: ' + e.message);
    }
}

function applyTemplate(templateId) {
    const tpl = appState.templates.find(t => t.id === templateId);
    if (tpl) {
        document.getElementById('messageTemplate').value = tpl.content;
        updateTemplatePreview();
        closeTemplatesModal();
        appendLog(new Date().toLocaleTimeString(), 'info', `Applied template: '${tpl.name}'`);
    }
}

async function deleteTemplate(templateId) {
    if (confirm('Delete this template?')) {
        await fetch(`/api/templates/${templateId}`, { method: 'DELETE' });
    }
}

// ==========================================
// DNC Blacklist Modals
// ==========================================
function openBlacklistModal() {
    document.getElementById('blacklistModal').classList.remove('hidden');
    renderBlacklistTable();
    lucide.createIcons();
}

function closeBlacklistModal() {
    document.getElementById('blacklistModal').classList.add('hidden');
}

function renderBlacklistTable() {
    const tbody = document.getElementById('blacklistTableBody');
    if (!tbody) return;

    if (!appState.blacklist || appState.blacklist.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="text-center py-6 text-gray-500 font-sans">No numbers in DNC blacklist.</td></tr>';
        return;
    }

    tbody.innerHTML = appState.blacklist.map(b => `
        <tr class="hover:bg-gray-800/40">
            <td class="py-2 px-3 text-rose-400 font-mono font-bold">${b.phone}</td>
            <td class="py-2 px-3 text-gray-300 font-sans">${escapeHtml(b.reason)}</td>
            <td class="py-2 px-3 text-gray-500 font-mono text-[11px]">${b.added_at}</td>
            <td class="py-2 px-3 text-right">
                <button onclick="removeBlacklistEntry('${encodeURIComponent(b.phone)}')" class="text-xs text-gray-500 hover:text-rose-400 transition font-semibold">Remove</button>
            </td>
        </tr>
    `).join('');
}

async function addBlacklistEntry() {
    const phone = document.getElementById('blacklistPhoneInput').value.trim();
    const reason = document.getElementById('blacklistReasonInput').value.trim() || 'Opted-out';

    if (!phone) {
        alert('Please enter a phone number.');
        return;
    }

    try {
        const res = await fetch('/api/blacklist', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, reason })
        });
        const data = await res.json();
        if (data.success) {
            document.getElementById('blacklistPhoneInput').value = '';
            appendLog(new Date().toLocaleTimeString(), 'warning', `Added ${data.entry.phone} to DNC Blacklist.`);
        }
    } catch (e) {
        alert('Failed to add number to blacklist: ' + e.message);
    }
}

async function removeBlacklistEntry(phone) {
    await fetch(`/api/blacklist/${phone}`, { method: 'DELETE' });
    appendLog(new Date().toLocaleTimeString(), 'info', `Removed ${decodeURIComponent(phone)} from Blacklist.`);
}

// ==========================================
// Spintax Preview Modal
// ==========================================
async function openSpintaxPreviewModal() {
    const template = document.getElementById('messageTemplate').value.trim();
    if (!template) {
        alert('Please enter a template with Spintax like {Hello|Hi|Hey} first.');
        return;
    }

    document.getElementById('spintaxModal').classList.remove('hidden');
    const container = document.getElementById('spintaxVariationsList');
    container.innerHTML = '<p class="text-xs text-gray-400 py-4 text-center animate-pulse">Generating Spintax variations...</p>';

    let sample = { name: 'John Doe', phone: '+1 (256) 625-5444' };
    if (appState.contacts.length > 0) {
        sample = { name: appState.contacts[0].name || 'Recipient', phone: appState.contacts[0].phone };
    }

    try {
        const res = await fetch('/api/spintax/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ template, sample, count: 5 })
        });
        const data = await res.json();
        if (data.success && data.variations) {
            container.innerHTML = data.variations.map((v, i) => `
                <div class="p-3 bg-indigo-950/40 rounded-lg border border-indigo-800/40 text-xs text-indigo-100 font-sans space-y-1">
                    <span class="text-[10px] font-mono text-indigo-400 font-bold uppercase tracking-wider">Variation #${i + 1}:</span>
                    <p class="italic text-gray-200">${escapeHtml(v)}</p>
                </div>
            `).join('');
        }
    } catch (e) {
        container.innerHTML = `<p class="text-xs text-rose-400 py-4 text-center">Error: ${e.message}</p>`;
    }

    lucide.createIcons();
}

function closeSpintaxPreviewModal() {
    document.getElementById('spintaxModal').classList.add('hidden');
}

// Utilities
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>'"]/g, tag => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;'
    }[tag] || tag));
}

function downloadSampleCSV() {
    const csvContent = "data:text/csv;charset=utf-8,phone,name,company\n+12566255444,John Doe,Acme Corp\n+13468591090,Alice Smith,Design Co\n";
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "sample_contacts.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}
