/**
 * Google Messages SMS Bulk Automator - Content Script
 * Executes directly within https://messages.google.com/web
 */

// Utility sleep helper
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Dismiss modal overlays / prompts (e.g. "Got it", "OK", "Dismiss")
function dismissPopups() {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
        const txt = (btn.innerText || '').trim().toLowerCase();
        if (['got it', 'ok', 'dismiss', 'continue', 'not now'].includes(txt)) {
            if (btn.offsetWidth > 0 && btn.offsetHeight > 0) {
                btn.click();
            }
        }
    }
}

// Full mouse/pointer/touch event dispatcher with coordinate precision
function simulateClick(el) {
    if (!el) return;
    try {
        el.scrollIntoView?.({ block: 'center', inline: 'center' });
        el.focus?.();
        
        const rect = el.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;

        const opts = {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: x,
            clientY: y,
            screenX: x,
            screenY: y,
            buttons: 1
        };

        el.dispatchEvent(new PointerEvent('pointerdown', opts));
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new PointerEvent('pointerup', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', opts));
        el.click?.();
    } catch (e) {
        try { el.click?.(); } catch (err) {}
    }
}

// Type value with native input and change event triggers
function simulateInput(inputEl, text) {
    if (!inputEl) return;
    inputEl.focus();
    inputEl.value = '';
    
    try {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(inputEl, text);
        else inputEl.value = text;
    } catch (e) {
        inputEl.value = text;
    }
    
    inputEl.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: text }));
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    inputEl.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
}

// Find element with polling
async function waitForElement(selectors, timeoutMs = 4000) {
    const start = Date.now();
    const selectorList = Array.isArray(selectors) ? selectors : [selectors];

    while (Date.now() - start < timeoutMs) {
        for (const sel of selectorList) {
            try {
                const el = document.querySelector(sel);
                if (el && (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0)) {
                    return el;
                }
            } catch (e) {}
        }
        await sleep(200);
    }
    return null;
}

// Check if user is logged into Google Messages Web
function checkPageStatus() {
    const isMessagesUrl = window.location.href.includes('messages.google.com/web');
    if (!isMessagesUrl) {
        return { isReady: false, reason: 'Not on Google Messages Web tab' };
    }

    const qrCode = document.querySelector('mw-qr-code, qr-code, img[alt*="QR"]');
    if (qrCode) {
        return { isReady: false, reason: 'Google Messages requires QR code pairing' };
    }

    const startChatBtn = document.querySelector('a[data-e2e-start-chat], a[href*="start-chat"], mws-fab a, button[aria-label*="Start chat" i]');
    const convList = document.querySelector('mws-conversations-list, div[role="list"]');

    if (startChatBtn || convList || window.location.href.includes('conversations')) {
        return { isReady: true, reason: 'Google Messages is ready' };
    }

    return { isReady: false, reason: 'Loading Google Messages...' };
}

// Find message composer in the active conversation
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
        'div.rich-textarea',
        'mws-autosize-textarea',
        'textarea'
    ];

    for (const sel of composerSelectors) {
        try {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
                if (el && (el.offsetWidth > 0 || el.offsetHeight > 0)) {
                    const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
                    const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
                    if (!placeholder.includes('phone') && !placeholder.includes('name') && !ariaLabel.includes('recipient')) {
                        return el;
                    }
                }
            }
        } catch (e) {}
    }
    return null;
}

// Helper to click the 'Send to [number]' dropdown suggestion
function clickSendToSuggestion(phone) {
    try {
        const customItem = document.querySelector('mws-contact-list-item, [role="option"], mat-list-item');
        if (customItem && (customItem.innerText || '').includes('Send to')) {
            simulateClick(customItem);
            return true;
        }
    } catch (e) {}

    try {
        const all = document.querySelectorAll('*');
        for (const el of all) {
            if (el.innerText && el.innerText.includes('Send to') && el.children.length === 0) {
                const target = el.closest('mws-contact-list-item, [role="option"], mat-list-item, div.contact, button') || el.parentElement || el;
                simulateClick(target);
                return true;
            }
        }
    } catch (e) {}
    return false;
}

