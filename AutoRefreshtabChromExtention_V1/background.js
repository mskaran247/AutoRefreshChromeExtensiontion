// --- background.js ---
// This script runs continuously in the background and handles the actual refreshing
// and cache clearing. It listens for alarms and messages from the popup.
// This is a Service Worker, which is event-driven.

// Map to store active alarms by tabId, allowing us to manage them
const activeAlarms = new Map();

// Function to clear browsing data (specifically cache)
async function clearBrowsingData() {
    try {
        // chrome.browsingData.remove clears data from a specified time range.
        // "since": 0 means clear all data since the beginning of time.
        // "cache": true specifies that only the cache should be cleared.
        await chrome.browsingData.remove({
            "since": 0
        }, {
            "cache": true
        });
        console.log("Cache cleared successfully.");
    } catch (error) {
        console.error("Error clearing cache:", error);
    }
}

// Listener for alarm events. This function is called when a scheduled alarm fires.
chrome.alarms.onAlarm.addListener(async (alarm) => {
    // Check if the alarm is one of our refresh alarms (named "refresh-tab-<tabId>")
    if (alarm.name.startsWith("refresh-tab-")) {
        const tabId = parseInt(alarm.name.split('-')[2]); // Extract tabId from alarm name

        // Retrieve the saved settings for this specific tab
        const result = await chrome.storage.local.get([`refreshSettings_${tabId}`]);
        const settings = result[`refreshSettings_${tabId}`];

        // Only proceed if settings exist and refresh is still active for this tab
        if (settings && settings.isRefreshing) {
            if (settings.clearCache) {
                await clearBrowsingData(); // Clear cache if enabled in settings
            }
            // Reload the tab. `bypassCache` ensures a fresh load if cache was cleared.
            chrome.tabs.reload(tabId, { bypassCache: settings.clearCache }, () => {
                // Check for any errors during tab reload (e.g., tab was closed)
                if (chrome.runtime.lastError) {
                    console.error(`Error reloading tab ${tabId}:`, chrome.runtime.lastError.message);
                    // If the tab no longer exists, clear its alarm and settings
                    if (chrome.runtime.lastError.message.includes("No tab with id")) {
                        chrome.alarms.clear(alarm.name);
                        activeAlarms.delete(tabId);
                        chrome.storage.local.remove([`refreshSettings_${tabId}`]);
                    }
                } else {
                    console.log(`Tab ${tabId} refreshed.`);
                }
            });
        } else {
            // If refresh is no longer active or settings are gone, clear the alarm
            chrome.alarms.clear(alarm.name);
            activeAlarms.delete(tabId);
            console.log(`Stopped refresh for tab ${tabId} due to settings change or absence.`);
        }
    }
});

// Listener for messages sent from the popup script (popup.js)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'startRefresh') {
        const alarmName = `refresh-tab-${request.tabId}`;
        // Clear any existing alarm for this tab to prevent duplicates
        chrome.alarms.clear(alarmName);
        activeAlarms.delete(request.tabId);

        // Create a new alarm with the specified interval.
        // `delayInMinutes` is for the first trigger, `periodInMinutes` for subsequent ones.
        // We convert milliseconds to minutes as `alarms.create` expects minutes.
        chrome.alarms.create(alarmName, {
            delayInMinutes: request.interval / 60000,
            periodInMinutes: request.interval / 60000
        });
        activeAlarms.set(request.tabId, alarmName); // Track the active alarm
        console.log(`Started refresh for tab ${request.tabId} every ${request.interval / 1000} seconds.`);
        sendResponse({ success: true }); // Acknowledge message receipt
    } else if (request.action === 'stopRefresh') {
        const alarmName = `refresh-tab-${request.tabId}`;
        // Clear the alarm associated with the tab
        chrome.alarms.clear(alarmName, (wasCleared) => {
            if (wasCleared) {
                activeAlarms.delete(request.tabId); // Remove from our tracking map
                console.log(`Stopped refresh for tab ${request.tabId}.`);
                sendResponse({ success: true });
            } else {
                console.warn(`No active alarm found for tab ${request.tabId} to stop.`);
                sendResponse({ success: false, message: 'No active refresh for this tab.' });
            }
        });
        // Important: Return true to indicate that sendResponse will be called asynchronously.
        // This keeps the message channel open until sendResponse is called.
        return true;
    }
});

// Listener for when a tab is closed. This helps clean up resources.
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    const alarmName = `refresh-tab-${tabId}`;
    if (activeAlarms.has(tabId)) {
        chrome.alarms.clear(alarmName); // Clear the alarm if the tab was being refreshed
        activeAlarms.delete(tabId);
        console.log(`Cleaned up alarm for closed tab ${tabId}.`);
    }
    // Also remove the stored settings for the closed tab to keep storage clean
    chrome.storage.local.remove([`refreshSettings_${tabId}`]);
});

// Listener for when the extension is installed or updated, or Chrome starts up.
// This allows the extension to re-establish any previously active refreshes.
chrome.runtime.onInstalled.addListener(() => {
    // Retrieve all stored refresh settings
    chrome.storage.local.get(null, (items) => {
        for (const key in items) {
            // Iterate through all stored items to find refresh settings
            if (key.startsWith('refreshSettings_')) {
                const tabId = parseInt(key.split('_')[1]); // Extract tab ID
                const settings = items[key];
                // If settings indicate active refresh and valid time, re-create the alarm
                if (settings.isRefreshing && settings.minutes !== undefined && settings.seconds !== undefined) {
                    const intervalMs = (settings.minutes * 60 + settings.seconds) * 1000;
                    if (intervalMs > 0) {
                        const alarmName = `refresh-tab-${tabId}`;
                        chrome.alarms.create(alarmName, {
                            delayInMinutes: intervalMs / 60000,
                            periodInMinutes: intervalMs / 60000
                        });
                        activeAlarms.set(tabId, alarmName);
                        console.log(`Re-established refresh for tab ${tabId} every ${intervalMs / 1000} seconds.`);
                    }
                }
            }
        }
    });
});
