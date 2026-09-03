import io
import re
import sys
import csv
import json
import uuid
import asyncio
from typing import List, Optional, Dict, Any
from pathlib import Path

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

from fastapi import FastAPI, UploadFile, File, Form, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import HTMLResponse, StreamingResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import pandas as pd

from models import (
    Contact,
    CampaignConfig,
    CampaignStats,
    PairingStatus,
    MessageStatus,
    SavedTemplate,
    BlacklistEntry,
    resolve_spintax,
    normalize_phone_number
)
from sender_engine import GoogleMessagesEngine
from campaign_manager import CampaignManager

app = FastAPI(title="Google Messages SMS Automator Pro", version="2.0.0")

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = Path(__file__).parent.resolve()
STATIC_DIR = BASE_DIR / "static"
UPLOADS_DIR = BASE_DIR / "uploads"
STATIC_DIR.mkdir(exist_ok=True)
UPLOADS_DIR.mkdir(exist_ok=True)

# Initialize engines
engine = GoogleMessagesEngine()
manager = CampaignManager(engine)
engine.log_callback = manager.add_log

# WebSocket connection manager
active_websockets: List[WebSocket] = []


async def websocket_event_dispatcher(event_type: str, data: Any):
    payload = json.dumps({"type": event_type, "data": data})
    disconnected = []
    for ws in active_websockets:
        try:
            await ws.send_text(payload)
        except Exception:
            disconnected.append(ws)
    for ws in disconnected:
        if ws in active_websockets:
            active_websockets.remove(ws)


manager.add_listener(websocket_event_dispatcher)


@app.get("/")
async def root():
    index_file = STATIC_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return HTMLResponse("<h1>Google Messages SMS Automator</h1><p>UI loading...</p>")


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    active_websockets.append(websocket)
    try:
        is_paired, status_text = await engine.check_pairing_status()
        await websocket.send_text(json.dumps({
            "type": "init",
            "data": {
                "stats": manager.stats.model_dump(),
                "contacts": [c.model_dump() for c in manager.contacts],
                "logs": [l.model_dump() for l in manager.logs[-100:]],
                "templates": [t.model_dump() for t in manager.get_templates()],
                "blacklist": [b.model_dump() for b in manager.get_blacklist()],
                "pairing": {
                    "is_paired": is_paired,
                    "browser_running": engine.page is not None and not engine.page.is_closed(),
                    "status_text": status_text
                }
            }
        }))
        while True:
            data = await websocket.receive_text()
    except WebSocketDisconnect:
        if websocket in active_websockets:
            active_websockets.remove(websocket)
    except Exception:
        if websocket in active_websockets:
            active_websockets.remove(websocket)


@app.get("/api/status")
async def get_status():
    is_paired, status_text = await engine.check_pairing_status()
    return {
        "pairing": {
            "is_paired": is_paired,
            "browser_running": engine.page is not None and not engine.page.is_closed(),
            "status_text": status_text
        },
        "stats": manager.stats.model_dump(),
        "config": manager.config.model_dump()
    }


@app.post("/api/pair")
async def pair_device(headless: bool = False):
    """Launch browser to show QR code for device pairing."""
    await manager.add_log("info", "Opening Google Messages pairing window...")
    launched = await engine.launch_browser(headless=headless)
    if not launched:
        raise HTTPException(status_code=500, detail="Failed to open browser.")
    
    is_paired, status_text = await engine.check_pairing_status()
    await manager.broadcast("pairing", {
        "is_paired": is_paired,
        "browser_running": True,
        "status_text": status_text
    })
    return {"success": True, "is_paired": is_paired, "status_text": status_text}


@app.get("/api/pairing/qr")
async def get_pairing_qr():
    """Retrieve the current QR code screenshot as base64 for in-browser scanning."""
    is_paired, status_text = await engine.check_pairing_status()
    if is_paired:
        return {"is_paired": True, "qr_image": None, "status_text": status_text}
    
    qr_base64 = await engine.get_qr_screenshot_base64()
    return {
        "is_paired": False,
        "qr_image": qr_base64,
        "status_text": status_text
    }


