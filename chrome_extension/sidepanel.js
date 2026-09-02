/**
 * Google Messages SMS Bulk Automator - Side Panel Script
 */

let state = {
    contacts: [],
    customColumns: ['name', 'phone'],
    isRunning: false,
    isPaused: false,
    stopRequested: false,
    activeTabId: null
};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    initTabStatus();
    initEventListeners();
    updateTemplatePreview();
});

// 1. Tab Status & Connection
async function initTabStatus() {
    checkGoogleMessagesTab();
    // Re-check every 4 seconds
    setInterval(checkGoogleMessagesTab, 4000);
}

async function checkGoogleMessagesTab() {
    const badge = document.getElementById('tabStatusBadge');
    const notice = document.getElementById('tabNotice');

    try {
        const tabs = await chrome.tabs.query({ url: "*://messages.google.com/web*" });
        if (tabs && tabs.length > 0) {
            state.activeTabId = tabs[0].id;
            badge.className = 'badge badge-emerald';
            badge.innerText = 'Connected';
            notice.style.display = 'none';
        } else {
            state.activeTabId = null;
            badge.className = 'badge badge-amber';
            badge.innerText = 'No Tab Open';
            notice.style.display = 'flex';
        }
    } catch (e) {
        badge.className = 'badge badge-rose';
        badge.innerText = 'Error';
    }
}

// 2. Event Listeners Setup
function initEventListeners() {
    // Open Google Messages tab button
    document.getElementById('btnOpenMessages').addEventListener('click', () => {
        chrome.tabs.create({ url: 'https://messages.google.com/web' });
    });

    // Tab switching (Upload / Paste)
    document.getElementById('btnTabUpload').addEventListener('click', () => switchTab('upload'));
    document.getElementById('btnTabManual').addEventListener('click', () => switchTab('manual'));

    // Dropzone & File Input
    const dropzone = document.getElementById('dropzone');
    const fileInput = document.getElementById('fileInput');

    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.style.borderColor = '#3b82f6'; });
    dropzone.addEventListener('dragleave', () => { dropzone.style.borderColor = '#334155'; });
    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.style.borderColor = '#334155';
        if (e.dataTransfer.files.length > 0) {
            handleFileUpload(e.dataTransfer.files[0]);
        }
    });

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleFileUpload(e.target.files[0]);
        }
    });

    // Manual paste submit
    document.getElementById('btnLoadManual').addEventListener('click', handleManualSubmit);

    // Message template typing & preview
    const templateInput = document.getElementById('messageTemplate');
    templateInput.addEventListener('input', updateTemplatePreview);

    // Dynamic Tag Pills clicks
    document.getElementById('tagPillsContainer').addEventListener('click', (e) => {
        if (e.target.classList.contains('tag-pill')) {
            insertTag(e.target.getAttribute('data-tag'));
        }
    });

    // Preset delay buttons
    document.querySelectorAll('.preset-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const min = e.currentTarget.getAttribute('data-min');
            const max = e.currentTarget.getAttribute('data-max');
            setDelayPreset(min, max);
        });
    });

    // Campaign Actions
    document.getElementById('btnStart').addEventListener('click', startCampaign);
    document.getElementById('btnPause').addEventListener('click', pauseCampaign);
    document.getElementById('btnResume').addEventListener('click', resumeCampaign);
    document.getElementById('btnStop').addEventListener('click', stopCampaign);
    document.getElementById('btnReset').addEventListener('click', resetCampaign);
    document.getElementById('btnExport').addEventListener('click', exportCSV);
    document.getElementById('btnClearLog').addEventListener('click', () => {
        document.getElementById('terminal').innerHTML = '<div style="color: #64748b;">// Logs cleared.</div>';
    });
}

function switchTab(tab) {
    const btnUpload = document.getElementById('btnTabUpload');
    const btnManual = document.getElementById('btnTabManual');
    const viewUpload = document.getElementById('viewUpload');
    const viewManual = document.getElementById('viewManual');

    if (tab === 'upload') {
        btnUpload.className = 'btn btn-primary';
        btnManual.className = 'btn btn-secondary';
        viewUpload.style.display = 'block';
        viewManual.style.display = 'none';
    } else {
        btnManual.className = 'btn btn-primary';
        btnUpload.className = 'btn btn-secondary';
        viewManual.style.display = 'block';
        viewUpload.style.display = 'none';
    }
}

// 3. Contact File Parsing
function handleFileUpload(file) {
    log('info', `Reading file: ${file.name}...`);
    const reader = new FileReader();

    reader.onload = (e) => {
        const content = e.target.result;
        parseCSVContent(content, file.name);
    };
    reader.readAsText(file);
}

