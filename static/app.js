// State Management
let appState = {
    contacts: [],
    stats: {},
    pairing: { is_paired: false, browser_running: false, status_text: 'Disconnected' },
    logs: [],
    customHeaders: ['name', 'phone']
};

let ws = null;
let countdownInterval = null;

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    lucide.createIcons();
    connectWebSocket();
    fetchInitialStatus();
    updateTemplatePreview();

    // Setup drag & drop
    const dropzone = document.getElementById('dropzone');
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
});

// WebSocket Setup
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
            appState.pairing = msg.data.pairing || {};
            if (msg.data.logs) {
                msg.data.logs.forEach(l => appendLog(l.timestamp, l.level, l.message));
            }
            updatePairingUI();
            updateStatsUI();
            renderContactsTable();
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

        case 'countdown':
            handleCountdown(msg.data.seconds, msg.data.reason);
            break;

        case 'log':
            appendLog(msg.data.timestamp, msg.data.level, msg.data.message);
            break;
    }
}

// Pairing Management
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
    } catch (e) {
        console.error('Error closing browser:', e);
    }
}

function updatePairingUI() {
    const badge = document.getElementById('pairingBadge');
    const dot = document.getElementById('pairingDot');
    const text = document.getElementById('pairingText');

    if (appState.pairing.is_paired) {
        badge.className = 'flex items-center space-x-2 px-3 py-1.5 rounded-full bg-emerald-950/80 border border-emerald-600/50 text-xs text-emerald-300';
        dot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400 pulse-active';
        text.innerText = 'Connected & Paired';
    } else if (appState.pairing.browser_running) {
        badge.className = 'flex items-center space-x-2 px-3 py-1.5 rounded-full bg-amber-950/80 border border-amber-600/50 text-xs text-amber-300';
        dot.className = 'w-2.5 h-2.5 rounded-full bg-amber-400 pulse-active';
        text.innerText = appState.pairing.status_text || 'Pairing in Progress...';
    } else {
        badge.className = 'flex items-center space-x-2 px-3 py-1.5 rounded-full bg-gray-800/80 border border-gray-700 text-xs text-gray-300';
        dot.className = 'w-2.5 h-2.5 rounded-full bg-gray-500';
        text.innerText = 'Disconnected';
    }
}

// Contacts Management
function switchContactTab(tab) {
    const uploadBtn = document.getElementById('tabUploadBtn');
    const manualBtn = document.getElementById('tabManualBtn');
    const uploadContent = document.getElementById('tabUploadContent');
    const manualContent = document.getElementById('tabManualContent');

    if (tab === 'upload') {
        uploadBtn.className = 'px-2.5 py-1 rounded bg-blue-600 text-white font-medium';
        manualBtn.className = 'px-2.5 py-1 rounded text-gray-400 hover:text-white';
        uploadContent.classList.remove('hidden');
        manualContent.classList.add('hidden');
    } else {
        manualBtn.className = 'px-2.5 py-1 rounded bg-blue-600 text-white font-medium';
        uploadBtn.className = 'px-2.5 py-1 rounded text-gray-400 hover:text-white';
        manualContent.classList.remove('hidden');
        uploadContent.classList.add('hidden');
    }
}

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
    if (template) {
        formData.append('template', template);
    }

    appendLog(new Date().toLocaleTimeString(), 'info', `Uploading '${file.name}'...`);

    try {
        const res = await fetch('/api/contacts/upload', {
            method: 'POST',
            body: formData
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Upload failed');

        appState.contacts = data.contacts;
        if (data.columns) {
            updateTagPills(data.columns);
        }
        renderContactsTable();
        updateTemplatePreview();
        appendLog(new Date().toLocaleTimeString(), 'success', `Loaded ${data.count} contacts from ${file.name}`);
    } catch (e) {
        appendLog(new Date().toLocaleTimeString(), 'error', `Upload error: ${e.message}`);
    }
}

async function handleManualSubmit() {
    const text = document.getElementById('manualTextInput').value;
    if (!text.trim()) return;

    const template = document.getElementById('messageTemplate').value;
    try {
        const res = await fetch('/api/contacts/manual', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, template })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Failed to load contacts');

        appState.contacts = data.contacts;
        renderContactsTable();
        updateTemplatePreview();
        appendLog(new Date().toLocaleTimeString(), 'success', `Loaded ${data.count} contacts.`);
    } catch (e) {
        appendLog(new Date().toLocaleTimeString(), 'error', e.message);
    }
}

