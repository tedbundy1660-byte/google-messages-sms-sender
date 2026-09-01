import enum
from typing import Dict, List, Optional, Any
from pydantic import BaseModel, Field


class MessageStatus(str, enum.Enum):
    PENDING = "pending"
    SENDING = "sending"
    SENT = "sent"
    FAILED = "failed"
    SKIPPED = "skipped"


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
    batch_size: Optional[int] = Field(default=0, description="Pause after N messages (0 for continuous)")
    batch_delay_seconds: Optional[float] = Field(default=120.0, description="Seconds to pause between batches")
    headless: bool = Field(default=False, description="Run browser in background after pairing")


class CampaignStats(BaseModel):
    total: int = 0
    sent: int = 0
    failed: int = 0
    pending: int = 0
    skipped: int = 0
    progress_percent: float = 0.0
    is_running: bool = False
    is_paused: bool = False
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
