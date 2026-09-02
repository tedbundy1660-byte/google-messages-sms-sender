import io
import sys
import csv
import json
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

from models import Contact, CampaignConfig, CampaignStats, PairingStatus, MessageStatus
from sender_engine import GoogleMessagesEngine
from campaign_manager import CampaignManager

app = FastAPI(title="Google Messages SMS Automator", version="1.0.0")

# Enable CORS for flexibility
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = Path(__file__).parent.resolve()
STATIC_DIR = BASE_DIR / "static"
STATIC_DIR.mkdir(exist_ok=True)

# Initialize engines
engine = GoogleMessagesEngine()
manager = CampaignManager(engine)

# Pass logger callback from engine to campaign manager
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
        # Send initial state
        is_paired, status_text = await engine.check_pairing_status()
        await websocket.send_text(json.dumps({
            "type": "init",
            "data": {
                "stats": manager.stats.model_dump(),
                "contacts": [c.model_dump() for c in manager.contacts],
                "logs": [l.model_dump() for l in manager.logs[-100:]],
                "pairing": {
                    "is_paired": is_paired,
                    "browser_running": engine.page is not None and not engine.page.is_closed(),
                    "status_text": status_text
                }
            }
        }))
        while True:
            # Keep alive and listen for client commands if any
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


@app.post("/api/contacts/upload")
async def upload_contacts(file: UploadFile = File(...), template: Optional[str] = Form(None)):
    """Upload CSV or Excel file of contacts."""
    contents = await file.read()
    filename = file.filename.lower()

    try:
        if filename.endswith(".csv"):
            df = pd.read_csv(io.BytesIO(contents))
        elif filename.endswith((".xlsx", ".xls")):
            df = pd.read_excel(io.BytesIO(contents))
        elif filename.endswith(".txt"):
            # Plain text with one phone number per line
            lines = contents.decode("utf-8", errors="ignore").splitlines()
            records = [{"phone": line.strip()} for line in lines if line.strip()]
            df = pd.DataFrame(records)
        else:
            raise HTTPException(status_code=400, detail="Unsupported file format. Please upload CSV, XLSX, or TXT.")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to read file: {str(e)}")

    if df.empty:
        raise HTTPException(status_code=400, detail="The uploaded file contains no data.")

    # Find phone and name columns case-insensitively
    cols = {str(c).strip().lower(): c for c in df.columns}
    
    phone_col = None
    for candidate in ["phone", "phonenumber", "phone_number", "mobile", "number", "tel", "cell", "contact"]:
        if candidate in cols:
            phone_col = cols[candidate]
            break
    if not phone_col and len(df.columns) > 0:
        # Default to first column
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
            raw_phone = raw_phone[:-2]  # Fix float formatting from excel
        
        raw_name = str(row[name_col]).strip() if name_col and pd.notna(row[name_col]) else ""
        
        # Build extra custom columns
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

    lines = raw_text.strip().splitlines()
    records = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        # Check if CSV line (e.g. "+1234567890, John Doe")
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


# Mount static assets
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
