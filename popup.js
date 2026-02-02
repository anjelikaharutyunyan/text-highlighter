// popup.js (FULL) ✅ with i18n + Undo button (undo delete + undo clear all)
// ✅ + Save PDF + Save DOCS (download)
// ✅ Status label + count separated: #status .statusText + #status .badge
// ✅ statusText NO LONGER contains count

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

// ---------------- STATUS LABEL + BADGE HELPERS ----------------
function setStatusLabel(statusEl, labelText) {
    if (!statusEl) return;
    const labelSpan = statusEl.querySelector(".statusText");
    if (labelSpan) labelSpan.textContent = labelText;
    else statusEl.textContent = labelText; // fallback
}

function setBadgeCount(badgeEl, count) {
    if (!badgeEl) return;
    badgeEl.textContent = String(count);
}

// ---------------- STATUS HELPER (restore previous label text only) ----------------
let statusTimer = null;

function showStatus(statusEl, text, ms = 1000) {
    if (!statusEl) return;

    const labelSpan = statusEl.querySelector(".statusText");
    const prev = labelSpan ? labelSpan.textContent : statusEl.textContent;

    if (statusTimer) clearTimeout(statusTimer);

    if (labelSpan) labelSpan.textContent = text;
    else statusEl.textContent = text;

    statusTimer = setTimeout(() => {
        if (labelSpan) labelSpan.textContent = prev;
        else statusEl.textContent = prev;
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

// ---------------- EXPORT HELPERS ----------------

// ✅ Fixed filenames (as you requested)
const PDF_FILE_NAME = "highlight-text-pdf.pdf";
const DOC_FILE_NAME = "highlight-text-docs.doc";

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function escapeHtml(s) {
    return (s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function normalizeTextForExport(text) {
    return (text || "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n[ \t]+/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
// ------------------------------------------------

function render(listEl, statusEl, badgeEl, items) {
    listEl.innerHTML = "";

    const count = items?.length || 0;

    // ✅ Badge always updated with count only
    setBadgeCount(badgeEl, count);

    // Optional: disable export buttons when empty
    const savePdfBtn = document.getElementById("savePdf");
    const saveDocBtn = document.getElementById("saveDoc");
    if (savePdfBtn) savePdfBtn.disabled = count === 0;
    if (saveDocBtn) saveDocBtn.disabled = count === 0;

    if (!items || count === 0) {
        // ✅ statusText = label only (no count)
        // Make sure your i18n message "statusNoHighlights" is label-only, e.g. "Highlights:"
        setStatusLabel(statusEl, t("statusNoHighlights"));

        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = t("hintEmpty");
        listEl.appendChild(empty);
        return;
    }

    // ✅ statusText = label only (no count)
    // Use a label-only key, e.g. "Highlights:"
    // Recommended i18n key: statusHighlightsLabel
    setStatusLabel(statusEl, t("statusHighlightsLabel") || t("statusNoHighlights"));

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
        del.textContent = t("btnUnmarkOne") || "unmark";
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
        copyBtnOne.textContent = t("btnCopyOne") || "copy";
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

    // ✅ The count must be in <span class="badge"></span> inside #status
    const badgeEl = document.querySelector("#status .badge");

    const clearBtn = document.getElementById("clearAll");
    const copyBtn = document.getElementById("copyAll");
    const undoBtn = document.getElementById("undoBtn");

    const savePdfBtn = document.getElementById("savePdf");
    const saveDocBtn = document.getElementById("saveDoc");

    setUndoEnabled(undoBtn);

    // Initial load
    try {
        const tab = await getActiveTab();
        const res = await sendToContent(tab.id, { type: "GET_HIGHLIGHTS" });
        render(listEl, statusEl, badgeEl, res?.items || []);
    } catch {
        setStatusLabel(statusEl, t("msgCannotAccessPage"));
        setBadgeCount(badgeEl, 0);
        if (savePdfBtn) savePdfBtn.disabled = true;
        if (saveDocBtn) saveDocBtn.disabled = true;
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

    // -------- SAVE DOC (Word .doc as HTML) ----------
    saveDocBtn?.addEventListener("click", async () => {
        try {
            const tab = await getActiveTab();
            const res = await sendToContent(tab.id, { type: "COPY_ALL" });
            const text = normalizeTextForExport(res?.text || "");

            if (!text) {
                showStatus(statusEl, t("msgNothingToCopy"));
                return;
            }

            const paragraphsHtml = escapeHtml(text)
                .split("\n\n")
                .map((p) => `<p style="margin:0 0 10px 0;">${p.replace(/\n/g, "<br/>")}</p>`)
                .join("");

            const html = `
<html>
<head>
  <meta charset="utf-8" />
  <title>Highlights</title>
</head>
<body style="font-family: Arial, sans-serif; font-size: 12pt; line-height: 1.35;">
  <h2 style="margin:0 0 12px 0;">Highlights</h2>
  ${paragraphsHtml}
</body>
</html>
`.trim();

            const blob = new Blob([html], { type: "application/msword;charset=utf-8" });
            downloadBlob(blob, DOC_FILE_NAME);

            showStatus(statusEl, "Saved DOC");
        } catch {
            showStatus(statusEl, "DOC save failed");
        }
    });

    // -------- SAVE PDF (jsPDF) ----------
    savePdfBtn?.addEventListener("click", async () => {
        try {
            const tab = await getActiveTab();
            const res = await sendToContent(tab.id, { type: "COPY_ALL" });
            const text = normalizeTextForExport(res?.text || "");

            if (!text) {
                showStatus(statusEl, t("msgNothingToCopy"));
                return;
            }

            const { jsPDF } = window.jspdf || {};
            if (!jsPDF) {
                showStatus(statusEl, "jsPDF not loaded");
                return;
            }

            const doc = new jsPDF({
                unit: "pt",
                format: "a4",
            });

            const pageWidth = doc.internal.pageSize.getWidth();
            const pageHeight = doc.internal.pageSize.getHeight();

            const margin = 40;
            const maxWidth = pageWidth - margin * 2;

            doc.setFont("times", "normal");
            doc.setFontSize(12);

            let y = margin;

            doc.setFontSize(16);
            doc.text("Highlights", margin, y);
            y += 24;

            doc.setFontSize(12);

            const paragraphs = text.split("\n\n");
            for (const p0 of paragraphs) {
                const p = (p0 || "").trim();
                if (!p) continue;

                const lines = doc.splitTextToSize(p.replace(/\n/g, " "), maxWidth);

                for (const line of lines) {
                    if (y > pageHeight - margin) {
                        doc.addPage();
                        y = margin;
                    }
                    doc.text(line, margin, y);
                    y += 16;
                }

                y += 10;
                if (y > pageHeight - margin) {
                    doc.addPage();
                    y = margin;
                }
            }

            const pdfBlob = doc.output("blob");
            downloadBlob(pdfBlob, PDF_FILE_NAME);

            showStatus(statusEl, "Saved PDF");
        } catch {
            showStatus(statusEl, "PDF save failed");
        }
    });
});