@app.post("/api/browser/close")
async def close_browser():
    await engine.close()
    await manager.broadcast("pairing", {
        "is_paired": False,
        "browser_running": False,
        "status_text": "Disconnected"
    })
    return {"success": True}


# ==========================================
# MMS Media Upload Endpoint
# ==========================================

@app.post("/api/upload-media")
async def upload_media(file: UploadFile = File(...)):
    """Upload image/flyer/banner for MMS campaigns."""
    filename = file.filename
    ext = Path(filename).suffix.lower()
    if ext not in [".png", ".jpg", ".jpeg", ".gif", ".webp"]:
        raise HTTPException(status_code=400, detail="Unsupported image format. Allowed: PNG, JPG, JPEG, GIF, WebP.")

    safe_name = f"{uuid.uuid4().hex[:10]}_{filename}"
    file_path = UPLOADS_DIR / safe_name

    contents = await file.read()
    with open(file_path, "wb") as f:
        f.write(contents)

    rel_url = f"/uploads/{safe_name}"
    await manager.add_log("info", f"Uploaded media attachment: {filename} ({len(contents)//1024} KB)")

    return {
        "success": True,
        "filename": filename,
        "url": rel_url,
        "filepath": str(file_path.resolve())
    }


# ==========================================
# Marketing Content Generator Endpoint
# ==========================================

@app.post("/api/marketing/generate")
async def generate_marketing_content(payload: Dict[str, Any]):
    """Generate high-converting marketing Spintax templates for various campaign goals."""
    topic = payload.get("topic", "promo").lower()
    biz = payload.get("business_name", "Our Store").strip() or "Our Store"
    offer = payload.get("offer", "Special deal").strip() or "Special deal"
    tone = payload.get("tone", "friendly").lower()

    options = []

    if topic == "promo":
        options = [
            f"{{Hey|Hi|Hello}} {{name}}! {biz} has {{an exclusive offer|a special promo|great news}} for you: {offer}. {{Use code SAVE at checkout|Visit our website to claim today|Don't miss out}}! {{Reply STOP to opt out|Text STOP to unsubscribe}}",
            f"{{Flash Sale|Limited Time Deal|Exclusive Alert}} for {{name}}! Get {offer} at {biz}. {{Shop now before it ends|Claim your discount online}}: {{link}} {{Reply STOP to cancel|Text STOP to opt out}}",
            f"{{Hi there|Hello}} {{name}}, {{we appreciate you|as a valued customer}}, enjoy {offer} on your next order with {biz}. {{Check it out here|Order now}}! {{Reply STOP to unsubscribe|Text STOP to opt out}}"
        ]
    elif topic == "reminder":
        options = [
            f"{{Hello|Hi}} {{name}}, {{friendly reminder|just a reminder}} from {biz} regarding your upcoming appointment. {{Please reply YES to confirm|Let us know if you need to reschedule}}! {{Reply STOP to opt out}}",
            f"{{Hi|Hey}} {{name}}! This is {biz} reminding you about your booking for tomorrow. {{Looking forward to seeing you|See you soon}}! {{Reply STOP to cancel}}",
            f"{{Reminder|Notice}}: {{name}}, your scheduled time with {biz} is coming up. {{Call us or reply to modify|Confirm by replying YES}}. {{Text STOP to opt out}}"
        ]
    elif topic == "followup":
        options = [
            f"{{Hey|Hi}} {{name}}, {{just checking in|following up}} from {biz}! {{Did you have any questions about|Were you able to check out}} {offer}? {{Let me know how I can help|Happy to assist}}! {{Reply STOP to opt out}}",
            f"{{Hello|Hi}} {{name}}, {{hope you're having a great week|hope all is well}}! {biz} is ready to help you with {offer}. {{Reply to this text to get started|Feel free to reach out anytime}}!",
            f"{{Hi|Hey}} {{name}}, {{quick question from|following up from}} {biz}: Are you still interested in {offer}? {{Let us know|We're here to help}}! {{Reply STOP to unsubscribe}}"
        ]
    elif topic == "review":
        options = [
            f"{{Hi|Hello}} {{name}}, {{thank you for choosing|thank you for visiting}} {biz}! {{How was your experience|We'd love your feedback}}: {{leave a quick review here|rate us online}}. {{Reply STOP to opt out}}",
            f"{{Hey|Hi}} {{name}}! {{We hope you loved your experience with|Thank you for shopping at}} {biz}. {{Could you leave us a quick review|Share your thoughts}}: {{link}}! {{Text STOP to opt out}}",
            f"{{Hello|Hi}} {{name}}, {{your feedback means the world to us|help us improve}} at {biz}. {{Drop us a quick rating|Tell us how we did}}! {{Reply STOP to cancel}}"
        ]
    elif topic == "event":
        options = [
            f"{{You're Invited|Exclusive Invitation}}, {{name}}! Join {biz} for {offer}. {{RSVP today to reserve your spot|Save your seat online}}! {{Reply STOP to opt out}}",
            f"{{Hey|Hi}} {{name}}! Don't miss the upcoming {biz} event: {offer}. {{Check the schedule and register|Get your tickets now}}! {{Text STOP to unsubscribe}}",
            f"{{Special Event Alert}}! {{name}}, {biz} is hosting {offer}. {{Join us this week|Click to learn more}}! {{Reply STOP to cancel}}"
        ]
    else:
        options = [
            f"{{Hello|Hi|Hey}} {{name}}, {biz} is reaching out with an update on {offer}. {{Reply to this message for details|Let us know how we can assist}}! {{Reply STOP to opt out}}",
            f"{{Hey|Hi}} {{name}}! {biz} has an update regarding {offer}. {{Let us know if you have questions|Contact us anytime}}! {{Text STOP to unsubscribe}}",
            f"{{Hello|Hi}} {{name}}, this is {biz}. {offer}. {{Have a great day|Thank you for your time}}! {{Reply STOP to cancel}}"
        ]

    return {
        "success": True,
        "topic": topic,
        "templates": options
    }