function parseCSVContent(csvText, filename = 'CSV') {
    const lines = csvText.split(/\r?\n/).filter(line => line.trim().length > 0);
    if (lines.length === 0) {
        log('error', 'Uploaded file is empty.');
        return;
    }

    // Check header
    const firstLine = lines[0];
    const hasHeader = firstLine.toLowerCase().includes('phone') || firstLine.toLowerCase().includes('number') || firstLine.toLowerCase().includes('name');

    let headers = ['phone', 'name'];
    let startIndex = 0;

    if (hasHeader) {
        headers = parseCSVLine(firstLine).map(h => h.toLowerCase().trim());
        startIndex = 1;
    }

    // Find phone and name column index
    let phoneIdx = headers.findIndex(h => h.includes('phone') || h.includes('mobile') || h.includes('tel') || h.includes('number'));
    if (phoneIdx === -1) phoneIdx = 0;

    let nameIdx = headers.findIndex(h => h.includes('name'));

    // Detect all columns for tag pills
    state.customColumns = headers;
    renderTagPills(headers);

    state.contacts = [];
    for (let i = startIndex; i < lines.length; i++) {
        const cols = parseCSVLine(lines[i]);
        if (!cols || cols.length === 0) continue;

        let rawPhone = (cols[phoneIdx] || '').trim();
        if (rawPhone.endsWith('.0')) rawPhone = rawPhone.slice(0, -2); // clean excel float
        let rawName = nameIdx !== -1 ? (cols[nameIdx] || '').trim() : '';

        // Build custom data map
        const customData = {};
        headers.forEach((h, idx) => {
            if (idx !== phoneIdx && idx !== nameIdx) {
                customData[h] = (cols[idx] || '').trim();
            }
        });

        if (rawPhone) {
            state.contacts.push({
                id: state.contacts.length + 1,
                phone: rawPhone,
                name: rawName,
                customData: customData,
                status: 'pending',
                message: '',
                sentAt: null,
                error: null
            });
        }
    }

    renderQueueTable();
    updateStats();
    updateTemplatePreview();
    log('success', `Loaded ${state.contacts.length} contacts from ${filename}`);
}

function parseCSVLine(line) {
    const result = [];
    let cur = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
            inQuotes = !inQuotes;
        } else if (c === ',' && !inQuotes) {
            result.push(cur.trim());
            cur = '';
        } else {
            cur += c;
        }
    }
    result.push(cur.trim());
    return result;
}

function handleManualSubmit() {
    const text = document.getElementById('manualInput').value;
    if (!text.trim()) return;

    parseCSVContent(text, 'Manual Input');
}

