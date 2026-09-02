import asyncio
import os
import base64
import logging
from typing import Optional, Tuple, Callable, Any
from pathlib import Path
from playwright.async_api import async_playwright, Playwright, BrowserContext, Page, TimeoutError as PlaywrightTimeoutError

logger = logging.getLogger("google_messages_sender")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

BASE_DIR = Path(__file__).parent.resolve()
USER_DATA_DIR = BASE_DIR / "user_data"
GOOGLE_MESSAGES_URL = "https://messages.google.com/web"


class GoogleMessagesEngine:
    def __init__(self, log_callback: Optional[Callable[[str, str], Any]] = None):
        self.playwright: Optional[Playwright] = None
        self.context: Optional[BrowserContext] = None
        self.page: Optional[Page] = None
        self.log_callback = log_callback
        self.is_connected = False
        self._lock = asyncio.Lock()
        os.makedirs(USER_DATA_DIR, exist_ok=True)

    async def log(self, level: str, message: str):
        logger.info(f"[{level.upper()}] {message}")
        if self.log_callback:
            try:
                res = self.log_callback(level, message)
                if asyncio.iscoroutine(res):
                    await res
            except Exception as e:
                logger.error(f"Error in log_callback: {e}")

    async def launch_browser(self, headless: bool = False) -> bool:
        """Launch the persistent browser context and open Google Messages."""
        async with self._lock:
            try:
                if self.page and not self.page.is_closed():
                    await self.log("info", "Browser already running. Navigating to Google Messages...")
                    try:
                        await self.page.goto(GOOGLE_MESSAGES_URL, wait_until="networkidle", timeout=30000)
                    except Exception:
                        pass
                    return True

                await self.log("info", f"Launching Chromium browser (Headless: {headless})...")
                self.playwright = await async_playwright().start()

                # Launch persistent context to store authentication cookies and local storage
                self.context = await self.playwright.chromium.launch_persistent_context(
                    user_data_dir=str(USER_DATA_DIR),
                    headless=headless,
                    args=[
                        "--disable-blink-features=AutomationControlled",
                        "--no-sandbox",
                        "--disable-dev-shm-usage",
                        "--start-maximized",
                    ],
                    viewport=None if not headless else {"width": 1280, "height": 800},
                    user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
                )

                if len(self.context.pages) > 0:
                    self.page = self.context.pages[0]
                else:
                    self.page = await self.context.new_page()

                await self.log("info", "Navigating to Google Messages Web (https://messages.google.com/web)...")
                await self.page.goto(GOOGLE_MESSAGES_URL, wait_until="domcontentloaded", timeout=45000)
                await asyncio.sleep(2)

                # Auto-check and click "Remember this computer" if visible
                try:
                    remember_toggle = self.page.locator('mw-toggle-button[aria-label*="Remember"], input[type="checkbox"][aria-label*="Remember"], mat-slide-toggle:has-text("Remember")')
                    if await remember_toggle.count() > 0:
                        is_checked = await remember_toggle.first.get_attribute("aria-checked") == "true" or await remember_toggle.first.is_checked()
                        if not is_checked:
                            await remember_toggle.first.click()
                            await self.log("info", "Enabled 'Remember this computer' for persistent pairing.")
                except Exception:
                    pass

                return True
            except Exception as e:
                await self.log("error", f"Failed to launch browser: {str(e)}")
                return False

    async def check_pairing_status(self) -> Tuple[bool, str]:
        """
        Check if Google Messages is currently paired and authenticated.
        Returns (is_paired, description).
        """
        if not self.page or self.page.is_closed():
            return False, "Browser is not running"

        try:
            current_url = self.page.url
            # If on conversations page
            if "conversations" in current_url:
                self.is_connected = True
                return True, "Paired & Connected"

            # Check for conversation list elements or Start chat button
            selectors_paired = [
                'a[data-e2e-start-chat]',
                'a[href*="start-chat"]',
                'a[href*="/web/conversations/new"]',
                'mws-conversations-list',
                'div[role="list"][aria-label*="Conversations"]',
                'button:has-text("Start chat")',
                'a:has-text("Start chat")',
            ]

            for selector in selectors_paired:
                if await self.page.locator(selector).count() > 0:
                    self.is_connected = True
                    return True, "Paired & Ready to send"

            # Check for QR code or pairing prompts
            selectors_qr = [
                'mw-qr-code',
                'qr-code',
                'img[alt*="QR"]',
                'canvas',
                'div:has-text("Scan the QR code")',
                'div:has-text("Pair your phone")',
                'div:has-text("Messages on your phone")',
            ]

            for selector in selectors_qr:
                if await self.page.locator(selector).count() > 0:
                    self.is_connected = False
                    return False, "Waiting for QR Code Scan / Device Pairing"

            # Ambiguous state, wait a bit
            await asyncio.sleep(2)
            for selector in selectors_paired:
                if await self.page.locator(selector).count() > 0:
                    self.is_connected = True
                    return True, "Paired & Ready to send"

            return False, "Loading Google Messages / Pending Pairing"
        except Exception as e:
            return False, f"Error checking pairing: {str(e)}"

    async def get_qr_screenshot_base64(self) -> Optional[str]:
        """Capture screenshot of the QR code element if visible for remote web pairing."""
        if not self.page or self.page.is_closed():
            return None
        
        qr_selectors = [
            'mw-qr-code',
            'qr-code',
            'div.qr-code-container',
            'img[alt*="QR" i]',
            'canvas',
            'div.landing-screen',
        ]
        
        for sel in qr_selectors:
            try:
                el = self.page.locator(sel).first
                if await el.is_visible(timeout=600):
                    img_bytes = await el.screenshot()
                    return base64.b64encode(img_bytes).decode("utf-8")
            except Exception:
                continue
        
        try:
            img_bytes = await self.page.screenshot()
            return base64.b64encode(img_bytes).decode("utf-8")
        except Exception:
            return None

    async def wait_until_paired(self, timeout_seconds: int = 180) -> bool:
        """Wait until the user completes the QR code pairing scan."""
        await self.log("info", f"Waiting for device pairing scan (up to {timeout_seconds}s)...")
        start_time = asyncio.get_event_loop().time()

        while (asyncio.get_event_loop().time() - start_time) < timeout_seconds:
            is_paired, status_text = await self.check_pairing_status()
            if is_paired:
                await self.log("success", "Device successfully paired and connected to Google Messages!")
                return True
            await asyncio.sleep(2)

        await self.log("warning", "Pairing timeout reached. Please scan the QR code when ready.")
        return False

    async def send_sms(self, phone_number: str, message_text: str) -> Tuple[bool, Optional[str]]:
        """
        Automates sending an SMS to the specified phone number via Google Messages Web.
        """
        async with self._lock:
            if not self.page or self.page.is_closed():
                return False, "Browser is not running. Please launch browser first."

            try:
                # 1. Ensure we are on the messages page
                if not ("conversations" in self.page.url or "messages.google.com" in self.page.url):
                    await self.log("info", "Navigating to Google Messages...")
                    await self.page.goto(GOOGLE_MESSAGES_URL, wait_until="domcontentloaded", timeout=30000)
                    await asyncio.sleep(2)

                # Check pairing
                is_paired, status_desc = await self.check_pairing_status()
                if not is_paired:
                    return False, f"Device is not paired: {status_desc}"

                # Dismiss any initial modal/popups (e.g. "Got it", "OK", "Dismiss")
                await self._dismiss_popups()

                # Clean phone digits for search matching
                digits_only = "".join([c for c in phone_number if c.isdigit()])
                last_7 = digits_only[-7:] if len(digits_only) >= 7 else digits_only

                # Check if conversation already exists in left conversation sidebar
                sidebar_opened = False
                try:
                    conv_items = self.page.locator('mws-conversation-list-item, a[href*="/web/conversations/"]')
                    conv_count = await conv_items.count()
                    for i in range(min(conv_count, 15)):
                        item = conv_items.nth(i)
                        item_text = await item.inner_text()
                        item_digits = "".join([c for c in item_text if c.isdigit()])
                        if last_7 and last_7 in item_digits:
                            await item.click()
                            sidebar_opened = True
                            first_line = item_text.splitlines()[0] if item_text.splitlines() else phone_number
                            await self.log("info", f"Found existing thread in sidebar. Opened: '{first_line}'")
                            await asyncio.sleep(1.5)
                            break
                except Exception as e:
                    await self.log("info", f"Sidebar check: {e}")

                if not sidebar_opened:
                    # 2. Click "Start chat"
                    start_chat_selectors = [
                        'a[data-e2e-start-chat]',
                        'a[href*="start-chat"]',
                        'a[href*="/web/conversations/new"]',
                        'button:has-text("Start chat")',
                        'a:has-text("Start chat")',
                        'div.fab-container a',
                        'div.fab-container button',
                        'mws-fab a',
                        'mws-fab button',
                        'button[aria-label*="Start chat" i]',
                        'a[aria-label*="Start chat" i]',
                    ]

                    start_button_found = False
                    for sel in start_chat_selectors:
                        try:
                            btn = self.page.locator(sel).first
                            if await btn.is_visible(timeout=1000):
                                await btn.click()
                                start_button_found = True
                                await self.log("info", "Clicked 'Start chat' button.")
                                break
                        except Exception:
                            continue

                    if not start_button_found:
                        # Alternative: direct navigation
                        await self.page.goto("https://messages.google.com/web/conversations/new", wait_until="domcontentloaded", timeout=20000)
                        await asyncio.sleep(1.0)

                    await asyncio.sleep(1.0)

                    # 3. Wait for recipient input box
                    recipient_selectors = [
                        'input[data-e2e-contact-input]',
                        'input[placeholder*="name, phone" i]',
                        'input[placeholder*="phone number" i]',
                        'input[placeholder*="Type a name" i]',
                        'input[aria-label*="recipient" i]',
                        'input[aria-label*="phone number" i]',
                        'input[aria-label*="Type a name" i]',
                        'input.input',
                        'mws-contact-picker input',
                        'input[type="text"]',
                        'input',
                    ]

                    recipient_input = None
                    for sel in recipient_selectors:
                        try:
                            inp = self.page.locator(sel).first
                            if await inp.is_visible(timeout=1500):
                                recipient_input = inp
                                break
                        except Exception:
                            continue

                    if not recipient_input:
                        try:
                            await self.page.wait_for_selector('input[type="text"], input', timeout=6000)
                            recipient_input = self.page.locator('input[type="text"], input').first
                        except Exception:
                            return False, "Could not find recipient input box"

                    # Focus, clear, and type recipient phone number
                    await recipient_input.click()
                    await asyncio.sleep(0.3)
                    await recipient_input.fill("")
                    await asyncio.sleep(0.2)
                    
                    # Type phone number character by character
                    await recipient_input.type(phone_number, delay=35)
                    await self.log("info", f"Typed recipient number {phone_number} into search field.")
                    await asyncio.sleep(1.5)

                    # 4. Select the contact from suggestions with adaptive coordinate & event loop
                    await self.log("info", "Selecting contact from dropdown suggestions...")
                    await asyncio.sleep(1.0)

                    # Multi-attempt selection loop: keeps clicking until conversation/composer opens
                    for attempt in range(1, 7):
                        # Check if composer already appeared
                        composer = await self._find_message_composer()
                        if composer:
                            await self.log("info", f"Conversation opened successfully on attempt {attempt}!")
                            break

                        await self.log("info", f"Clicking 'Send to {phone_number}' suggestion (attempt {attempt}/6)...")

                        # Step A: Get exact screen coordinates of 'Send to' row, avatar, and text
                        coords = await self.page.evaluate("""() => {
                            // Find element containing 'Send to'
                            const all = Array.from(document.querySelectorAll('*'));
                            for (const el of all) {
                                if (el.innerText && el.innerText.includes('Send to') && el.children.length === 0) {
                                    const rect = el.getBoundingClientRect();
                                    if (rect.width > 0 && rect.height > 0) {
                                        return {
                                            found: true,
                                            x: rect.left + rect.width / 2,
                                            y: rect.top + rect.height / 2,
                                            left: rect.left,
                                            top: rect.top,
                                            height: rect.height
                                        };
                                    }
                                }
                            }
                            // Fallback to contact list item
                            const item = document.querySelector('mws-contact-list-item, [role="option"], mat-list-item, div.contact');
                            if (item) {
                                const rect = item.getBoundingClientRect();
                                return {
                                    found: true,
                                    x: rect.left + rect.width / 2,
                                    y: rect.top + rect.height / 2,
                                    left: rect.left,
                                    top: rect.top,
                                    height: rect.height
                                };
                            }
                            return { found: false };
                        }""")

                        if coords and coords.get("found"):
                            left = coords["left"]
                            top = coords["top"]
                            mid_y = top + coords.get("height", 30) / 2
                            # Click the avatar circle (left of text)
                            await self.page.mouse.click(max(10, left - 25), mid_y)
                            await asyncio.sleep(0.2)
                            # Click the text itself
                            await self.page.mouse.click(coords["x"], coords["y"])
                            await asyncio.sleep(0.2)

                        # Step B: JS synthetic full-event sequence on all candidate elements
                        await self.page.evaluate("""() => {
                            const items = Array.from(document.querySelectorAll('mws-contact-list-item, [role="option"], mat-list-item, div, button, span, a'));
                            for (const el of items) {
                                const txt = (el.innerText || '').trim();
                                if (txt.includes('Send to') && el.offsetHeight > 10 && el.offsetHeight < 150) {
                                    el.focus?.();
                                    el.click?.();
                                    const opts = { bubbles: true, cancelable: true, view: window };
                                    el.dispatchEvent(new PointerEvent('pointerdown', opts));
                                    el.dispatchEvent(new MouseEvent('mousedown', opts));
                                    el.dispatchEvent(new PointerEvent('pointerup', opts));
                                    el.dispatchEvent(new MouseEvent('mouseup', opts));
                                    el.dispatchEvent(new MouseEvent('click', opts));
                                }
                            }
                        }""")

                        # Step C: Keyboard navigation (ArrowDown + Enter, and double Enter)
                        await recipient_input.focus()
                        await self.page.keyboard.press("ArrowDown")
                        await asyncio.sleep(0.15)
                        await self.page.keyboard.press("Enter")
                        await asyncio.sleep(0.2)
                        await self.page.keyboard.press("Enter")

                        # Step D: Playwright locators click
                        for sel in ['mws-contact-list-item', '[role="option"]', 'div[data-e2e-contact-item]', 'mat-list-item']:
                            try:
                                loc = self.page.locator(sel).first
                                if await loc.is_visible(timeout=300):
                                    await loc.click(force=True)
                                    break
                            except Exception:
                                pass

                        await asyncio.sleep(1.0)
                        await self._dismiss_popups()

                # 5. Final check for Message Composer
                composer = await self._find_message_composer()

                if not composer:
                    # Capture debug screenshot
                    try:
                        os.makedirs(BASE_DIR / "debug", exist_ok=True)
                        screenshot_path = str(BASE_DIR / "debug" / "composer_error.png")
                        await self.page.screenshot(path=screenshot_path)
                        await self.log("warning", f"Saved debug screenshot to debug/composer_error.png")
                    except Exception:
                        pass
                    return False, "Could not locate message composer input. Ensure device is paired and number is valid."

                # 6. Focus and type the message into composer
                await self.log("info", "Message composer located. Entering message...")
                await composer.click()
                await asyncio.sleep(0.3)

                # Check element type
                try:
                    is_contenteditable = await composer.get_attribute("contenteditable") == "true"
                    tag_name = await composer.evaluate("el => el.tagName.toLowerCase()")
                except Exception:
                    is_contenteditable = False
                    tag_name = "textarea"

                if is_contenteditable or tag_name == "div":
                    # Contenteditable div composer
                    await composer.evaluate(f"el => {{ el.focus(); document.execCommand('insertText', false, {repr(message_text)}); }}")
                    # Fallback type
                    text_val = await composer.inner_text()
                    if not text_val.strip():
                        await composer.type(message_text, delay=20)
                else:
                    # Standard textarea
                    await composer.fill(message_text)

                await asyncio.sleep(0.8)

                # 7. Click Send Button
                send_button_selectors = [
                    'button[data-e2e-send-text-button]',
                    'button[aria-label*="Send SMS" i]',
                    'button[aria-label*="Send RCS" i]',
                    'button[aria-label*="Send message" i]',
                    'button[aria-label*="Send" i]',
                    'mws-message-send-button button',
                    'mws-message-send-button',
                    'div[data-e2e-send-text-button]',
                    'button:has(mat-icon:has-text("send"))',
                    'button:has(i:has-text("send"))',
                ]

                sent_clicked = False
                for sel in send_button_selectors:
                    try:
                        btn = self.page.locator(sel).first
                        if await btn.is_visible(timeout=1500):
                            is_disabled = await btn.is_disabled()
                            if not is_disabled:
                                await btn.click()
                                sent_clicked = True
                                await self.log("info", f"Clicked send button ({sel}).")
                                break
                    except Exception:
                        continue

                if not sent_clicked:
                    # Fallback: Focus composer and press Enter
                    await self.log("info", "Send button not clicked directly; pressing Enter key in composer...")
                    await composer.focus()
                    await self.page.keyboard.press("Enter")

                await self.log("info", f"Message dispatched to {phone_number}. Waiting for confirmation...")
                await asyncio.sleep(3.0)

                # 8. Check for any error messages
                error_selectors = [
                    'div:has-text("Trouble sending")',
                    'div:has-text("Message not sent")',
                    'div:has-text("Failed to send")',
                    'span:has-text("Not delivered")',
                    'div:has-text("Invalid recipient")',
                ]
                for err_sel in error_selectors:
                    try:
                        err_elem = self.page.locator(err_sel).first
                        if await err_elem.is_visible(timeout=800):
                            return False, f"Google Messages error: {await err_elem.inner_text()}"
                    except Exception:
                        pass

                return True, None

            except PlaywrightTimeoutError as e:
                return False, f"Timeout error during sending: {str(e)}"
            except Exception as e:
                return False, f"Unexpected error: {str(e)}"

    async def _dismiss_popups(self):
        """Dismiss common Google Messages prompts, tooltips, and modal dialogs."""
        if not self.page or self.page.is_closed():
            return

        dismiss_selectors = [
            'button:has-text("Got it")',
            'button:has-text("OK")',
            'button:has-text("Dismiss")',
            'button:has-text("Continue")',
            'button:has-text("Not now")',
            'button[aria-label*="Close" i]',
            'button[aria-label*="Dismiss" i]',
        ]

        for sel in dismiss_selectors:
            try:
                elem = self.page.locator(sel).first
                if await elem.is_visible(timeout=600):
                    await elem.click()
                    await self.log("info", f"Dismissed dialog/prompt: '{sel}'")
                    await asyncio.sleep(0.5)
            except Exception:
                pass

    async def _find_message_composer(self):
        """Search for the message composer textarea or contenteditable element with multiple fallback selectors."""
        composer_selectors = [
            'mws-autosize-textarea textarea',
            'mws-message-compose textarea',
            'textarea[data-e2e-message-input-box]',
            'textarea[aria-label*="message" i]',
            'textarea[aria-label*="SMS" i]',
            'textarea[aria-label*="Text" i]',
            'textarea[aria-label*="RCS" i]',
            'textarea[aria-label*="chat" i]',
            'textarea[placeholder*="message" i]',
            'textarea[placeholder*="SMS" i]',
            'textarea[placeholder*="Text" i]',
            'textarea[placeholder*="RCS" i]',
            'textarea[placeholder*="chat" i]',
            'div[contenteditable="true"][aria-label*="message" i]',
            'div[contenteditable="true"]',
            '[role="textbox"]',
            'div.rich-textarea',
            'mws-autosize-textarea',
            'textarea',
        ]

        # Poll for composer for up to 10 seconds
        start_time = asyncio.get_event_loop().time()
        while (asyncio.get_event_loop().time() - start_time) < 10.0:
            # Check by placeholder and label
            for label in ["Text message", "SMS message", "Chat message", "RCS message", "Message", "SMS", "Text"]:
                try:
                    by_ph = self.page.get_by_placeholder(label, exact=False).first
                    if await by_ph.is_visible(timeout=200):
                        return by_ph
                    by_lbl = self.page.get_by_label(label, exact=False).first
                    if await by_lbl.is_visible(timeout=200):
                        return by_lbl
                except Exception:
                    pass

            for sel in composer_selectors:
                try:
                    elem = self.page.locator(sel).last
                    if await elem.is_visible(timeout=200):
                        return elem
                except Exception:
                    continue
            await asyncio.sleep(0.5)

        return None

    async def close(self):
        """Close browser context and playwright instance."""
        async with self._lock:
            try:
                if self.context:
                    await self.context.close()
                    self.context = None
                if self.playwright:
                    await self.playwright.stop()
                    self.playwright = None
                self.page = None
                self.is_connected = False
                await self.log("info", "Browser session closed.")
            except Exception as e:
                logger.error(f"Error closing browser: {e}")