# ==========================================
# Spintax Preview Endpoint
# ==========================================

@app.post("/api/spintax/preview")
async def preview_spintax(payload: Dict[str, Any]):
    """Generate 5 live variations of a Spintax template with sample contact fields."""
    template = payload.get("template", "")
    sample = payload.get("sample", {"name": "John Doe", "phone": "+1234567890"})
    count = min(int(payload.get("count", 5)), 10)

    variations = []
    for _ in range(count):
        text = template
        for k, v in sample.items():
            pattern = re.compile(rf"\{{{k}\}}", re.IGNORECASE)
            text = pattern.sub(str(v), text)
        variations.append(resolve_spintax(text))

    return {"success": True, "variations": variations}


# ==========================================
# Templates Management Endpoints
# ==========================================

@app.get("/api/templates")
async def get_templates():
    return {"templates": [t.model_dump() for t in manager.get_templates()]}


@app.post("/api/templates")
async def save_template(payload: Dict[str, Any]):
    name = payload.get("name", "").strip()
    content = payload.get("content", "").strip()
    category = payload.get("category", "General").strip()
    template_id = payload.get("id", None)

    if not name or not content:
        raise HTTPException(status_code=400, detail="Name and content are required.")

    tpl = manager.save_template(name=name, content=content, category=category, template_id=template_id)
    await manager.add_log("success", f"Saved template: '{name}'")
    await manager.broadcast("templates_updated", [t.model_dump() for t in manager.get_templates()])
    return {"success": True, "template": tpl.model_dump()}


