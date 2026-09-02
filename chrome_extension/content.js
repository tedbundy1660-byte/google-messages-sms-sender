/**
 * Google Messages SMS Bulk Automator - Content Script
 * Executes directly within https://messages.google.com/web
 */

// Utility sleep helper
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Dismiss modal overlays / prompts (e.g. "Got it", "OK", "Dismiss")
function dismissPopups() {
    const popups = document.querySelectorAll('button');
    for (const btn of popups) {
        const txt = (btn.innerText || '').trim().toLowerCase();
        if (['got it', 'ok', 'dismiss', 'continue', 'not now'].includes(txt)) {
            if (btn.offsetWidth > 0 && btn.offsetHeight > 0) {
                btn.click();
            }
        }
    }
}

// Find element with polling
async function waitForElement(selectors, timeoutMs = 8000) {
    const start = Date.now();
    const selectorList = Array.isArray(selectors) ? selectors : [selectors];

    while (Date.now() - start < timeoutMs) {
        for (const sel of selectorList) {
            try {
                const el = document.querySelector(sel);
                if (el && (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0)) {
                    return el;
                }
            } catch (e) {
                // Invalid selector syntax fallback
            }
        }
        await sleep(250);
    }
    return null;
}

// Full mouse/pointer event dispatcher
function simulateClick(el) {
    if (!el) return;
    el.focus?.();
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
    el.click?.();
}

// Type value with native input event triggers
function simulateInput(inputEl, text) {
    inputEl.focus();
    inputEl.value = text;
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
}

// Check if user is logged into Google Messages Web
function checkPageStatus() {
    const isMessagesUrl = window.location.href.includes('messages.google.com/web');
    if (!isMessagesUrl) {
        return { isReady: false, reason: 'Not on Google Messages Web tab' };
    }

    const startChatBtn = document.querySelector('a[data-e2e-start-chat], a[href*="start-chat"], button:has-text("Start chat"), mws-fab a');
    const convList = document.querySelector('mws-conversations-list, div[role="list"]');
    const qrCode = document.querySelector('mw-qr-code, qr-code, img[alt*="QR"]');

    if (qrCode) {
        return { isReady: false, reason: 'Google Messages requires QR code pairing' };
    }

    if (startChatBtn || convList || window.location.href.includes('conversations')) {
        return { isReady: true, reason: 'Google Messages is ready' };
    }

    return { isReady: false, reason: 'Loading Google Messages...' };
}

