// --- popup.js ---
// This script handles the logic for the popup UI. It gets the current tab's info,
// loads/saves settings from Chrome's local storage, and sends messages to the
// background script to start or stop refreshing.
document.addEventListener('DOMContentLoaded', async () => {
    // --- DOM Element References ---
    const refreshScopeSelect = document.getElementById('refreshScope');
    const secondsInput = document.getElementById('seconds');
    const clearCacheCheckbox = document.getElementById('clearCache');
    const startButton = document.getElementById('startButton');
    const stopButton = document.getElementById('stopButton');
    const statusMessageDiv = document.getElementById('statusMessage');
    const currentTabUrlDisplay = document.getElementById('currentTabUrlDisplay');
    const statusIndicator = document.getElementById('statusIndicator'); // ON/OFF status

    let currentTab; // Variable to store information about the currently active tab

    // --- Helper Functions ---

    // Function to update the ON/OFF status indicator
    function updateStatusIndicator(isOn) {
        if (isOn) {
            statusIndicator.textContent = 'ON';
            statusIndicator.classList.remove('off');
            statusIndicator.classList.add('on');
        } else {
            statusIndicator.textContent = 'OFF';
            statusIndicator.classList.remove('on');
            statusIndicator.classList.add('off');
        }
    }

    // Function to validate time input
    function isValidTime(seconds) {
        return !isNaN(seconds) && seconds > 0;
    }

    // Function to load and apply saved settings
    async function loadSettings() {
        // Get current tab info
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        currentTab = tabs[0];
        // Display current tab URL, handle cases where it's not a web page
        if (currentTab && currentTab.url && !currentTab.url.startsWith("chrome://") && !currentTab.url.startsWith("edge://") && !currentTab.url.startsWith("about:")) {
            currentTabUrlDisplay.textContent = `Current Tab: ${currentTab.url}`;
        } else {
            currentTabUrlDisplay.textContent = `Current Tab: (Not a standard web page)`;
        }


        const settings = await chrome.storage.local.get(['refreshSettings', 'activeScope']);

        // Set default scope
        refreshScopeSelect.value = settings.activeScope || 'activeTab';

        // Load settings based on the active scope
        const scope = refreshScopeSelect.value;
        const currentSettings = settings.refreshSettings?.[scope];

        if (currentSettings) {
            secondsInput.value = currentSettings.seconds;
            clearCacheCheckbox.checked = currentSettings.clearCache;
            if (currentSettings.isRefreshing) {
                statusMessageDiv.textContent = `Refreshing ${scope === 'activeTab' ? 'active tab' : 'all tabs'} every ${currentSettings.seconds}s`;
                startButton.disabled = true;
                stopButton.disabled = false;
                updateStatusIndicator(true);
            } else {
                statusMessageDiv.textContent = 'Ready';
                startButton.disabled = false;
                stopButton.disabled = true;
                updateStatusIndicator(false);
            }
        } else {
            // Default values if no settings found for the scope
            secondsInput.value = 8; // Default to 8 seconds
            clearCacheCheckbox.checked = false;
            statusMessageDiv.textContent = 'Ready';
            startButton.disabled = false;
            stopButton.disabled = true;
            updateStatusIndicator(false);
        }
    }

    // --- Initialization ---
    await loadSettings();

    // --- Event Listeners ---

    // Listen for changes in the refresh scope dropdown
    refreshScopeSelect.addEventListener('change', loadSettings);

    startButton.addEventListener('click', () => {
        const seconds = parseInt(secondsInput.value);
        const clearCache = clearCacheCheckbox.checked;
        const scope = refreshScopeSelect.value;

        if (!isValidTime(seconds)) {
            statusMessageDiv.textContent = 'Please enter a valid time (seconds > 0).';
            return;
        }

        const intervalMs = seconds * 1000;

        // Save settings for the selected scope
        chrome.storage.local.get(['refreshSettings'], (result) => {
            const refreshSettings = result.refreshSettings || {};
            refreshSettings[scope] = { seconds, clearCache, isRefreshing: true };
            chrome.storage.local.set({ refreshSettings: refreshSettings, activeScope: scope }, () => {
                chrome.runtime.sendMessage({
                    action: 'startRefresh',
                    scope: scope,
                    tabId: currentTab ? currentTab.id : null, // Only send tabId if scope is activeTab
                    interval: intervalMs,
                    clearCache: clearCache
                }, (response) => {
                    if (response && response.success) {
                        statusMessageDiv.textContent = `Refreshing ${scope === 'activeTab' ? 'active tab' : 'all tabs'} every ${seconds}s`;
                        startButton.disabled = true;
                        stopButton.disabled = false;
                        updateStatusIndicator(true);
                    } else {
                        statusMessageDiv.textContent = response.message || 'Error starting refresh.';
                    }
                });
            });
        });
    });

    stopButton.addEventListener('click', () => {
        const scope = refreshScopeSelect.value;

        // Update settings to mark as not refreshing
        chrome.storage.local.get(['refreshSettings'], (result) => {
            const refreshSettings = result.refreshSettings || {};
            if (refreshSettings[scope]) {
                refreshSettings[scope].isRefreshing = false;
            }
            chrome.storage.local.set({ refreshSettings: refreshSettings }, () => {
                chrome.runtime.sendMessage({
                    action: 'stopRefresh',
                    scope: scope,
                    tabId: currentTab ? currentTab.id : null // Send tabId for active tab scope
                }, (response) => {
                    if (response && response.success) {
                        statusMessageDiv.textContent = 'Refresh stopped.';
                        startButton.disabled = false;
                        stopButton.disabled = true;
                        updateStatusIndicator(false);
                    } else {
                        statusMessageDiv.textContent = response.message || 'Error stopping refresh.';
                    }
                });
            });
        });
    });
});