// Type message into composer and trigger Angular state updates
async function typeMessageIntoComposer(composer, message) {
    composer.focus();
    await sleep(200);

    const isContentEditable = composer.getAttribute('contenteditable') === 'true' || composer.tagName.toLowerCase() === 'div';

    if (isContentEditable) {
        composer.innerHTML = '';
        composer.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        document.execCommand('insertText', false, message);
        composer.innerText = message;
        composer.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: message }));
        composer.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
        composer.focus();
        composer.value = '';
        
        // Use native execCommand first
        document.execCommand('insertText', false, message);
        
        if (composer.value !== message) {
            try {
                const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
                if (setter) setter.call(composer, message);
                else composer.value = message;
            } catch (e) {
                composer.value = message;
            }
        }

        // Fire full event chain for Angular Reactive Forms
        composer.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: message }));
        composer.dispatchEvent(new Event('input', { bubbles: true }));
        composer.dispatchEvent(new Event('change', { bubbles: true }));
        composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
        composer.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));
    }

    await sleep(600);
}

// Check if a button is strictly the Send button (and not emoji/attachments)
function isSendButton(btn) {
    if (!btn || btn.disabled) return false;
    const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
    const title = (btn.getAttribute('title') || '').toLowerCase();
    const combined = `${aria} ${title}`;

    // STRICT BLACKLIST: Never click emojis, attachments, GIFs, stickers, microphones, etc.
    const blacklist = ['emoji', 'attach', 'gallery', 'gif', 'sticker', 'schedule', 'plus', 'audio', 'voice', 'mic', 'more', 'device', 'info', 'call', 'video'];
    for (const b of blacklist) {
        if (combined.includes(b)) return false;
    }

    // STRICT WHITELIST: Only match Send button components
    if (btn.closest('mws-message-send-button') || btn.tagName.toLowerCase() === 'mws-message-send-button') {
        return true;
    }
    if (btn.hasAttribute('data-e2e-send-text-button') || btn.classList.contains('send-button')) {
        return true;
    }
    if (aria.includes('send sms') || aria.includes('send rcs') || aria.includes('send message') || aria === 'send') {
        return true;
    }

    return false;
}

// Locate the specific Send Button
function findSendButton() {
    // 1. Direct tag/attribute queries
    const primarySelectors = [
        'mws-message-send-button button',
        'button[data-e2e-send-text-button]',
        'mws-message-send-button',
        'button[aria-label*="Send SMS" i]',
        'button[aria-label*="Send RCS" i]',
        'button[aria-label*="Send message" i]',
        'button[aria-label="Send" i]',
        'button.send-button'
    ];

    for (const sel of primarySelectors) {
        try {
            const btn = document.querySelector(sel);
            if (btn && (btn.offsetWidth > 0 || btn.offsetHeight > 0) && isSendButton(btn)) {
                return btn;
            }
        } catch (e) {}
    }

    // 2. Search compose area for valid send button
    const composeArea = document.querySelector('mws-message-compose, div.input-container');
    if (composeArea) {
        const buttons = composeArea.querySelectorAll('button');
        for (const b of buttons) {
            if (isSendButton(b) && (b.offsetWidth > 0 || b.offsetHeight > 0)) {
                return b;
            }
        }
    }

    return null;
}

// Trigger Send ONLY on the real Send Button or Enter Key
async function triggerSend(composer) {
    let sendBtn = null;

    // Poll for up to 2 seconds for Angular to enable the send button
    const start = Date.now();
    while (Date.now() - start < 2000) {
        sendBtn = findSendButton();
        if (sendBtn) break;
        await sleep(200);
    }

    if (sendBtn) {
        simulateClick(sendBtn);
        const icon = sendBtn.querySelector('mat-icon, svg, span');
        if (icon) simulateClick(icon);
    }

    // Dispatch keyboard Enter in composer (Google Messages native shortcut)
    await sleep(200);
    composer.focus();
    const enterOpts = {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        charCode: 13,
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window
    };

    composer.dispatchEvent(new KeyboardEvent('keydown', enterOpts));
    composer.dispatchEvent(new KeyboardEvent('keypress', enterOpts));
    composer.dispatchEvent(new KeyboardEvent('keyup', enterOpts));
}

