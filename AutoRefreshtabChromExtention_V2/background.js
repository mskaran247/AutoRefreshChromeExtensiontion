// --- background.js ---
// This script runs continuously in the background and handles the actual refreshing
// and cache clearing. It listens for alarms and messages from the popup.
// This is a Service Worker, which is event-driven.

// Map to store active alarms for individual tabs (if 'activeTab' scope is used)
const activeTabAlarms = new Map();
const globalRefreshAlarmName = 'global-refresh-alarm';

// Global variables for badge countdown
let countdownIntervalId = null;
let currentCountdownSeconds = 0;
let currentRefreshIntervalSeconds = 0;
let currentActiveScope = null; // 'activeTab' or 'allTabs'

// Function to clear browsing data (specifically cache)
async function clearBrowsingData() {
    try {
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

// Function to start the badge countdown
function startBadgeCountdown(intervalSeconds, scope) {
    // Clear any existing countdown
    if (countdownIntervalId) {
        clearInterval(countdownIntervalId);
    }

    currentRefreshIntervalSeconds = intervalSeconds;
    currentCountdownSeconds = intervalSeconds; // Start from full interval
    currentActiveScope = scope;

    // Set initial badge text and color
    chrome.action.setBadgeText({ text: String(currentCountdownSeconds) });
    chrome.action.setBadgeBackgroundColor({ color: '#2ecc71' }); // Green for ON

    countdownIntervalId = setInterval(() => {
        currentCountdownSeconds--;
        if (currentCountdownSeconds < 0) {
            // This should ideally not happen if alarms are perfectly synced,
            // but as a fallback, reset to full interval for the next cycle.
            currentCountdownSeconds = currentRefreshIntervalSeconds;
        }
        chrome.action.setBadgeText({ text: String(currentCountdownSeconds) });
    }, 1000); // Update every second
}

// Function to stop the badge countdown
function stopBadgeCountdown() {
    if (countdownIntervalId) {
        clearInterval(countdownIntervalId);
        countdownIntervalId = null;
    }
    chrome.action.setBadgeText({ text: '' }); // Clear badge text
    chrome.action.setBadgeBackgroundColor({ color: [0, 0, 0, 0] }); // Transparent
    currentCountdownSeconds = 0;
    currentRefreshIntervalSeconds = 0;
    currentActiveScope = null;
}


// Listener for alarm events. This function is called when a scheduled alarm fires.
chrome.alarms.onAlarm.addListener(async (alarm) => {
    // Handle individual tab refresh alarms
    if (alarm.name.startsWith("refresh-tab-")) {
        const tabId = parseInt(alarm.name.split('-')[2]);
        const allSettings = await chrome.storage.local.get(['refreshSettings']);
        const settings = allSettings.refreshSettings?.['activeTab']; // Get settings for activeTab scope

        // Ensure this alarm is for the currently active tab refresh and it's still active
        // and the tab itself still exists
        chrome.tabs.get(tabId, async (tab) => {
            if (chrome.runtime.lastError || !tab) {
                console.warn(`Tab ${tabId} not found or error: ${chrome.runtime.lastError?.message || 'Tab does not exist'}. Clearing alarm.`);
                chrome.alarms.clear(alarm.name);
                activeTabAlarms.delete(tabId);
                // Clean up settings for non-existent tab
                chrome.storage.local.get(['refreshSettings'], (result) => {
                    const currentSettings = result.refreshSettings || {};
                    if (currentSettings['activeTab'] && currentSettings['activeTab'].isRefreshing && currentSettings['activeTab'].tabId === tabId) {
                        currentSettings['activeTab'].isRefreshing = false;
                    }
                    chrome.storage.local.set({ refreshSettings: currentSettings });
                });
                // If this was the active countdown, stop it
                if (currentActiveScope === 'activeTab' && currentRefreshIntervalSeconds > 0) {
                    stopBadgeCountdown();
                }
                return;
            }

            // Check if the current active tab is indeed the one we're refreshing
            // and if the refresh for 'activeTab' scope is still marked as active in storage
            if (settings && settings.isRefreshing && settings.tabId === tabId) {
                if (settings.clearCache) {
                    await clearBrowsingData();
                }
                chrome.tabs.reload(tabId, { bypassCache: settings.clearCache }, () => {
                    if (chrome.runtime.lastError) {
                        console.error(`Error reloading tab ${tabId}:`, chrome.runtime.lastError.message);
                    } else {
                        console.log(`Active tab ${tabId} refreshed.`);
                        // Reset countdown after successful refresh
                        if (currentActiveScope === 'activeTab' && currentRefreshIntervalSeconds > 0) {
                            currentCountdownSeconds = currentRefreshIntervalSeconds;
                            chrome.action.setBadgeText({ text: String(currentCountdownSeconds) });
                        }
                    }
                });
            } else {
                // If settings indicate not refreshing or tabId mismatch, clear the alarm
                chrome.alarms.clear(alarm.name);
                activeTabAlarms.delete(tabId);
                console.log(`Stopped refresh for tab ${tabId} due to settings change or tabId mismatch.`);
                if (currentActiveScope === 'activeTab' && currentRefreshIntervalSeconds > 0) {
                    stopBadgeCountdown();
                }
            }
        });
    }
    // Handle global refresh alarm
    else if (alarm.name === globalRefreshAlarmName) {
        const allSettings = await chrome.storage.local.get(['refreshSettings']);
        const globalSettings = allSettings.refreshSettings?.['allTabs']; // Get settings for allTabs scope

        if (globalSettings && globalSettings.isRefreshing) {
            if (globalSettings.clearCache) {
                await clearBrowsingData();
            }
            // Query all tabs and reload them
            chrome.tabs.query({}, (tabs) => {
                tabs.forEach(tab => {
                    // Avoid reloading internal Chrome pages (e.g., new tab page, extensions page)
                    if (!tab.url.startsWith("chrome://") && !tab.url.startsWith("edge://") && !tab.url.startsWith("about:")) {
                        chrome.tabs.reload(tab.id, { bypassCache: globalSettings.clearCache }, () => {
                            if (chrome.runtime.lastError) {
                                console.warn(`Could not reload tab ${tab.id} (${tab.url}):`, chrome.runtime.lastError.message);
                            }
                        });
                    }
                });
                console.log("All eligible tabs refreshed globally.");
                // Reset countdown after successful global refresh
                if (currentActiveScope === 'allTabs' && currentRefreshIntervalSeconds > 0) {
                    currentCountdownSeconds = currentRefreshIntervalSeconds;
                    chrome.action.setBadgeText({ text: String(currentCountdownSeconds) });
                }
            });
        } else {
            // If global refresh is no longer active, clear the alarm
            chrome.alarms.clear(globalRefreshAlarmName);
            console.log("Global refresh stopped due to settings change or absence.");
            if (currentActiveScope === 'allTabs' && currentRefreshIntervalSeconds > 0) {
                stopBadgeCountdown();
            }
        }
    }
});

// Listener for messages sent from the popup script (popup.js)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'startRefresh') {
        const intervalInMinutes = request.interval / 60000;
        const scope = request.scope;
        const clearCache = request.clearCache;
        const intervalSeconds = request.interval / 1000;

        // Clear any existing alarms for both scopes before starting a new one
        chrome.alarms.clear(globalRefreshAlarmName);
        activeTabAlarms.forEach((alarmName, tabId) => chrome.alarms.clear(alarmName));
        activeTabAlarms.clear(); // Clear the map

        if (scope === 'activeTab') {
            if (!request.tabId) {
                sendResponse({ success: false, message: 'No active tab found to refresh.' });
                return;
            }
            const alarmName = `refresh-tab-${request.tabId}`;
            chrome.alarms.create(alarmName, {
                delayInMinutes: intervalInMinutes,
                periodInMinutes: intervalInMinutes
            });
            activeTabAlarms.set(request.tabId, alarmName);
            // Store the tabId with the activeTab settings to ensure we refresh the correct tab
            chrome.storage.local.get(['refreshSettings'], (result) => {
                const settings = result.refreshSettings || {};
                settings['activeTab'] = { ...settings['activeTab'], tabId: request.tabId, isRefreshing: true, seconds: intervalSeconds, clearCache: clearCache };
                chrome.storage.local.set({ refreshSettings: settings });
            });
            console.log(`Started refresh for active tab ${request.tabId} every ${intervalSeconds} seconds.`);
            startBadgeCountdown(intervalSeconds, scope); // Start badge countdown
            sendResponse({ success: true });
        } else if (scope === 'allTabs') {
            chrome.alarms.create(globalRefreshAlarmName, {
                delayInMinutes: intervalInMinutes,
                periodInMinutes: intervalInMinutes
            });
            // Store settings for allTabs scope
            chrome.storage.local.get(['refreshSettings'], (result) => {
                const settings = result.refreshSettings || {};
                settings['allTabs'] = { ...settings['allTabs'], isRefreshing: true, seconds: intervalSeconds, clearCache: clearCache };
                chrome.storage.local.set({ refreshSettings: settings });
            });
            console.log(`Started global refresh every ${intervalSeconds} seconds.`);
            startBadgeCountdown(intervalSeconds, scope); // Start badge countdown
            sendResponse({ success: true });
        } else {
            sendResponse({ success: false, message: 'Invalid refresh scope.' });
        }
    } else if (request.action === 'stopRefresh') {
        const scope = request.scope;

        if (scope === 'activeTab') {
            if (request.tabId && activeTabAlarms.has(request.tabId)) {
                const alarmName = activeTabAlarms.get(request.tabId);
                chrome.alarms.clear(alarmName, (wasCleared) => {
                    if (wasCleared) {
                        activeTabAlarms.delete(request.tabId);
                        console.log(`Stopped refresh for active tab ${request.tabId}.`);
                        stopBadgeCountdown(); // Stop badge countdown
                        sendResponse({ success: true });
                    } else {
                        console.warn(`No active alarm found for tab ${request.tabId} to stop.`);
                        sendResponse({ success: false, message: 'No active refresh for this tab.' });
                    }
                });
            } else {
                sendResponse({ success: false, message: 'No active refresh for this tab.' });
            }
        } else if (scope === 'allTabs') {
            chrome.alarms.clear(globalRefreshAlarmName, (wasCleared) => {
                if (wasCleared) {
                    console.log('Stopped global refresh.');
                    stopBadgeCountdown(); // Stop badge countdown
                    sendResponse({ success: true });
                } else {
                    console.warn('No active global refresh alarm to stop.');
                    sendResponse({ success: false, message: 'No active global refresh.' });
                }
            });
        } else {
            sendResponse({ success: false, message: 'Invalid refresh scope.' });
        }
        return true; // Indicate async sendResponse
    }
});