function updateTagPills(columns) {
    const container = document.getElementById('tagPills');
    container.innerHTML = '';

    const cols = columns.map(c => c.toLowerCase());
    if (!cols.includes('name')) cols.unshift('name');
    if (!cols.includes('phone')) cols.unshift('phone');

    const uniqueCols = [...new Set(cols)];
    uniqueCols.forEach(col => {
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

function updateTemplatePreview() {
    const template = document.getElementById('messageTemplate').value || 'Hello {name}, your appointment is confirmed!';
    const charCount = template.length;
    const smsCount = Math.ceil(charCount / 160) || 1;
    document.getElementById('charCounter').innerText = `${charCount} chars (${smsCount} SMS segment${smsCount > 1 ? 's' : ''})`;

    const sampleContact = appState.contacts.length > 0 ? appState.contacts[0] : { phone: '+1234567890', name: 'John Doe', custom_data: {} };
    document.getElementById('previewRecipient').innerText = sampleContact.phone || '+1234567890';

    let preview = template;
    const replacements = {
        name: sampleContact.name || 'John Doe',
        phone: sampleContact.phone || '+1234567890',
        ...(sampleContact.custom_data || {})
    };

    for (const [key, val] of Object.entries(replacements)) {
        const regex = new RegExp(`\\{${key}\\}`, 'gi');
        preview = preview.replace(regex, val);
    }

    document.getElementById('previewText').innerText = preview;
}

// Preset Delays
function setDelayPreset(min, max) {
    document.getElementById('minDelayInput').value = min;
    document.getElementById('maxDelayInput').value = max;
    appendLog(new Date().toLocaleTimeString(), 'info', `Delay preset applied: ${min}s - ${max}s`);
}

// Campaign Execution
async function startCampaign() {
    const minDelay = parseFloat(document.getElementById('minDelayInput').value) || 15;
    const maxDelay = parseFloat(document.getElementById('maxDelayInput').value) || 45;
    const template = document.getElementById('messageTemplate').value;
    const batchSize = parseInt(document.getElementById('batchSizeInput').value) || 0;
    const batchDelay = parseFloat(document.getElementById('batchDelayInput').value) || 120;

    const payload = {
        min_delay_seconds: minDelay,
        max_delay_seconds: maxDelay,
        message_template: template,
        batch_size: batchSize,
        batch_delay_seconds: batchDelay,
        headless: false
    };

    try {
        const res = await fetch('/api/campaign/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Failed to start');
    } catch (e) {
        appendLog(new Date().toLocaleTimeString(), 'error', `Cannot start campaign: ${e.message}`);
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
    hideCountdown();
}

async function resetCampaign() {
    await fetch('/api/campaign/reset', { method: 'POST' });
    hideCountdown();
}

// Stats and UI Updates
function updateStatsUI() {
    const stats = appState.stats;
    document.getElementById('statTotal').innerText = stats.total || 0;
    document.getElementById('statSent').innerText = stats.sent || 0;
    document.getElementById('statFailed').innerText = stats.failed || 0;
    document.getElementById('statPending').innerText = stats.pending || 0;

    const pct = (stats.progress_percent || 0).toFixed(1);
    document.getElementById('progressPercent').innerText = `${pct}%`;
    document.getElementById('progressBar').style.width = `${pct}%`;

    // Button Visibility
    const btnStart = document.getElementById('btnStart');
    const btnPause = document.getElementById('btnPause');
    const btnResume = document.getElementById('btnResume');
    const btnStop = document.getElementById('btnStop');
    const statusLabel = document.getElementById('campaignStatusLabel');

    if (stats.is_running) {
        btnStart.classList.add('hidden');
        btnStop.classList.remove('hidden');

        if (stats.is_paused) {
            btnPause.classList.add('hidden');
            btnResume.classList.remove('hidden');
            statusLabel.innerText = '⏸ Campaign Paused';
            statusLabel.className = 'text-amber-400 font-medium';
        } else {
            btnPause.classList.remove('hidden');
            btnResume.classList.add('hidden');
            statusLabel.innerText = `🚀 Sending... (${stats.current_index}/${stats.total})`;
            statusLabel.className = 'text-emerald-400 font-medium animate-pulse';
        }
    } else {
        btnStart.classList.remove('hidden');
        btnPause.classList.add('hidden');
        btnResume.classList.add('hidden');
        btnStop.classList.add('hidden');

        if (stats.total > 0 && stats.pending === 0) {
            statusLabel.innerText = '✓ Campaign Finished';
            statusLabel.className = 'text-blue-400 font-medium';
            hideCountdown();
        } else {
            statusLabel.innerText = 'Ready to start';
            statusLabel.className = 'text-gray-400 font-medium';
        }
    }
}

// Countdown Banner
function handleCountdown(seconds, reason) {
    const banner = document.getElementById('countdownBanner');
    const msg = document.getElementById('countdownMessage');
    const timer = document.getElementById('countdownTimer');

    banner.classList.remove('hidden');
    msg.innerText = reason === 'batch_pause' ? 'Batch cooldown pause in progress...' : 'Anti-Spam Random Delay active...';
    timer.innerText = `${seconds}s`;

    if (seconds <= 1) {
        setTimeout(hideCountdown, 1000);
    }
}

function hideCountdown() {
    document.getElementById('countdownBanner').classList.add('hidden');
}

// Contacts Table Rendering
function renderContactsTable() {
    const tbody = document.getElementById('contactsTableBody');
    const filter = document.getElementById('statusFilter').value;
    const search = document.getElementById('contactSearch').value.toLowerCase();

    tbody.innerHTML = '';

    const filtered = appState.contacts.filter(c => {
        if (filter !== 'all' && c.status !== filter) return false;
        if (search) {
            const matchesPhone = c.phone && c.phone.toLowerCase().includes(search);
            const matchesName = c.name && c.name.toLowerCase().includes(search);
            return matchesPhone || matchesName;
        }
        return true;
    });

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="text-center py-6 text-gray-500 font-sans">No matching contacts found.</td></tr>`;
        return;
    }

    filtered.forEach(c => {
        const row = createContactRowElement(c);
        tbody.appendChild(row);
    });
}

function createContactRowElement(c) {
    const tr = document.createElement('tr');
    tr.id = `contact-row-${c.id}`;
    tr.className = 'hover:bg-gray-800/40 transition';

    let statusBadge = '';
    switch (c.status) {
        case 'pending':
            statusBadge = '<span class="px-2 py-0.5 rounded text-[11px] bg-gray-800 text-gray-400 border border-gray-700">Pending</span>';
            break;
        case 'sending':
            statusBadge = '<span class="px-2 py-0.5 rounded text-[11px] bg-blue-900/60 text-blue-300 border border-blue-600 pulse-active font-bold">Sending...</span>';
            break;
        case 'sent':
            statusBadge = '<span class="px-2 py-0.5 rounded text-[11px] bg-emerald-950/80 text-emerald-400 border border-emerald-600 font-semibold">✓ Sent</span>';
            break;
        case 'failed':
            statusBadge = '<span class="px-2 py-0.5 rounded text-[11px] bg-rose-950/80 text-rose-400 border border-rose-600 font-semibold">✗ Failed</span>';
            break;
        case 'skipped':
            statusBadge = '<span class="px-2 py-0.5 rounded text-[11px] bg-amber-950/80 text-amber-400 border border-amber-600">Skipped</span>';
            break;
    }

    const detail = c.sent_at ? `<span class="text-gray-400">${c.sent_at}</span>` : (c.error ? `<span class="text-rose-400" title="${c.error}">${c.error.length > 25 ? c.error.substring(0, 22) + '...' : c.error}</span>` : '-');

    const msgPreview = c.message ? (c.message.length > 30 ? c.message.substring(0, 27) + '...' : c.message) : '-';

    tr.innerHTML = `
        <td class="py-2.5 px-3 text-gray-500">${c.id}</td>
        <td class="py-2.5 px-3 font-medium text-gray-200">${c.name || '<span class="text-gray-500 italic">No Name</span>'}</td>
        <td class="py-2.5 px-3 text-blue-400 font-bold">${c.phone}</td>
        <td class="py-2.5 px-3 text-gray-400 font-sans truncate max-w-[140px]" title="${c.message || ''}">${msgPreview}</td>
        <td class="py-2.5 px-3">${statusBadge}</td>
        <td class="py-2.5 px-3 text-[11px] font-mono">${detail}</td>
    `;
    return tr;
}

function updateContactRow(contact) {
    const existingRow = document.getElementById(`contact-row-${contact.id}`);
    if (existingRow) {
        const newRow = createContactRowElement(contact);
        existingRow.replaceWith(newRow);
    }
}

function filterContactsTable() {
    renderContactsTable();
}

// Logging
function appendLog(timestamp, level, message) {
    const term = document.getElementById('terminalLogs');
    const div = document.createElement('div');
    div.className = 'flex items-start space-x-2 text-[11px] leading-tight';

    let color = 'text-gray-300';
    let icon = 'ℹ';
    if (level === 'success') { color = 'text-emerald-400'; icon = '✓'; }
    else if (level === 'error') { color = 'text-rose-400'; icon = '✗'; }
    else if (level === 'warning') { color = 'text-amber-400'; icon = '⚠'; }

    div.innerHTML = `
        <span class="text-gray-500 select-none">[${timestamp}]</span>
        <span class="${color} font-bold">${icon}</span>
        <span class="${color} flex-1 break-words">${message}</span>
    `;

    term.appendChild(div);
    term.scrollTop = term.scrollHeight;
}

function clearLogs() {
    document.getElementById('terminalLogs').innerHTML = '<div class="text-gray-500">// Logs cleared.</div>';
}

// Sample CSV Download
function downloadSampleCSV() {
    const csvContent = "data:text/csv;charset=utf-8," 
        + "phone,name,custom_field\n"
        + "+12345678901,Alice Johnson,VIP\n"
        + "+12345678902,Bob Smith,Standard\n"
        + "+12345678903,Charlie Brown,Premium\n";
    
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "sample_contacts.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}
