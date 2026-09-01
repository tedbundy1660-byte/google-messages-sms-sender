import sys
import asyncio
import webbrowser
import threading
import time
import uvicorn

# Ensure Windows uses ProactorEventLoop for Playwright subprocess compatibility
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

def open_browser():
    time.sleep(1.5)
    webbrowser.open("http://127.0.0.1:8000")

if __name__ == "__main__":
    print("==================================================")
    print("  Google Messages SMS Automator")
    print("  Server starting at: http://127.0.0.1:8000")
    print("==================================================")
    
    # Auto-open browser in background thread
    threading.Thread(target=open_browser, daemon=True).start()
    
    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=False, log_level="info", loop="asyncio")

