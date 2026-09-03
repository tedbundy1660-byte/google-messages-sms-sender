import os
import json
import uuid
import asyncio
import random
import re
from pathlib import Path
from datetime import datetime
from typing import List, Dict, Optional, Callable, Any

from models import (
    Contact,
    CampaignConfig,
    CampaignStats,
    MessageStatus,
    LogEntry,
    PairingStatus,
    SavedTemplate,
    BlacklistEntry,
    resolve_spintax,
    normalize_phone_number
)
from sender_engine import GoogleMessagesEngine

BASE_DIR = Path(__file__).parent.resolve()
TEMPLATES_FILE = BASE_DIR / "templates.json"
BLACKLIST_FILE = BASE_DIR / "blacklist.json"


class CampaignManager:
    def __init__(self, engine: GoogleMessagesEngine):
        self.engine = engine
        self.contacts: List[Contact] = []
        self.config = CampaignConfig()
        self.stats = CampaignStats()
        self.logs: List[LogEntry] = []
        
        self.is_running = False
        self.is_paused = False
        self._stop_requested = False
        self._task: Optional[asyncio.Task] = None
        self._listeners: List[Callable[[str, Any], Any]] = []

        # Load persisted templates & blacklist
        self.templates: List[SavedTemplate] = self._load_templates()
        self.blacklist: Dict[str, BlacklistEntry] = self._load_blacklist()

    # ==========================================
    # Templates & Blacklist Storage
    # ==========================================

    def _load_templates(self) -> List[SavedTemplate]:
        if not TEMPLATES_FILE.exists():
            default_templates = [
                SavedTemplate(
                    id="tpl-1",
                    name="Appointment Reminder (Spintax)",
                    content="{Hello|Hi|Hey} {name}, {this is a friendly reminder|just reminding you} about your appointment tomorrow at 10 AM. {Reply YES to confirm|Let us know if you need to reschedule}!",
                    category="Reminders",
                    created_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                ),
                SavedTemplate(
                    id="tpl-2",
                    name="Special Offer / Promo",
                    content="{Hey|Hi} {name}! {Exclusive deal for you|Special promotion}: Get 20% off your next order with code SAVE20. {Check it out now|Visit our website to claim}!",
                    category="Marketing",
                    created_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                ),
                SavedTemplate(
                    id="tpl-3",
                    name="Order Confirmation",
                    content="Hello {name}, your order #{phone} has been received and is being processed. Thank you for your business!",
                    category="Transactional",
                    created_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                ),
            ]
            self._save_templates_to_file(default_templates)
            return default_templates

        try:
            with open(TEMPLATES_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                return [SavedTemplate(**item) for item in data]
        except Exception:
            return []

    def _save_templates_to_file(self, templates: List[SavedTemplate]):
        try:
            with open(TEMPLATES_FILE, "w", encoding="utf-8") as f:
                json.dump([t.model_dump() for t in templates], f, indent=2)
        except Exception:
            pass

    def get_templates(self) -> List[SavedTemplate]:
        return self.templates

    def save_template(self, name: str, content: str, category: str = "General", template_id: Optional[str] = None) -> SavedTemplate:
        tid = template_id or f"tpl-{uuid.uuid4().hex[:8]}"
        tpl = SavedTemplate(
            id=tid,
            name=name,
            content=content,
            category=category,
            created_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        )
        
        # Replace if existing or append
        existing_idx = next((i for i, t in enumerate(self.templates) if t.id == tid), None)
        if existing_idx is not None:
            self.templates[existing_idx] = tpl
        else:
            self.templates.insert(0, tpl)

        self._save_templates_to_file(self.templates)
        return tpl

    def delete_template(self, template_id: str) -> bool:
        initial_len = len(self.templates)
        self.templates = [t for t in self.templates if t.id != template_id]
        if len(self.templates) != initial_len:
            self._save_templates_to_file(self.templates)
            return True
        return False

    def _load_blacklist(self) -> Dict[str, BlacklistEntry]:
        if not BLACKLIST_FILE.exists():
            return {}
        try:
            with open(BLACKLIST_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                return {k: BlacklistEntry(**v) for k, v in data.items()}
        except Exception:
            return {}

    def _save_blacklist_to_file(self):
        try:
            with open(BLACKLIST_FILE, "w", encoding="utf-8") as f:
                json.dump({k: v.model_dump() for k, v in self.blacklist.items()}, f, indent=2)
        except Exception:
            pass

    def get_blacklist(self) -> List[BlacklistEntry]:
        return list(self.blacklist.values())

    def add_to_blacklist(self, phone: str, reason: str = "Opted-out / Do Not Contact") -> BlacklistEntry:
        clean = normalize_phone_number(phone, self.config.default_country_code)
        entry = BlacklistEntry(
            phone=clean,
            reason=reason,
            added_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        )
        self.blacklist[clean] = entry
        self._save_blacklist_to_file()
        
        # Mark existing queue contacts as blacklisted
        for c in self.contacts:
            if normalize_phone_number(c.phone, self.config.default_country_code) == clean:
                c.status = MessageStatus.BLACKLISTED
                c.error = f"Blacklisted ({reason})"
        self.update_stats()
        return entry

    def remove_from_blacklist(self, phone: str) -> bool:
        clean = normalize_phone_number(phone, self.config.default_country_code)
        if clean in self.blacklist:
            del self.blacklist[clean]
            self._save_blacklist_to_file()
            return True
        return False

    def is_blacklisted(self, phone: str) -> bool:
        clean = normalize_phone_number(phone, self.config.default_country_code)
        return clean in self.blacklist

    # ==========================================
    # WebSocket & Live Event Dispatcher
    # ==========================================

    def add_listener(self, callback: Callable[[str, Any], Any]):
        if callback not in self._listeners:
            self._listeners.append(callback)

    def remove_listener(self, callback: Callable[[str, Any], Any]):
        if callback in self._listeners:
            self._listeners.remove(callback)

    async def broadcast(self, event_type: str, data: Any):
        for listener in list(self._listeners):
            try:
                res = listener(event_type, data)
                if asyncio.iscoroutine(res):
                    await res
            except Exception:
                pass

    async def add_log(self, level: str, message: str):
        entry = LogEntry(
            timestamp=datetime.now().strftime("%H:%M:%S"),
            level=level,
            message=message
        )
        self.logs.append(entry)
        if len(self.logs) > 500:
            self.logs.pop(0)
        await self.broadcast("log", entry.model_dump())

    # ==========================================
    # Message Formatting & Spintax Resolution
    # ==========================================

    def format_message(self, template: str, contact: Contact) -> str:
        """
        1. Replace dynamic tags ({name}, {phone}, {custom_col})
        2. Resolve nested Spintax variations ({Hello|Hi|Hey})
        3. Append Auto Opt-Out notice if configured
        4. Enforce Single SMS (160 char) corrector limit if configured
        """
        text = template
        replacements = {
            "name": contact.name or "",
            "phone": contact.phone or "",
            **contact.custom_data
        }
        for key, val in replacements.items():
            pattern = re.compile(rf"\{{{key}\}}", re.IGNORECASE)
            text = pattern.sub(str(val), text)

        # Resolve spintax variations
        text = resolve_spintax(text)

        # Auto-append opt-out notice
        if getattr(self.config, 'auto_optout', False):
            opt_lower = text.lower()
            if "stop" not in opt_lower and "unsubscribe" not in opt_lower and "opt out" not in opt_lower:
                optout_phrase = resolve_spintax(self.config.optout_text or "Reply STOP to opt out")
                text = f"{text.rstrip()}\n{optout_phrase}"

        # Enforce Single SMS corrector limit (160 chars)
        if getattr(self.config, 'enforce_single_sms', False):
            max_len = getattr(self.config, 'max_character_limit', 160) or 160
            if len(text) > max_len:
                # Remove excessive whitespace
                text = re.sub(r'[ \t]+', ' ', text)
                text = re.sub(r'\n+', '\n', text).strip()
                if len(text) > max_len:
                    text = text[:max_len]

        return text

    def set_contacts(self, raw_contacts: List[Dict[str, Any]], template: Optional[str] = None):
        """Load, sanitize, and initialize contacts with rendered spintax messages."""
        if template:
            self.config.message_template = template

        self.contacts = []
        blacklisted_count = 0

        for idx, item in enumerate(raw_contacts):
            raw_phone = str(item.get("phone", "")).strip()
            clean_phone = normalize_phone_number(raw_phone, self.config.default_country_code)
            name = str(item.get("name", "")).strip()
            custom_data = {k: v for k, v in item.items() if k not in ["phone", "name", "id", "status"]}

            c = Contact(
                id=idx + 1,
                phone=clean_phone or raw_phone,
                name=name,
                custom_data=custom_data,
                status=MessageStatus.PENDING
            )

            # Check blacklist
            if clean_phone and self.is_blacklisted(clean_phone):
                c.status = MessageStatus.BLACKLISTED
                c.error = "Blacklisted / Do Not Contact"
                blacklisted_count += 1

            c.message = self.format_message(self.config.message_template, c)
            self.contacts.append(c)

        self.update_stats()

    def retry_failed_contacts(self) -> int:
        """Reset all FAILED contacts back to PENDING for 1-click retrying."""
        count = 0
        for c in self.contacts:
            if c.status == MessageStatus.FAILED:
                c.status = MessageStatus.PENDING
                c.error = None
                c.sent_at = None
                # Generate a fresh spintax variation
                c.message = self.format_message(self.config.message_template, c)
                count += 1
        self.update_stats()
        return count

    def update_stats(self):
        total = len(self.contacts)
        sent = sum(1 for c in self.contacts if c.status == MessageStatus.SENT)
        failed = sum(1 for c in self.contacts if c.status == MessageStatus.FAILED)
        skipped = sum(1 for c in self.contacts if c.status == MessageStatus.SKIPPED)
        blacklisted = sum(1 for c in self.contacts if c.status == MessageStatus.BLACKLISTED)
        pending = sum(1 for c in self.contacts if c.status in [MessageStatus.PENDING, MessageStatus.SENDING])

        progress = (sent + failed + skipped + blacklisted) / total * 100.0 if total > 0 else 0.0

        # Estimated time remaining based on average delay
        avg_delay = (self.config.min_delay_seconds + self.config.max_delay_seconds) / 2.0
        est_seconds = pending * (avg_delay + 4.0)

        self.stats = CampaignStats(
            total=total,
            sent=sent,
            failed=failed,
            skipped=skipped,
            blacklisted=blacklisted,
            pending=pending,
            progress_percent=round(progress, 1),
            is_running=self.is_running,
            is_paused=self.is_paused,
            is_batch_paused=self.stats.is_batch_paused,
            batch_pause_remaining_seconds=self.stats.batch_pause_remaining_seconds,
            current_index=self.stats.current_index,
            current_phone=self.stats.current_phone,
            current_name=self.stats.current_name,
            estimated_time_remaining_seconds=round(est_seconds, 0)
        )

    # ==========================================
    # Campaign Execution Lifecycle
    # ==========================================

    async def start_campaign(self, config: Optional[CampaignConfig] = None) -> bool:
        """Start or resume the campaign."""
        if self.is_running:
            if self.is_paused:
                self.is_paused = False
                await self.add_log("info", "Campaign resumed.")
                self.update_stats()
                await self.broadcast("stats", self.stats.model_dump())
                return True
            return False

        if config:
            self.config = config
            for c in self.contacts:
                if c.status == MessageStatus.PENDING:
                    c.message = self.format_message(self.config.message_template, c)

        if not self.contacts:
            await self.add_log("warning", "No contacts loaded in campaign queue.")
            return False

        # Verify browser and pairing
        is_paired, status_desc = await self.engine.check_pairing_status()
        if not is_paired:
            await self.add_log("info", "Browser not ready. Launching pairing session...")
            launched = await self.engine.launch_browser(headless=self.config.headless)
            if not launched:
                await self.add_log("error", "Failed to launch browser.")
                return False

            is_paired, status_desc = await self.engine.check_pairing_status()
            if not is_paired:
                await self.add_log("warning", f"Please pair your phone with Google Messages ({status_desc})")
                return False

        self.is_running = True
        self.is_paused = False
        self._stop_requested = False
        self.update_stats()
        await self.broadcast("stats", self.stats.model_dump())

        # Start background task loop
        self._task = asyncio.create_task(self._run_loop())
        return True

    def pause_campaign(self):
        """Pause active campaign."""
        if self.is_running:
            self.is_paused = True
            self.update_stats()

    def resume_campaign(self):
        """Resume paused campaign."""
        if self.is_running and self.is_paused:
            self.is_paused = False
            self.update_stats()

    def stop_campaign(self):
        """Stop campaign immediately."""
        self._stop_requested = True
        self.is_running = False
        self.is_paused = False
        if self._task and not self._task.done():
            self._task.cancel()
        self.update_stats()

    async def _run_loop(self):
        mms_note = " (with MMS Image Attachment)" if self.config.image_path else ""
        await self.add_log("info", f"🚀 Starting SMS/MMS campaign for {len(self.contacts)} contacts{mms_note}.")
        await self.add_log("info", f"⏱ Random delay interval: {self.config.min_delay_seconds}s to {self.config.max_delay_seconds}s.")

        messages_sent_in_batch = 0

        try:
            for idx, contact in enumerate(self.contacts):
                if self._stop_requested:
                    await self.add_log("warning", "Campaign stopped by user.")
                    break

                # Handle pause
                while self.is_paused:
                    await asyncio.sleep(1)
                    if self._stop_requested:
                        break

                if self._stop_requested:
                    break

                # Skip non-pending contacts
                if contact.status in [MessageStatus.SENT, MessageStatus.SKIPPED, MessageStatus.BLACKLISTED]:
                    continue

                if not contact.phone:
                    contact.status = MessageStatus.SKIPPED
                    contact.error = "Missing phone number"
                    await self.broadcast("contact_update", contact.model_dump())
                    continue

                # Check blacklist on the fly
                if self.is_blacklisted(contact.phone):
                    contact.status = MessageStatus.BLACKLISTED
                    contact.error = "Blacklisted / Do Not Contact"
                    await self.add_log("warning", f"Skipped blacklisted recipient: {contact.phone}")
                    await self.broadcast("contact_update", contact.model_dump())
                    continue

                # Refresh spintax variation for sending
                contact.message = self.format_message(self.config.message_template, contact)

                # Update current contact status
                contact.status = MessageStatus.SENDING
                self.stats.current_index = idx + 1
                self.stats.current_phone = contact.phone
                self.stats.current_name = contact.name
                self.update_stats()
                await self.broadcast("contact_update", contact.model_dump())
                await self.broadcast("stats", self.stats.model_dump())

                msg_preview = contact.message if len(contact.message) <= 40 else contact.message[:37] + "..."
                await self.add_log("info", f"[{idx+1}/{len(self.contacts)}] Sending to {contact.name or 'Unknown'} ({contact.phone}): '{msg_preview}'")

                # Send message via Google Messages engine with optional image attachment
                success, error_msg = await self.engine.send_sms(
                    phone_number=contact.phone,
                    message_text=contact.message,
                    image_path=self.config.image_path
                )

                if success:
                    contact.status = MessageStatus.SENT
                    contact.sent_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                    contact.error = None
                    await self.add_log("success", f"✓ Sent successfully to {contact.phone} ({contact.name or 'Recipient'})")
                else:
                    contact.status = MessageStatus.FAILED
                    contact.error = error_msg or "Failed to send"
                    await self.add_log("error", f"✗ Failed sending to {contact.phone}: {contact.error}")

                self.update_stats()
                await self.broadcast("contact_update", contact.model_dump())
                await self.broadcast("stats", self.stats.model_dump())

                messages_sent_in_batch += 1

                # Check if more pending contacts remain before delaying
                remaining_pending = sum(1 for c in self.contacts[idx+1:] if c.status == MessageStatus.PENDING)
                if remaining_pending > 0 and not self._stop_requested:
                    # Smart Batch Cooldown check
                    if self.config.batch_size and self.config.batch_size > 0 and (messages_sent_in_batch % self.config.batch_size == 0):
                        batch_delay = self.config.batch_delay_seconds or 300.0
                        self.stats.is_batch_paused = True
                        await self.add_log("warning", f"⏸ Batch size of {self.config.batch_size} reached. Entering {int(batch_delay)}s cooldown period...")

                        for sec in range(int(batch_delay), 0, -1):
                            if self._stop_requested:
                                break
                            self.stats.batch_pause_remaining_seconds = sec
                            await self.broadcast("countdown", {"seconds": sec, "reason": "batch_cooldown"})
                            await self.broadcast("stats", self.stats.model_dump())
                            await asyncio.sleep(1)

                        self.stats.is_batch_paused = False
                        self.stats.batch_pause_remaining_seconds = 0.0
                        await self.add_log("info", "Resuming campaign after batch cooldown.")
                    else:
                        # Randomized delay
                        delay = round(random.uniform(self.config.min_delay_seconds, self.config.max_delay_seconds), 1)
                        await self.add_log("info", f"⏳ Waiting {delay}s before next message (Randomized Anti-Spam Delay)...")

                        steps = int(delay)
                        for sec in range(steps, 0, -1):
                            if self._stop_requested:
                                break
                            await self.broadcast("countdown", {"seconds": sec, "reason": "random_delay"})
                            await asyncio.sleep(1)

                        fraction = delay - steps
                        if fraction > 0 and not self._stop_requested:
                            await asyncio.sleep(fraction)

            await self.add_log("success", f"🎉 Campaign completed! Total: {self.stats.total}, Sent: {self.stats.sent}, Failed: {self.stats.failed}")

        except asyncio.CancelledError:
            await self.add_log("warning", "Campaign execution was cancelled.")
        except Exception as e:
            await self.add_log("error", f"Unexpected error in campaign execution: {str(e)}")
        finally:
            self.is_running = False
            self.is_paused = False
            self.stats.is_batch_paused = False
            self.update_stats()
            await self.broadcast("stats", self.stats.model_dump())
