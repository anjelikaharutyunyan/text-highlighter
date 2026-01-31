// background.js (MV3)

async function injectContentScript(tabId) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ["content.js"],
        });
    } catch (e) {
        // нельзя на chrome://, webstore, etc
    }
}

function isInjectableUrl(url) {
    if (!url) return false;
    return !(
        url.startsWith("chrome://") ||
        url.startsWith("edge://") ||
        url.startsWith("about:") ||
        url.startsWith("chrome-extension://") ||
        url.startsWith("https://chrome.google.com/webstore")
    );
}

chrome.runtime.onInstalled.addListener(async () => {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
        if (!tab.id || !isInjectableUrl(tab.url)) continue;
        await injectContentScript(tab.id);
    }
});