@app.delete("/api/templates/{template_id}")
async def delete_template(template_id: str):
    deleted = manager.delete_template(template_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Template not found.")
    await manager.broadcast("templates_updated", [t.model_dump() for t in manager.get_templates()])
    return {"success": True}


# ==========================================
# Blacklist / DNC Endpoints
# ==========================================

@app.get("/api/blacklist")
async def get_blacklist():
    return {"blacklist": [b.model_dump() for b in manager.get_blacklist()]}


@app.post("/api/blacklist")
async def add_to_blacklist(payload: Dict[str, Any]):
    phone = payload.get("phone", "").strip()
    reason = payload.get("reason", "Opted-out / Do Not Contact").strip()
    if not phone:
        raise HTTPException(status_code=400, detail="Phone number is required.")

    entry = manager.add_to_blacklist(phone, reason)
    await manager.add_log("warning", f"Added {entry.phone} to Blacklist / DNC.")
    await manager.broadcast("blacklist_updated", [b.model_dump() for b in manager.get_blacklist()])
    await manager.broadcast("contacts_loaded", [c.model_dump() for c in manager.contacts])
    return {"success": True, "entry": entry.model_dump()}


@app.delete("/api/blacklist/{phone}")
async def remove_from_blacklist(phone: str):
    removed = manager.remove_from_blacklist(phone)
    if not removed:
        raise HTTPException(status_code=404, detail="Number not in blacklist.")
    await manager.broadcast("blacklist_updated", [b.model_dump() for b in manager.get_blacklist()])
    return {"success": True}


# ==========================================
# Contacts & Campaign Endpoints
# ==========================================

@app.post("/api/contacts/upload")
async def upload_contacts(
    file: UploadFile = File(...),
    template: Optional[str] = Form(None),
    country_code: Optional[str] = Form("+1")
):
    """Upload CSV or Excel file of contacts."""
    contents = await file.read()
    filename = file.filename.lower()

    if country_code:
        manager.config.default_country_code = country_code

    try:
        if filename.endswith(".csv"):
            df = pd.read_csv(io.BytesIO(contents))
        elif filename.endswith((".xlsx", ".xls")):
            df = pd.read_excel(io.BytesIO(contents))
        elif filename.endswith(".txt"):
            lines = contents.decode("utf-8", errors="ignore").splitlines()
            records = [{"phone": line.strip()} for line in lines if line.strip()]
            df = pd.DataFrame(records)
        else:
            raise HTTPException(status_code=400, detail="Unsupported file format. Please upload CSV, XLSX, or TXT.")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to read file: {str(e)}")

    if df.empty:
        raise HTTPException(status_code=400, detail="The uploaded file contains no data.")

    cols = {str(c).strip().lower(): c for c in df.columns}
    phone_col = None
    for candidate in ["phone", "phonenumber", "phone_number", "mobile", "number", "tel", "cell", "contact"]:
        if candidate in cols:
            phone_col = cols[candidate]
            break
    if not phone_col and len(df.columns) > 0:
        phone_col = df.columns[0]

    name_col = None
    for candidate in ["name", "fullname", "full_name", "first_name", "firstname", "contact_name"]:
        if candidate in cols:
            name_col = cols[candidate]
            break

    contacts_data = []
    for _, row in df.iterrows():
        raw_phone = str(row[phone_col]).strip() if pd.notna(row[phone_col]) else ""
        if raw_phone.endswith(".0"):
            raw_phone = raw_phone[:-2]
        
        raw_name = str(row[name_col]).strip() if name_col and pd.notna(row[name_col]) else ""
        
        custom_fields = {}
        for col_name in df.columns:
            if col_name not in [phone_col, name_col]:
                val = row[col_name]
                custom_fields[str(col_name).strip()] = "" if pd.isna(val) else str(val).strip()

        contacts_data.append({
            "phone": raw_phone,
            "name": raw_name,
            **custom_fields
        })

    manager.set_contacts(contacts_data, template=template)
    await manager.add_log("info", f"Uploaded {len(contacts_data)} contacts from '{file.filename}'.")
    await manager.broadcast("contacts_loaded", [c.model_dump() for c in manager.contacts])
    await manager.broadcast("stats", manager.stats.model_dump())

    return {
        "success": True,
        "count": len(contacts_data),
        "columns": list(df.columns),
        "contacts": [c.model_dump() for c in manager.contacts]
    }


@app.post("/api/contacts/manual")
async def manual_contacts(payload: Dict[str, Any]):
    """Add contacts manually via text input."""
    raw_text = payload.get("text", "")
    template = payload.get("template", None)
    country_code = payload.get("country_code", "+1")

    if country_code:
        manager.config.default_country_code = country_code

    lines = raw_text.strip().splitlines()
    records = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        if "," in line:
            parts = [p.strip() for p in line.split(",")]
            records.append({"phone": parts[0], "name": parts[1] if len(parts) > 1 else ""})
        else:
            records.append({"phone": line, "name": ""})

    if not records:
        raise HTTPException(status_code=400, detail="No contacts provided.")

    manager.set_contacts(records, template=template)
    await manager.add_log("info", f"Loaded {len(records)} manual contacts.")
    await manager.broadcast("contacts_loaded", [c.model_dump() for c in manager.contacts])
    await manager.broadcast("stats", manager.stats.model_dump())

    return {"success": True, "count": len(records), "contacts": [c.model_dump() for c in manager.contacts]}


@app.get("/api/contacts")
async def get_contacts():
    return {"contacts": [c.model_dump() for c in manager.contacts]}


@app.post("/api/campaign/retry-failed")
async def retry_failed_campaign():
    """1-Click retry all failed contacts."""
    count = manager.retry_failed_contacts()
    if count == 0:
        return {"success": True, "count": 0, "message": "No failed contacts to retry."}

    await manager.add_log("info", f"Queued {count} failed contacts back to pending for retry.")
    await manager.broadcast("contacts_loaded", [c.model_dump() for c in manager.contacts])
    await manager.broadcast("stats", manager.stats.model_dump())
    return {"success": True, "count": count, "message": f"Queued {count} contacts for retry."}


@app.post("/api/campaign/start")
async def start_campaign(config: Optional[CampaignConfig] = None):
    success = await manager.start_campaign(config)
    if not success:
        raise HTTPException(status_code=400, detail="Cannot start campaign. Check if contacts are loaded and phone is paired.")
    return {"success": True, "message": "Campaign started"}


@app.post("/api/campaign/pause")
async def pause_campaign():
    manager.pause_campaign()
    await manager.add_log("info", "Campaign paused.")
    await manager.broadcast("stats", manager.stats.model_dump())
    return {"success": True}


@app.post("/api/campaign/resume")
async def resume_campaign():
    manager.resume_campaign()
    await manager.add_log("info", "Campaign resumed.")
    await manager.broadcast("stats", manager.stats.model_dump())
    return {"success": True}


@app.post("/api/campaign/stop")
async def stop_campaign():
    manager.stop_campaign()
    await manager.broadcast("stats", manager.stats.model_dump())
    return {"success": True}


@app.post("/api/campaign/reset")
async def reset_campaign():
    for c in manager.contacts:
        c.status = MessageStatus.PENDING
        c.error = None
        c.sent_at = None
    manager.update_stats()
    await manager.add_log("info", "Campaign contacts reset to pending.")
    await manager.broadcast("contacts_loaded", [c.model_dump() for c in manager.contacts])
    await manager.broadcast("stats", manager.stats.model_dump())
    return {"success": True}


@app.get("/api/campaign/export")
async def export_campaign():
    """Export campaign results to CSV."""
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["ID", "Phone", "Name", "Message", "Status", "Sent At", "Error Details"])

    for c in manager.contacts:
        writer.writerow([c.id, c.phone, c.name, c.message, c.status.value, c.sent_at or "", c.error or ""])

    output.seek(0)
    response = StreamingResponse(iter([output.getvalue()]), media_type="text/csv")
    response.headers["Content-Disposition"] = "attachment; filename=sms_campaign_report.csv"
    return response


@app.get("/api/logs")
async def get_logs():
    return {"logs": [l.model_dump() for l in manager.logs]}


# Mount static & uploads directories
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
app.mount("/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")
