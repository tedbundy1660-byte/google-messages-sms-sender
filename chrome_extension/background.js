// Configure side panel to open when extension icon is clicked
chrome.runtime.onInstalled.addListener(() => {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
        console.error("Error setting panel behavior:", error);
    });
    console.log("Google Messages SMS Bulk Automator extension installed successfully.");
});

// Fallback action click handler in case browser requires explicit open
chrome.action.onClicked.addListener(async (tab) => {
    try {
        if (tab.windowId) {
            await chrome.sidePanel.open({ windowId: tab.windowId });
        }
    } catch (e) {
        console.error("Error opening side panel:", e);
    }
});
