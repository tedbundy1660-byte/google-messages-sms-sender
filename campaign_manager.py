import asyncio
import random
import re
from datetime import datetime
from typing import List, Dict, Optional, Callable, Any
from models import Contact, CampaignConfig, CampaignStats, MessageStatus, LogEntry, PairingStatus
from sender_engine import GoogleMessagesEngine


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

    def add_listener(self, callback: Callable[[str, Any], Any]):
        """Subscribe to live campaign events."""
        if callback not in self._listeners:
            self._listeners.append(callback)

    def remove_listener(self, callback: Callable[[str, Any], Any]):
        if callback in self._listeners:
            self._listeners.remove(callback)

    async def broadcast(self, event_type: str, data: Any):
        """Notify all connected frontend WebSocket listeners."""
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

    def format_message(self, template: str, contact: Contact) -> str:
        """Replace {name}, {phone}, and any custom fields with contact values."""
        text = template
        replacements = {
            "name": contact.name or "",
            "phone": contact.phone or "",
            **contact.custom_data
        }
        for key, val in replacements.items():
            pattern = re.compile(rf"\{{{key}\}}", re.IGNORECASE)
            text = pattern.sub(str(val), text)
        return text

    def set_contacts(self, raw_contacts: List[Dict[str, Any]], template: Optional[str] = None):
        """Load and initialize contacts with rendered template messages."""
        if template:
            self.config.message_template = template

        self.contacts = []
        for idx, item in enumerate(raw_contacts):
            phone = str(item.get("phone", "")).strip()
            name = str(item.get("name", "")).strip()
            custom_data = {k: v for k, v in item.items() if k not in ["phone", "name", "id", "status"]}

            c = Contact(
                id=idx + 1,
                phone=phone,
                name=name,
                custom_data=custom_data,
                status=MessageStatus.PENDING
            )
            c.message = self.format_message(self.config.message_template, c)
            self.contacts.append(c)

        self.update_stats()

    def update_stats(self):
        total = len(self.contacts)
        sent = sum(1 for c in self.contacts if c.status == MessageStatus.SENT)
        failed = sum(1 for c in self.contacts if c.status == MessageStatus.FAILED)
        skipped = sum(1 for c in self.contacts if c.status == MessageStatus.SKIPPED)
        pending = sum(1 for c in self.contacts if c.status in [MessageStatus.PENDING, MessageStatus.SENDING])

        progress = (sent + failed + skipped) / total * 100.0 if total > 0 else 0.0

        # Estimated time remaining based on average delay
        avg_delay = (self.config.min_delay_seconds + self.config.max_delay_seconds) / 2.0
        est_seconds = pending * (avg_delay + 4.0)

        self.stats = CampaignStats(
            total=total,
            sent=sent,
            failed=failed,
            skipped=skipped,
            pending=pending,
            progress_percent=round(progress, 1),
            is_running=self.is_running,
            is_paused=self.is_paused,
            current_index=self.stats.current_index,
            current_phone=self.stats.current_phone,
            current_name=self.stats.current_name,
            estimated_time_remaining_seconds=round(est_seconds, 0)
        )

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
            # Re-render messages with updated template if any
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

        # Start execution loop
        self._task = asyncio.create_task(self._run_loop())
        return True

    def pause_campaign(self):
        """Pause the active campaign."""
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
        await self.add_log("info", f"🚀 Starting SMS campaign for {len(self.contacts)} contacts.")
        await self.add_log("info", f"⏱ Random delay interval: {self.config.min_delay_seconds}s to {self.config.max_delay_seconds}s between messages.")

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

                # Skip contacts that are already processed
                if contact.status in [MessageStatus.SENT, MessageStatus.SKIPPED]:
                    continue

                if not contact.phone:
                    contact.status = MessageStatus.SKIPPED
                    contact.error = "Missing phone number"
                    await self.broadcast("contact_update", contact.model_dump())
                    continue

                # Update current contact status
                contact.status = MessageStatus.SENDING
                self.stats.current_index = idx + 1
                self.stats.current_phone = contact.phone
                self.stats.current_name = contact.name
                self.update_stats()
                await self.broadcast("contact_update", contact.model_dump())
                await self.broadcast("stats", self.stats.model_dump())

                msg_preview = contact.message if len(contact.message) <= 40 else contact.message[:37] + "..."
                await self.add_log("info", f"[{idx+1}/{len(self.contacts)}] Sending SMS to {contact.name or 'Unknown'} ({contact.phone}): '{msg_preview}'")

                # Send message via Google Messages engine
                success, error_msg = await self.engine.send_sms(contact.phone, contact.message)

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
                    # Check batch limits
                    if self.config.batch_size and self.config.batch_size > 0 and (messages_sent_in_batch % self.config.batch_size == 0):
                        batch_delay = self.config.batch_delay_seconds or 120.0
                        await self.add_log("warning", f"⏸ Batch of {self.config.batch_size} reached. Pausing for {batch_delay}s cooldown...")
                        for sec in range(int(batch_delay), 0, -1):
                            if self._stop_requested:
                                break
                            await self.broadcast("countdown", {"seconds": sec, "reason": "batch_pause"})
                            await asyncio.sleep(1)
                    else:
                        # Randomized delay between min and max
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
            self.update_stats()
            await self.broadcast("stats", self.stats.model_dump())