// --- Cleanup on Tab Close ---
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    // If the closed tab was the one being individually refreshed
    if (activeTabAlarms.has(tabId)) {
        const alarmName = activeTabAlarms.get(tabId);
        chrome.alarms.clear(alarmName);
        activeTabAlarms.delete(tabId);
        console.log(`Cleaned up alarm for closed tab ${tabId}.`);

        // Also update the stored settings for 'activeTab' scope
        chrome.storage.local.get(['refreshSettings'], (result) => {
            const currentSettings = result.refreshSettings || {};
            if (currentSettings['activeTab'] && currentSettings['activeTab'].tabId === tabId) {
                currentSettings['activeTab'].isRefreshing = false;
                delete currentSettings['activeTab'].tabId; // Remove tabId as it's no longer valid
            }
            chrome.storage.local.set({ refreshSettings: currentSettings });
        });
        // If the closed tab was the one actively showing countdown, stop it
        if (currentActiveScope === 'activeTab' && currentRefreshIntervalSeconds > 0) {
            stopBadgeCountdown();
        }
    }
});

// --- Re-establish Alarms on Browser Startup/Extension Install/Update ---
chrome.runtime.onInstalled.addListener(() => {
    // Retrieve all stored refresh settings
    chrome.storage.local.get(['refreshSettings', 'activeScope'], async (items) => {
        const refreshSettings = items.refreshSettings || {};
        const activeScope = items.activeScope;

        // Re-establish activeTab refresh if it was active
        const activeTabSettings = refreshSettings['activeTab'];
        if (activeTabSettings && activeTabSettings.isRefreshing && activeTabSettings.seconds !== undefined && activeTabSettings.tabId) {
             // Verify if the tab still exists before re-establishing alarm
            chrome.tabs.get(activeTabSettings.tabId, (tab) => {
                if (tab) {
                    const intervalMs = activeTabSettings.seconds * 1000;
                    if (intervalMs > 0) {
                        const alarmName = `refresh-tab-${activeTabSettings.tabId}`;
                        chrome.alarms.create(alarmName, {
                            delayInMinutes: intervalMs / 60000,
                            periodInMinutes: intervalMs / 60000
                        });
                        activeTabAlarms.set(activeTabSettings.tabId, alarmName);
                        console.log(`Re-established individual refresh for tab ${activeTabSettings.tabId} every ${activeTabSettings.seconds} seconds.`);
                        // Start badge countdown if this was the last active scope
                        if (activeScope === 'activeTab') {
                            startBadgeCountdown(activeTabSettings.seconds, 'activeTab');
                        }
                    }
                } else {
                    console.log(`Stored active tab ${activeTabSettings.tabId} not found. Not re-establishing its refresh.`);
                    // Clean up settings for non-existent tab
                    chrome.storage.local.get(['refreshSettings'], (result) => {
                        const currentSettings = result.refreshSettings || {};
                        if (currentSettings['activeTab'] && currentSettings['activeTab'].tabId === activeTabSettings.tabId) {
                            currentSettings['activeTab'].isRefreshing = false;
                            delete currentSettings['activeTab'].tabId;
                        }
                        chrome.storage.local.set({ refreshSettings: currentSettings });
                    });
                }
            });
        }

        // Re-establish allTabs refresh if it was active
        const allTabsSettings = refreshSettings['allTabs'];
        if (allTabsSettings && allTabsSettings.isRefreshing && allTabsSettings.seconds !== undefined) {
            const intervalMs = allTabsSettings.seconds * 1000;
            if (intervalMs > 0) {
                chrome.alarms.create(globalRefreshAlarmName, {
                    delayInMinutes: intervalMs / 60000,
                    periodInMinutes: intervalMs / 60000
                });
                console.log(`Re-established global refresh every ${allTabsSettings.seconds} seconds.`);
                // Start badge countdown if this was the last active scope
                if (activeScope === 'allTabs') {
                    startBadgeCountdown(allTabsSettings.seconds, 'allTabs');
                }
            }
        }
    });
});
