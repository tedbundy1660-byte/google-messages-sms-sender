import io
import asyncio
from fastapi.testclient import TestClient
from app import app, manager, engine
from models import (
    CampaignConfig,
    MessageStatus,
    Contact,
    resolve_spintax,
    normalize_phone_number
)

client = TestClient(app)


def test_root_endpoint():
    response = client.get("/")
    assert response.status_code == 200


def test_api_status():
    response = client.get("/api/status")
    assert response.status_code == 200
    data = response.json()
    assert "pairing" in data
    assert "stats" in data
    assert "config" in data


def test_spintax_resolver():
    # Simple spintax
    template = "{Hello|Hi|Hey} World"
    results = set()
    for _ in range(30):
        res = resolve_spintax(template)
        assert res in ["Hello World", "Hi World", "Hey World"]
        results.add(res)
    assert len(results) > 1  # Verify randomness

    # Nested spintax
    nested = "{Hi|{Hello|Hey}} {there|friend}"
    nested_res = resolve_spintax(nested)
    assert any(w in nested_res for w in ["Hi", "Hello", "Hey"])


def test_phone_number_normalizer():
    # Standard format
    assert normalize_phone_number("+12566255444") == "+12566255444"
    # Dirty input with parentheses & dashes
    assert normalize_phone_number("(256) 625-5444", default_country_code="+1") == "+12566255444"
    # Dots format
    assert normalize_phone_number("346.859.1090", default_country_code="+1") == "+13468591090"
    # UK number with spaces
    assert normalize_phone_number("+44 7911 123456") == "+447911123456"
    # 10 digits without plus
    assert normalize_phone_number("2566255444", default_country_code="+1") == "+12566255444"


def test_manual_contacts_and_templating():
    payload = {
        "text": "(256) 625-5444, Alice\n346-859-1090, Bob",
        "template": "{Hello|Hi} {name}, your phone is {phone}!",
        "country_code": "+1"
    }
    response = client.post("/api/contacts/manual", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    assert data["count"] == 2
    
    first = data["contacts"][0]
    assert first["name"] == "Alice"
    assert first["phone"] == "+12566255444"
    assert "Alice" in first["message"]
    assert "+12566255444" in first["message"]


def test_templates_api():
    # 1. Create template
    payload = {
        "name": "Test Promo Template",
        "category": "Marketing",
        "content": "{Hey|Hello} {name}, check out our new sale!"
    }
    create_res = client.post("/api/templates", json=payload)
    assert create_res.status_code == 200
    data = create_res.json()
    assert data["success"] is True
    tpl_id = data["template"]["id"]

    # 2. Get templates
    get_res = client.get("/api/templates")
    assert get_res.status_code == 200
    templates = get_res.json()["templates"]
    assert any(t["id"] == tpl_id for t in templates)

    # 3. Delete template
    del_res = client.delete(f"/api/templates/{tpl_id}")
    assert del_res.status_code == 200


def test_blacklist_api():
    # 1. Add to blacklist
    phone = "+19998887777"
    add_res = client.post("/api/blacklist", json={"phone": phone, "reason": "STOP request"})
    assert add_res.status_code == 200

    # 2. Verify contact loading marks as blacklisted
    manager.set_contacts([{"phone": phone, "name": "Blocked User"}])
    assert manager.contacts[0].status == MessageStatus.BLACKLISTED
    assert "Blacklisted" in manager.contacts[0].error

    # 3. Remove from blacklist
    del_res = client.delete(f"/api/blacklist/{phone}")
    assert del_res.status_code == 200


def test_spintax_preview_api():
    payload = {
        "template": "{Hello|Hi|Hey} {name}, order #{phone} ready!",
        "sample": {"name": "Charlie", "phone": "+123456"},
        "count": 5
    }
    response = client.post("/api/spintax/preview", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    assert len(data["variations"]) == 5
    assert all("Charlie" in v for v in data["variations"])


def test_retry_failed_contacts():
    # Setup 2 contacts: 1 sent, 1 failed
    contacts = [
        {"phone": "+1111111111", "name": "Sent User"},
        {"phone": "+2222222222", "name": "Failed User"}
    ]
    manager.set_contacts(contacts, template="Hello {name}")
    manager.contacts[0].status = MessageStatus.SENT
    manager.contacts[1].status = MessageStatus.FAILED
    manager.contacts[1].error = "Carrier error"

    # Call retry failed
    response = client.post("/api/campaign/retry-failed")
    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    assert data["count"] == 1

    # Verify contact 1 remained sent, contact 2 was reset to pending
    assert manager.contacts[0].status == MessageStatus.SENT
    assert manager.contacts[1].status == MessageStatus.PENDING
    assert manager.contacts[1].error is None


def test_mms_media_upload():
    # Create fake image bytes
    fake_png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4"
    files = {"file": ("banner.png", io.BytesIO(fake_png), "image/png")}

    response = client.post("/api/upload-media", files=files)
    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    assert "url" in data
    assert "filepath" in data
    assert data["filename"] == "banner.png"


def test_export_csv():
    response = client.get("/api/campaign/export")
    assert response.status_code == 200
    assert "text/csv" in response.headers["content-type"]
    assert "ID,Phone,Name,Message,Status,Sent At,Error Details" in response.text


if __name__ == "__main__":
    print("Running automated Pro test suite...")
    test_root_endpoint()
    test_api_status()
    test_spintax_resolver()
    test_phone_number_normalizer()
    test_manual_contacts_and_templating()
    test_templates_api()
    test_blacklist_api()
    test_spintax_preview_api()
    test_retry_failed_contacts()
    test_mms_media_upload()
    test_export_csv()
    print("All 11 tests passed successfully!")