// Core SMS Sender function
async function sendSms(phone, message) {
    try {
        dismissPopups();

        const cleanPhone = phone.replace(/[^0-9]/g, '');
        const last7 = cleanPhone.slice(-7);

        // 1. Check if the conversation with this recipient is ALREADY open
        const currentHeader = document.querySelector('mws-conversation-header, div[role="region"] header');
        const headerDigits = (currentHeader ? currentHeader.innerText : '').replace(/[^0-9]/g, '');
        let alreadyOpen = last7 && headerDigits.includes(last7);

        let composer = null;
        if (alreadyOpen) {
            composer = findComposer();
        }

        if (!composer) {
            // Check if recipient input is already visible on screen
            let recipientInput = document.querySelector('input[data-e2e-contact-input], input[placeholder*="name, phone" i], input[placeholder*="phone number" i], mws-contact-picker input, input[type="text"]');

            if (!recipientInput) {
                // Check if existing conversation is in sidebar
                let sidebarFound = false;
                const sidebarItems = document.querySelectorAll('mws-conversation-list-item, a[href*="/web/conversations/"]');
                for (const item of sidebarItems) {
                    const txt = (item.innerText || '').replace(/[^0-9]/g, '');
                    if (last7 && txt.includes(last7)) {
                        simulateClick(item);
                        sidebarFound = true;
                        await sleep(1500);
                        break;
                    }
                }

                if (sidebarFound) {
                    composer = findComposer();
                }

                if (!composer) {
                    // Click "Start chat"
                    const startChatSelectors = [
                        'a[data-e2e-start-chat]',
                        'a[href*="start-chat"]',
                        'a[href*="/web/conversations/new"]',
                        'mws-fab a',
                        'mws-fab button',
                        'button[aria-label*="Start chat" i]',
                        'a[aria-label*="Start chat" i]'
                    ];

                    const startChatBtn = await waitForElement(startChatSelectors, 2500);
                    if (startChatBtn) {
                        simulateClick(startChatBtn);
                        await sleep(1000);
                    } else {
                        // If in another chat, try clicking back button
                        const backBtn = document.querySelector('button[aria-label*="Back" i], button[aria-label*="Close" i], mws-conversation-header button');
                        if (backBtn) {
                            simulateClick(backBtn);
                            await sleep(800);
                            const retryStart = await waitForElement(startChatSelectors, 2000);
                            if (retryStart) simulateClick(retryStart);
                        }
                    }

                    // Wait for recipient search input field
                    recipientInput = await waitForElement([
                        'input[data-e2e-contact-input]',
                        'input[placeholder*="name, phone" i]',
                        'input[placeholder*="phone number" i]',
                        'input[placeholder*="Type a name" i]',
                        'mws-contact-picker input',
                        'input[type="text"]',
                        'input'
                    ], 4000);
                }
            }

            // If we have recipient input, type number and select suggestion
            if (recipientInput && !composer) {
                recipientInput.focus();
                simulateInput(recipientInput, phone);
                await sleep(1000);

                // Active loop to click 'Send to' suggestion
                for (let attempt = 1; attempt <= 6; attempt++) {
                    composer = findComposer();
                    if (composer) break;

                    // Click suggestion
                    clickSendToSuggestion(phone);

                    // Keyboard backup: ArrowDown + Enter
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
        }

        // Final composer location check
        if (!composer) {
            const start = Date.now();
            while (Date.now() - start < 4000) {
                composer = findComposer();
                if (composer) break;
                clickSendToSuggestion(phone);
                await sleep(300);
            }
        }

        if (!composer) {
            return { success: false, error: 'Could not locate message composer input. Ensure number is valid.' };
        }

        // 1. Enter message into composer
        await typeMessageIntoComposer(composer, message);

        // 2. Trigger Send strictly on Send Button
        await triggerSend(composer);

        await sleep(2500);

        // 3. Verify if message was cleared from composer
        const composerTextAfter = (composer.value || composer.innerText || '').trim();
        if (composerTextAfter.length > 0 && composerTextAfter === message.trim()) {
            await triggerSend(composer);
            await sleep(1500);
        }

        // Check for error banners
        const notices = document.querySelectorAll('div, span');
        for (const n of notices) {
            const t = (n.innerText || '').toLowerCase();
            if (t.includes('trouble sending') || t.includes('message not sent') || t.includes('failed to send') || t.includes('not delivered')) {
                if (n.offsetWidth > 0 && n.offsetHeight > 0) {
                    return { success: false, error: n.innerText.trim() };
                }
            }
        }

        return { success: true };
    } catch (err) {
        return { success: false, error: err.message || String(err) };
    }
}

// Listen for messages from Side Panel
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'CHECK_STATUS') {
        sendResponse(checkPageStatus());
        return false; // Synchronous response
    }

    if (request.action === 'SEND_SMS') {
        sendSms(request.phone, request.message)
            .then((res) => {
                sendResponse(res || { success: true });
            })
            .catch((err) => {
                sendResponse({ success: false, error: err.message || String(err) });
            });
        return true; // Keep channel open for async response
    }
});