// Core SMS Sender function
async function sendSms(phone, message) {
    dismissPopups();

    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const last7 = cleanPhone.slice(-7);

    // 1. Check if conversation is already in sidebar
    let sidebarOpened = false;
    const sidebarItems = document.querySelectorAll('mws-conversation-list-item, a[href*="/web/conversations/"]');
    for (const item of sidebarItems) {
        const txt = (item.innerText || '').replace(/[^0-9]/g, '');
        if (last7 && txt.includes(last7)) {
            simulateClick(item);
            sidebarOpened = true;
            await sleep(1200);
            break;
        }
    }

    if (!sidebarOpened) {
        // 2. Click "Start chat"
        const startChatSelectors = [
            'a[data-e2e-start-chat]',
            'a[href*="start-chat"]',
            'a[href*="/web/conversations/new"]',
            'mws-fab a',
            'mws-fab button',
            'button[aria-label*="Start chat" i]',
            'a[aria-label*="Start chat" i]'
        ];

        let startChatBtn = await waitForElement(startChatSelectors, 4000);
        if (startChatBtn) {
            simulateClick(startChatBtn);
            await sleep(1000);
        } else if (!window.location.href.includes('/new')) {
            window.location.href = 'https://messages.google.com/web/conversations/new';
            await sleep(1500);
        }

        // 3. Find recipient search input
        const recipientSelectors = [
            'input[data-e2e-contact-input]',
            'input[placeholder*="name, phone" i]',
            'input[placeholder*="phone number" i]',
            'input[placeholder*="Type a name" i]',
            'input[aria-label*="recipient" i]',
            'input[aria-label*="phone number" i]',
            'mws-contact-picker input',
            'input[type="text"]',
            'input'
        ];

        const recipientInput = await waitForElement(recipientSelectors, 6000);
        if (!recipientInput) {
            return { success: false, error: 'Could not find recipient search input field' };
        }

        // Type recipient number
        recipientInput.focus();
        recipientInput.value = '';
        simulateInput(recipientInput, phone);
        await sleep(1200);

        // 4. Select contact from suggestion list (run adaptive loop)
        let composerFound = null;
        for (let attempt = 1; attempt <= 6; attempt++) {
            composerFound = findComposer();
            if (composerFound) break;

            // Strategy A: Click elements matching 'Send to'
            const candidateItems = document.querySelectorAll('mws-contact-list-item, [role="option"], mat-list-item, div.contact, button, div');
            for (const el of candidateItems) {
                const txt = (el.innerText || '').trim();
                if (txt.includes('Send to') && el.offsetHeight > 15 && el.offsetHeight < 150) {
                    simulateClick(el);
                }
            }

            // Strategy B: Keyboard ArrowDown + Enter
            recipientInput.focus();
            recipientInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, bubbles: true }));
            await sleep(150);
            recipientInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
            await sleep(150);
            recipientInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));

            await sleep(800);
            dismissPopups();
        }
    }

    // 5. Find message composer
    const composer = await waitForComposer(6000);
    if (!composer) {
        return { success: false, error: 'Could not locate message composer input' };
    }

    // 6. Enter message into composer
    composer.focus();
    await sleep(200);

    const isContentEditable = composer.getAttribute('contenteditable') === 'true' || composer.tagName.toLowerCase() === 'div';
    if (isContentEditable) {
        composer.innerText = message;
        document.execCommand('insertText', false, message);
        composer.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
        composer.value = message;
        composer.dispatchEvent(new Event('input', { bubbles: true }));
        composer.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await sleep(600);

    // 7. Click Send Button
    const sendButtonSelectors = [
        'button[data-e2e-send-text-button]',
        'button[aria-label*="Send SMS" i]',
        'button[aria-label*="Send RCS" i]',
        'button[aria-label*="Send message" i]',
        'button[aria-label*="Send" i]',
        'mws-message-send-button button',
        'mws-message-send-button',
        'div[data-e2e-send-text-button]'
    ];

    let sendBtn = null;
    for (const sel of sendButtonSelectors) {
        const btn = document.querySelector(sel);
        if (btn && (btn.offsetWidth > 0 || btn.offsetHeight > 0) && !btn.disabled) {
            sendBtn = btn;
            break;
        }
    }

    if (sendBtn) {
        simulateClick(sendBtn);
    } else {
        // Fallback: Press Enter key in composer
        composer.focus();
        composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    }

    await sleep(2500);

    // 8. Check for any error notices
    const errorNotices = document.querySelectorAll('div, span');
    for (const notice of errorNotices) {
        const t = (notice.innerText || '').toLowerCase();
        if (t.includes('trouble sending') || t.includes('message not sent') || t.includes('failed to send') || t.includes('not delivered')) {
            if (notice.offsetWidth > 0 && notice.offsetHeight > 0) {
                return { success: false, error: notice.innerText.trim() };
            }
        }
    }

    return { success: true };
}

function findComposer() {
    const composerSelectors = [
        'mws-autosize-textarea textarea',
        'mws-message-compose textarea',
        'textarea[data-e2e-message-input-box]',
        'textarea[aria-label*="message" i]',
        'textarea[aria-label*="SMS" i]',
        'textarea[aria-label*="Text" i]',
        'textarea[aria-label*="RCS" i]',
        'textarea[placeholder*="message" i]',
        'textarea[placeholder*="SMS" i]',
        'textarea[placeholder*="Text" i]',
        'div[contenteditable="true"][aria-label*="message" i]',
        'div[contenteditable="true"]',
        '[role="textbox"]',
        'textarea'
    ];

    for (const sel of composerSelectors) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
            if (el && (el.offsetWidth > 0 || el.offsetHeight > 0)) {
                return el;
            }
        }
    }
    return null;
}

async function waitForComposer(timeoutMs = 6000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const comp = findComposer();
        if (comp) return comp;
        await sleep(300);
    }
    return null;
}

// Listen for messages from Side Panel
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'CHECK_STATUS') {
        sendResponse(checkPageStatus());
        return true;
    }

    if (request.action === 'SEND_SMS') {
        sendSms(request.phone, request.message).then(sendResponse);
        return true; // Asynchronous response
    }
});
