# Google Messages SMS Automator

A automated SMS sender for Windows powered by **Google Messages Web**. It pairs with your Android smartphone once, securely stores your session locally, and allows bulk SMS dispatching with randomized anti-spam delays, personalized templates, and real-time dashboard tracking.

---

## 🌟 Key Features

1. **One-Time Phone Pairing**
   - Seamlessly pairs with Google Messages via QR code.
   - Saves persistent session data in `./user_data`, eliminating repeated scans.

2. **Smart Dynamic Templating**
   - Custom tags support: `{name}`, `{phone}`, and any custom column from your CSV/Excel files (e.g., `{company}`, `{due_date}`).
   - Live character and SMS segment counter (160 chars per SMS).

3. **Randomized Anti-Spam Delays**
   - Configurable minimum and maximum delays (e.g., 15s–45s) between messages.
   - Batch cooldown pauses (e.g. pause 2 minutes after 20 messages).
   - Simulates human dispatching to keep sending natural.

4. **Real-Time Live Dashboard**
   - WebSocket streaming for instant updates.
   - Progress bar, remaining time estimate, and individual status tracking (`Pending`, `Sending`, `Sent`, `Failed`).
   - Live color-coded console logs.
   - Pause, Resume, Stop, and CSV Export controls.

---

## 🚀 Quick Start

### 1. Launch the Application
Double-click `run_app.bat` or run:
```bash
python main.py
```
This starts the local web server and opens the dashboard at `http://127.0.0.1:8000`.

### 2. Pair Your Android Phone
1. Click **"Pair Device / Open Browser"** in the top right corner.
2. A Chromium browser window opens to Google Messages Web.
3. On your phone, open **Google Messages > Profile icon > Device pairing > QR code scanner**.
4. Scan the QR code on your computer screen.
5. The status badge will change to **Connected & Paired**.

### 3. Load Contacts & Compose Message
- **Upload CSV / Excel**: Drag and drop your file or select `sample_contacts.csv`.
- **Compose Template**: Type your message using dynamic tag buttons (e.g., `Hello {name}, your order with {company} is ready!`).

### 4. Configure Delays & Send
- Adjust the **Min Delay** and **Max Delay** sliders (recommended: 15s to 45s).
- Click **"Start Campaign"** to watch the automator dispatch messages in real-time.

---

## 📁 CSV Format Example
```csv
phone,name,company
+12345678901,Alice Johnson,Acme Corp
+12345678902,Bob Smith,Apex Logistics
+12345678903,Charlie Davis,Global Tech
```
