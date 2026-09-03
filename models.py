import re
import enum
import random
from typing import Dict, List, Optional, Any
from pydantic import BaseModel, Field


def resolve_spintax(text: str) -> str:
    """
    Recursively resolves Spintax variations formatted like:
    {Hello|Hi|Hey} {name}, {check this out|special deal for you}!
    Supports nested spintax structures.
    """
    if not text:
        return ""

    pattern = re.compile(r'\{([^{}]+)\}')
    while pattern.search(text):
        text = pattern.sub(lambda match: random.choice(match.group(1).split('|')), text)
    return text


def normalize_phone_number(raw_phone: str, default_country_code: str = "+1") -> str:
    """
    Cleans dirty phone numbers, strips non-digits, and applies default country code if missing.
    Examples:
      '(256) 625-5444' -> '+12566255444'
      '346-859-1090'   -> '+13468591090'
      '+44 7911 123456' -> '+447911123456'
      '12566255444'    -> '+12566255444'
    """
    if not raw_phone:
        return ""

    raw_str = str(raw_phone).strip()
    # Remove trailing excel float '.0'
    if raw_str.endswith(".0"):
        raw_str = raw_str[:-2]

    # Extract clean digits and check leading plus
    has_plus = raw_str.startswith("+")
    digits = "".join([c for c in raw_str if c.isdigit()])

    if not digits:
        return raw_str

    if has_plus:
        return f"+{digits}"

    # If it starts with '1' and has 11 digits (North America with leading country code)
    if default_country_code in ["+1", "1"] and len(digits) == 11 and digits.startswith("1"):
        return f"+{digits}"

    # If 10 digits without country code (e.g. US 10-digit number)
    if len(digits) == 10:
        cc = default_country_code.strip()
        if not cc.startswith("+"):
            cc = f"+{cc}"
        return f"{cc}{digits}"

    # General fallback
    cc = default_country_code.strip()
    if not cc.startswith("+"):
        cc = f"+{cc}"
    return f"{cc}{digits}" if not digits.startswith(cc.lstrip("+")) else f"+{digits}"


class MessageStatus(str, enum.Enum):
    PENDING = "pending"
    SENDING = "sending"
    SENT = "sent"
    FAILED = "failed"
    SKIPPED = "skipped"
    BLACKLISTED = "blacklisted"


class Contact(BaseModel):
    id: int
    phone: str
    name: Optional[str] = ""
    custom_data: Dict[str, Any] = Field(default_factory=dict)
    message: Optional[str] = ""
    status: MessageStatus = MessageStatus.PENDING
    error: Optional[str] = None
    sent_at: Optional[str] = None


class CampaignConfig(BaseModel):
    min_delay_seconds: float = Field(default=15.0, ge=1.0, description="Minimum random delay between SMS")
    max_delay_seconds: float = Field(default=45.0, ge=1.0, description="Maximum random delay between SMS")
    message_template: str = Field(default="Hello {name}, this is a test message.")
    image_path: Optional[str] = Field(default=None, description="Optional image/attachment path for MMS")
    batch_size: Optional[int] = Field(default=0, description="Pause after N messages (0 for continuous)")
    batch_delay_seconds: Optional[float] = Field(default=300.0, description="Seconds to pause between batches")
    default_country_code: str = Field(default="+1", description="Default country code to prepend if missing")
    headless: bool = Field(default=False, description="Run browser in background after pairing")
    auto_optout: bool = Field(default=False, description="Automatically append opt-out message")
    optout_text: str = Field(default="{Reply STOP to opt out|Text STOP to unsubscribe}", description="Opt-out notice phrasing")
    enforce_single_sms: bool = Field(default=False, description="Strictly limit and correct message to single SMS segment (160 chars)")
    max_character_limit: int = Field(default=160, description="Max character limit per SMS (160 standard)")


class MarketingPromptRequest(BaseModel):
    topic: str = Field(default="promo", description="Topic: promo, reminder, followup, review, event")
    business_name: Optional[str] = Field(default="Our Store", description="Business or Brand Name")
    offer: Optional[str] = Field(default="20% off", description="Offer details or call to action")
    tone: Optional[str] = Field(default="friendly", description="Tone: friendly, urgent, professional, casual")


class SavedTemplate(BaseModel):
    id: str
    name: str
    content: str
    category: Optional[str] = "General"
    created_at: str


class BlacklistEntry(BaseModel):
    phone: str
    reason: Optional[str] = "Opted-out / Do Not Contact"
    added_at: str


class CampaignStats(BaseModel):
    total: int = 0
    sent: int = 0
    failed: int = 0
    pending: int = 0
    skipped: int = 0
    blacklisted: int = 0
    progress_percent: float = 0.0
    is_running: bool = False
    is_paused: bool = False
    is_batch_paused: bool = False
    batch_pause_remaining_seconds: float = 0.0
    current_index: int = 0
    current_phone: Optional[str] = None
    current_name: Optional[str] = None
    estimated_time_remaining_seconds: Optional[float] = 0.0


class LogEntry(BaseModel):
    timestamp: str
    level: str  # 'info', 'success', 'warning', 'error'
    message: str


class PairingStatus(BaseModel):
    is_paired: bool = False
    browser_running: bool = False
    status_text: str = "Disconnected"
    detail: Optional[str] = None
