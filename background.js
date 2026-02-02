const WELCOME_URL = "https://berdlteam.github.io/highlight-text-welcome/";

async function injectContentScript(tabId) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ["content.js"],
        });
    } catch (e) {
    }
}

function isInjectableUrl(url) {
    if (!url) return false;
    return !(
        url.startsWith("chrome://") ||
        url.startsWith("edge://") ||
        url.startsWith("about:") ||
        url.startsWith("chrome-extension://") ||
        url.startsWith("https://chrome.google.com/webstore") ||
        url.startsWith("https://chromewebstore.google.com")
    );
}

chrome.runtime.onInstalled.addListener(async (details) => {
    if (details?.reason === "install") {
        try {
            await chrome.tabs.create({ url: WELCOME_URL });
        } catch (e) {
            // ignore
        }
    }

    try {
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
            if (!tab.id || !isInjectableUrl(tab.url)) continue;
            await injectContentScript(tab.id);
        }
    } catch (e) {
        // ignore
    }
});
