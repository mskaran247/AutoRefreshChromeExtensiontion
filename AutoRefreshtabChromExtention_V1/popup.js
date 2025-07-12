// --- popup.js ---
// This script handles the logic for the popup UI. It gets the current tab's info,
// loads/saves settings from Chrome's local storage, and sends messages to the
// background script to start or stop refreshing.
document.addEventListener('DOMContentLoaded', async () => {
    // Get references to all HTML elements in the popup
    const minutesInput = document.getElementById('minutes');
    const secondsInput = document.getElementById('seconds');
    const clearCacheCheckbox = document.getElementById('clearCache');
    const startButton = document.getElementById('startButton');
    const stopButton = document.getElementById('stopButton');
    const statusDiv = document.getElementById('status');
    const currentUrlDiv = document.getElementById('currentUrl');

    let currentTab; // Variable to store information about the currently active tab

    // Query for the currently active tab in the current window
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tabs[0]; // The first tab in the result is the active one
    currentUrlDiv.textContent = `URL: ${currentTab.url}`; // Display the URL in the popup

    // Load saved settings for the current tab from Chrome's local storage
    // The key for storage is unique to each tab ID to store settings per tab.
    chrome.storage.local.get([`refreshSettings_${currentTab.id}`], (result) => {
        const settings = result[`refreshSettings_${currentTab.id}`];
        if (settings) {
            // If settings exist, populate the input fields and checkbox
            minutesInput.value = settings.minutes;
            secondsInput.value = settings.seconds;
            clearCacheCheckbox.checked = settings.clearCache;
            // Update UI based on whether refresh was active
            if (settings.isRefreshing) {
                statusDiv.textContent = `Refreshing every ${settings.minutes}m ${settings.seconds}s`;
                startButton.disabled = true; // Disable start button if already refreshing
                stopButton.disabled = false; // Enable stop button
            } else {
                statusDiv.textContent = 'Ready';
                startButton.disabled = false;
                stopButton.disabled = true;
            }
        } else {
            // If no settings found, set default values
            minutesInput.value = 0;
            secondsInput.value = 30;
            clearCacheCheckbox.checked = false;
            statusDiv.textContent = 'Ready';
            startButton.disabled = false;
            stopButton.disabled = true;
        }
    });

    // Event listener for the "Start Refresh" button
    startButton.addEventListener('click', () => {
        const minutes = parseInt(minutesInput.value);
        const seconds = parseInt(secondsInput.value);
        const clearCache = clearCacheCheckbox.checked;

        // Validate input: ensure time is a valid number and not zero
        if (isNaN(minutes) || isNaN(seconds) || (minutes === 0 && seconds === 0)) {
            statusDiv.textContent = 'Please enter a valid time (minutes or seconds).';
            return;
        }

        // Calculate the total interval in milliseconds
        const intervalMs = (minutes * 60 + seconds) * 1000;

        // Save the current settings to local storage
        const settingsToSave = { minutes, seconds, clearCache, isRefreshing: true };
        chrome.storage.local.set({ [`refreshSettings_${currentTab.id}`]: settingsToSave }, () => {
            // Send a message to the background script to start the refresh process
            chrome.runtime.sendMessage({
                action: 'startRefresh',
                tabId: currentTab.id,
                interval: intervalMs,
                clearCache: clearCache
            }, (response) => {
                // Handle response from background script
                if (response && response.success) {
                    statusDiv.textContent = `Refreshing every ${minutes}m ${seconds}s`;
                    startButton.disabled = true;
                    stopButton.disabled = false;
                } else {
                    statusDiv.textContent = 'Error starting refresh.';
                }
            });
        });
    });

    // Event listener for the "Stop Refresh" button
    stopButton.addEventListener('click', () => {
        // Retrieve current settings to update the 'isRefreshing' status
        chrome.storage.local.get([`refreshSettings_${currentTab.id}`], (result) => {
            const settings = result[`refreshSettings_${currentTab.id}`] || {};
            settings.isRefreshing = false; // Mark as not refreshing
            chrome.storage.local.set({ [`refreshSettings_${currentTab.id}`]: settings }, () => {
                // Send a message to the background script to stop the refresh process
                chrome.runtime.sendMessage({
                    action: 'stopRefresh',
                    tabId: currentTab.id
                }, (response) => {
                    // Handle response from background script
                    if (response && response.success) {
                        statusDiv.textContent = 'Refresh stopped.';
                        startButton.disabled = false;
                        stopButton.disabled = true;
                    } else {
                        statusDiv.textContent = 'Error stopping refresh.';
                    }
                });
            });
        });
    });
});