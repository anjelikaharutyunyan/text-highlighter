// popup.js (FULL) ✅ with i18n + Undo button (undo delete + undo clear all)

function t(key, substitutions) {
    return chrome.i18n.getMessage(key, substitutions) || key;
}

function applyI18nToPopup() {
    document.querySelectorAll("[data-i18n]").forEach((el) => {
        const key = el.getAttribute("data-i18n");
        const msg = t(key);

        if (el.tagName.toLowerCase() === "title") {
            document.title = msg;
            return;
        }

        el.textContent = msg;
    });
}

async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
}

function shortText(t0) {
    const s = (t0 || "").trim().replace(/\s+/g, " ");
    return s.length > 140 ? s.slice(0, 140) + "…" : s;
}

// ---------------- STATUS HELPER (restore previous text) ----------------
let statusTimer = null;

function showStatus(statusEl, text, ms = 1000) {
    if (!statusEl) return;

    const prev = statusEl.textContent;

    if (statusTimer) clearTimeout(statusTimer);

    statusEl.textContent = text;

    statusTimer = setTimeout(() => {
        statusEl.textContent = prev;
        statusTimer = null;
    }, ms);
}
// ----------------------------------------------------------------------

// ---------------- UNDO STACK ----------------
let undoStack = []; // each item: { type: "REMOVE_ONE"|"CLEAR_ALL", records: [...] }

function setUndoEnabled(btn) {
    if (!btn) return;
    btn.disabled = undoStack.length === 0;
}
// -------------------------------------------

// Inject content script if needed, then resend message
async function sendToContent(tabId, message) {
    try {
        return await chrome.tabs.sendMessage(tabId, message);
    } catch (e) {
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ["content.js"],
        });
        return await chrome.tabs.sendMessage(tabId, message);
    }
}

async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
    }
}

function render(listEl, statusEl, badgeEl, items) {
    listEl.innerHTML = "";

    const count = items?.length || 0;
    if (badgeEl) badgeEl.textContent = String(count);

    if (!items || count === 0) {
        statusEl.textContent = t("statusNoHighlights");

        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = t("hintEmpty");
        listEl.appendChild(empty);
        return;
    }

    statusEl.textContent = t("statusHighlightsCount", [String(count)]);

    for (const item of items) {
        const row = document.createElement("div");
        row.className = "item";

        const left = document.createElement("div");

        const text = document.createElement("div");
        text.className = "text";
        text.textContent = shortText(item.text);

        left.appendChild(text);

        const actions = document.createElement("div");
        actions.className = "actions";

        // -------- delete ----------
        const del = document.createElement("button");
        del.className = "btn danger small";
        del.textContent = t("btnUnmarkOne") || "Unmark"; // optional fallback
        del.addEventListener("click", async () => {
            try {
                const tab = await getActiveTab();

                const res = await sendToContent(tab.id, {
                    type: "REMOVE_HIGHLIGHT",
                    id: item.id,
                });

                if (res?.ok) {
                    // ✅ store deleted record for UNDO
                    if (res?.deletedRecord) {
                        undoStack.push({ type: "REMOVE_ONE", records: [res.deletedRecord] });
                    }
                    setUndoEnabled(document.getElementById("undoBtn"));

                    const again = await sendToContent(tab.id, {
                        type: "GET_HIGHLIGHTS",
                    });
                    render(listEl, statusEl, badgeEl, again?.items || []);

                    showStatus(statusEl, t("msgDeleted"));
                } else {
                    showStatus(statusEl, t("msgDeleteFailed"));
                }
            } catch {
                showStatus(statusEl, t("msgDeleteFailed"));
            }
        });

        // -------- copy one ----------
        const copyBtnOne = document.createElement("button");
        copyBtnOne.className = "btn small";
        copyBtnOne.textContent = t("btnCopyOne") || "Copy";
        copyBtnOne.addEventListener("click", async () => {
            const toCopy = (item.text || "").trim();
            if (!toCopy) {
                showStatus(statusEl, t("msgNothingToCopy"));
                return;
            }

            const ok = await copyToClipboard(toCopy);
            showStatus(statusEl, ok ? t("msgCopied") : t("msgCopyFailed"));
        });

        actions.appendChild(del);
        actions.appendChild(copyBtnOne);

        row.appendChild(left);
        row.appendChild(actions);
        listEl.appendChild(row);
    }
}

document.addEventListener("DOMContentLoaded", async () => {
    applyI18nToPopup();

    const listEl = document.getElementById("list");
    const statusEl = document.getElementById("status");
    const badgeEl = document.getElementById("badge");

    const clearBtn = document.getElementById("clearAll");
    const copyBtn = document.getElementById("copyAll");
    const undoBtn = document.getElementById("undoBtn");

    setUndoEnabled(undoBtn);

    // Initial load
    try {
        const tab = await getActiveTab();
        const res = await sendToContent(tab.id, { type: "GET_HIGHLIGHTS" });
        render(listEl, statusEl, badgeEl, res?.items || []);
    } catch {
        statusEl.textContent = t("msgCannotAccessPage");
        if (badgeEl) badgeEl.textContent = "0";
    }

    // -------- UNDO ----------
    undoBtn?.addEventListener("click", async () => {
        const action = undoStack.pop();
        setUndoEnabled(undoBtn);

        if (!action) {
            showStatus(statusEl, t("msgNothingToUndo"));
            return;
        }

        try {
            const tab = await getActiveTab();

            for (const rec of action.records) {
                await sendToContent(tab.id, { type: "RESTORE_HIGHLIGHT", record: rec });
            }

            const again = await sendToContent(tab.id, { type: "GET_HIGHLIGHTS" });
            render(listEl, statusEl, badgeEl, again?.items || []);

            showStatus(statusEl, t("msgUndoComplete"));
        } catch {
            showStatus(statusEl, t("msgUndoFailed"));
        }
    });

    // -------- clear all ----------
    clearBtn?.addEventListener("click", async () => {
        try {
            const tab = await getActiveTab();

            // ✅ save all records for UNDO
            const before = await sendToContent(tab.id, { type: "GET_RECORDS" });
            const records = before?.records || [];
            if (records.length) {
                undoStack.push({ type: "CLEAR_ALL", records });
                setUndoEnabled(undoBtn);
            }

            await sendToContent(tab.id, { type: "CLEAR_ALL" });

            const res = await sendToContent(tab.id, { type: "GET_HIGHLIGHTS" });
            render(listEl, statusEl, badgeEl, res?.items || []);
            showStatus(statusEl, t("msgAllCleared"));
        } catch {
            showStatus(statusEl, t("msgClearFailed"));
        }
    });

    // -------- copy all ----------
    copyBtn?.addEventListener("click", async () => {
        try {
            const tab = await getActiveTab();
            const res = await sendToContent(tab.id, { type: "COPY_ALL" });
            const text = res?.text || "";

            if (!text.trim()) {
                showStatus(statusEl, t("msgNothingToCopy"));
                return;
            }

            const ok = await copyToClipboard(text);
            showStatus(statusEl, ok ? t("msgCopiedAll") : t("msgCopyFailed"));
        } catch {
            showStatus(statusEl, t("msgCopyFailed"));
        }
    });
});
