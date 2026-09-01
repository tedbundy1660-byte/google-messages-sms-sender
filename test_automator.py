import asyncio
from fastapi.testclient import TestClient
from app import app, manager, engine
from models import CampaignConfig, MessageStatus, Contact

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

def test_manual_contacts_and_templating():
    payload = {
        "text": "+15551234567, Alice\n+15559876543, Bob",
        "template": "Hello {name}, your phone is {phone}!"
    }
    response = client.post("/api/contacts/manual", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    assert data["count"] == 2
    assert len(data["contacts"]) == 2
    
    first = data["contacts"][0]
    assert first["name"] == "Alice"
    assert first["phone"] == "+15551234567"
    assert first["message"] == "Hello Alice, your phone is +15551234567!"

def test_campaign_manager_state_transitions():
    contacts = [
        {"phone": "+1234567890", "name": "User 1"},
        {"phone": "+1987654321", "name": "User 2"}
    ]
    manager.set_contacts(contacts, template="Test message to {name}")
    assert len(manager.contacts) == 2
    assert manager.stats.total == 2
    assert manager.stats.pending == 2

    manager.pause_campaign()
    assert manager.is_paused is False  # not running yet

    manager.stop_campaign()
    assert manager.is_running is False

def test_export_csv():
    response = client.get("/api/campaign/export")
    assert response.status_code == 200
    assert "text/csv" in response.headers["content-type"]
    assert "ID,Phone,Name,Message,Status,Sent At,Error Details" in response.text

if __name__ == "__main__":
    print("Running automated tests...")
    test_root_endpoint()
    test_api_status()
    test_manual_contacts_and_templating()
    test_campaign_manager_state_transitions()
    test_export_csv()
    print("All tests passed successfully!")