function renderTagPills(columns) {
    const container = document.getElementById('tagPillsContainer');
    container.innerHTML = '<span style="font-size: 10px; color: #64748b;">Tags:</span>';

    const uniqueCols = [...new Set(columns)];
    if (!uniqueCols.includes('name')) uniqueCols.unshift('name');
    if (!uniqueCols.includes('phone')) uniqueCols.unshift('phone');

    uniqueCols.forEach(col => {
        const btn = document.createElement('button');
        btn.className = 'tag-pill';
        btn.setAttribute('data-tag', `{${col}}`);
        btn.innerText = `{${col}}`;
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

// 4. Template & Preview
function updateTemplatePreview() {
    const template = document.getElementById('messageTemplate').value || 'Hello {name}, your appointment is confirmed!';
    const charCount = template.length;
    const smsSegments = Math.ceil(charCount / 160) || 1;
    document.getElementById('charCount').innerText = `${charCount} chars (${smsSegments} SMS)`;

    const sample = state.contacts.length > 0 ? state.contacts[0] : { name: 'John Doe', phone: '+1234567890', customData: {} };
    let preview = template;

    const replacements = {
        name: sample.name || 'John Doe',
        phone: sample.phone || '+1234567890',
        ...(sample.customData || {})
    };

    for (const [k, v] of Object.entries(replacements)) {
        const reg = new RegExp(`\\{${k}\\}`, 'gi');
        preview = preview.replace(reg, v);
    }

    document.getElementById('previewText').innerText = preview;
}

function formatMessageForContact(template, contact) {
    let msg = template;
    const replacements = {
        name: contact.name || '',
        phone: contact.phone || '',
        ...(contact.customData || {})
    };
    for (const [k, v] of Object.entries(replacements)) {
        const reg = new RegExp(`\\{${k}\\}`, 'gi');
        msg = msg.replace(reg, v);
    }
    return msg;
}

// 5. Campaign Execution
async function startCampaign() {
    if (state.isRunning) return;

    if (state.contacts.length === 0) {
        log('warning', 'Please load contacts first.');
        return;
    }

    // Ensure Google Messages tab is open
    const tabs = await chrome.tabs.query({ url: "*://messages.google.com/web*" });
    if (!tabs || tabs.length === 0) {
        log('error', 'Google Messages Web tab is not open! Click "Open Tab" above.');
        return;
    }
    state.activeTabId = tabs[0].id;

    const template = document.getElementById('messageTemplate').value || 'Hello {name}, your appointment is confirmed!';
    const minDelay = parseFloat(document.getElementById('minDelay').value) || 15;
    const maxDelay = parseFloat(document.getElementById('maxDelay').value) || 45;

    state.isRunning = true;
    state.isPaused = false;
    state.stopRequested = false;
    updateUIButtons();

    log('info', `🚀 Starting SMS campaign for ${state.contacts.length} contacts.`);
    log('info', `⏱ Delay interval: ${minDelay}s - ${maxDelay}s randomized anti-spam.`);

    for (let i = 0; i < state.contacts.length; i++) {
        if (state.stopRequested) {
            log('warning', 'Campaign stopped.');
            break;
        }

        while (state.isPaused) {
            await sleep(500);
            if (state.stopRequested) break;
        }
        if (state.stopRequested) break;

        const c = state.contacts[i];
        if (c.status === 'sent') continue;

        c.status = 'sending';
        c.message = formatMessageForContact(template, c);
        updateQueueRow(c);
        updateStats();

        log('info', `[${i + 1}/${state.contacts.length}] Sending to ${c.name || 'Recipient'} (${c.phone})...`);

        try {
            // Send command to content script in Google Messages tab
            const response = await chrome.tabs.sendMessage(state.activeTabId, {
                action: 'SEND_SMS',
                phone: c.phone,
                message: c.message
            });

            if (response && response.success) {
                c.status = 'sent';
                c.sentAt = new Date().toLocaleTimeString();
                log('success', `✓ Sent to ${c.phone}`);
            } else {
                c.status = 'failed';
                c.error = (response && response.error) || 'Failed to send';
                log('error', `✗ Failed to ${c.phone}: ${c.error}`);
            }
        } catch (err) {
            c.status = 'failed';
            c.error = err.message || 'Tab communication error';
            log('error', `✗ Error sending to ${c.phone}: ${c.error}`);
        }

        updateQueueRow(c);
        updateStats();

        // Random Delay before next contact if more pending
        const hasMore = state.contacts.slice(i + 1).some(x => x.status === 'pending');
        if (hasMore && !state.stopRequested) {
            const delaySec = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
            log('info', `⏳ Waiting ${delaySec}s before next SMS (Random Anti-Spam)...`);

            showCountdown(delaySec);
            for (let s = delaySec; s > 0; s--) {
                if (state.stopRequested) break;
                updateCountdown(s);
                await sleep(1000);
            }
            hideCountdown();
        }
    }

    state.isRunning = false;
    state.isPaused = false;
    updateUIButtons();
    updateStats();
    log('success', '🎉 Campaign finished!');
}

function pauseCampaign() {
    if (state.isRunning) {
        state.isPaused = true;
        updateUIButtons();
        log('info', 'Campaign paused.');
    }
}

function resumeCampaign() {
    if (state.isRunning && state.isPaused) {
        state.isPaused = false;
        updateUIButtons();
        log('info', 'Campaign resumed.');
    }
}

function stopCampaign() {
    state.stopRequested = true;
    state.isRunning = false;
    state.isPaused = false;
    hideCountdown();
    updateUIButtons();
}

function resetCampaign() {
    state.contacts.forEach(c => {
        c.status = 'pending';
        c.error = null;
        c.sentAt = null;
    });
    renderQueueTable();
    updateStats();
    hideCountdown();
    log('info', 'Reset all contacts back to pending.');
}

// 6. UI & State Updates
function updateUIButtons() {
    const btnStart = document.getElementById('btnStart');
    const btnPause = document.getElementById('btnPause');
    const btnResume = document.getElementById('btnResume');
    const btnStop = document.getElementById('btnStop');
    const statusLabel = document.getElementById('campaignStatusLabel');

    if (state.isRunning) {
        btnStart.style.display = 'none';
        btnStop.style.display = 'inline-flex';

        if (state.isPaused) {
            btnPause.style.display = 'none';
            btnResume.style.display = 'inline-flex';
            statusLabel.innerText = '⏸ Paused';
            statusLabel.style.color = '#fbbf24';
        } else {
            btnPause.style.display = 'inline-flex';
            btnResume.style.display = 'none';
            statusLabel.innerText = '🚀 Sending in progress...';
            statusLabel.style.color = '#34d399';
        }
    } else {
        btnStart.style.display = 'inline-flex';
        btnPause.style.display = 'none';
        btnResume.style.display = 'none';
        btnStop.style.display = 'none';
        statusLabel.innerText = 'Ready to send';
        statusLabel.style.color = '#94a3b8';
    }
}

function updateStats() {
    const total = state.contacts.length;
    const sent = state.contacts.filter(c => c.status === 'sent').length;
    const failed = state.contacts.filter(c => c.status === 'failed').length;
    const pending = state.contacts.filter(c => c.status === 'pending' || c.status === 'sending').length;

    document.getElementById('statTotal').innerText = total;
    document.getElementById('statSent').innerText = sent;
    document.getElementById('statFailed').innerText = failed;
    document.getElementById('statPending').innerText = pending;

    const pct = total > 0 ? (((sent + failed) / total) * 100).toFixed(1) : 0;
    document.getElementById('progressPercent').innerText = `${pct}%`;
    document.getElementById('progressBar').style.width = `${pct}%`;
    document.getElementById('queueCount').innerText = `${total} contacts`;
}

function renderQueueTable() {
    const tbody = document.getElementById('queueTbody');
    tbody.innerHTML = '';

    if (state.contacts.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: #64748b; padding: 12px 0;">No contacts loaded.</td></tr>';
        return;
    }

    state.contacts.forEach(c => {
        const tr = document.createElement('tr');
        tr.id = `q-row-${c.id}`;
        tr.innerHTML = getRowHtml(c);
        tbody.appendChild(tr);
    });
}

function updateQueueRow(c) {
    const row = document.getElementById(`q-row-${c.id}`);
    if (row) {
        row.innerHTML = getRowHtml(c);
    }
}

function getRowHtml(c) {
    let badgeClass = 'badge-gray';
    let label = 'Pending';

    if (c.status === 'sending') { badgeClass = 'badge-blue'; label = 'Sending...'; }
    else if (c.status === 'sent') { badgeClass = 'badge-emerald'; label = '✓ Sent'; }
    else if (c.status === 'failed') { badgeClass = 'badge-rose'; label = '✗ Failed'; }

    const titleAttr = c.error ? `title="${c.error}"` : '';

    return `
        <td style="color: #64748b;">${c.id}</td>
        <td style="color: #e2e8f0; font-weight: 500;">${c.name || '-'}</td>
        <td style="color: #60a5fa;">${c.phone}</td>
        <td><span class="badge ${badgeClass}" ${titleAttr}>${label}</span></td>
    `;
}

function showCountdown(sec) {
    const banner = document.getElementById('countdownBanner');
    banner.style.display = 'flex';
    document.getElementById('countdownTimer').innerText = `${sec}s`;
}

function updateCountdown(sec) {
    document.getElementById('countdownTimer').innerText = `${sec}s`;
}

function hideCountdown() {
    document.getElementById('countdownBanner').style.display = 'none';
}

function setDelayPreset(min, max) {
    document.getElementById('minDelay').value = min;
    document.getElementById('maxDelay').value = max;
    log('info', `Delay preset set: ${min}s to ${max}s`);
}

function log(level, message) {
    const term = document.getElementById('terminal');
    const div = document.createElement('div');
    const time = new Date().toLocaleTimeString();

    let color = '#94a3b8';
    if (level === 'success') color = '#34d399';
    else if (level === 'error') color = '#f87171';
    else if (level === 'warning') color = '#fbbf24';

    div.innerHTML = `<span style="color: #64748b;">[${time}]</span> <span style="color: ${color};">${message}</span>`;
    term.appendChild(div);
    term.scrollTop = term.scrollHeight;
}

function exportCSV() {
    if (state.contacts.length === 0) {
        log('warning', 'No contacts to export.');
        return;
    }

    let csv = 'ID,Phone,Name,Message,Status,SentAt,Error\n';
    state.contacts.forEach(c => {
        csv += `${c.id},"${c.phone}","${c.name}","${c.message.replace(/"/g, '""')}","${c.status}","${c.sentAt || ''}","${(c.error || '').replace(/"/g, '""')}"\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sms_report_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    log('success', 'Exported campaign results to CSV.');
}
