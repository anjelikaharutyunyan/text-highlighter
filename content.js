
(() => {
    // ✅ GUARD: prevent running twice (content_scripts + executeScript)
    if (window.__HL_EXT_ALREADY_RUNNING__) return;
    window.__HL_EXT_ALREADY_RUNNING__ = true;

    const HIGHLIGHT_CLASS = "hl-ext-highlight";

    const HIGHLIGHT_STYLE = `
    background-color: rgba(255, 246, 21, 0.4) !important;
    padding: 1px 2px !important;
    border-radius: 2px !important;
    transition: background-color 0.2s ease !important;
    cursor: pointer !important;
  `.trim();

    // i18n helper (safe fallback)
    const L = (key, substitutions) => {
        try {
            return chrome?.i18n?.getMessage(key, substitutions) || key;
        } catch {
            return key;
        }
    };

    // =========================
    // ✅ Extension-liveness guard (fix: context invalidated)
    // =========================

    let __HL_ALIVE__ = true;

    function isExtAlive() {
        return __HL_ALIVE__ && !!(chrome?.runtime?.id);
    }

    function safeIgnoreInvalidation(err) {
        const msg = String(err?.message || err || "");
        return msg.includes("Extension context invalidated") || msg.includes("context invalidated");
    }

    // Cleanup on navigation/unload so async timers/observers won't fire into a dead context
    window.addEventListener(
        "pagehide",
        () => {
            __HL_ALIVE__ = false;

            try {
                _observer?.disconnect();
            } catch { }
            _observer = null;

            clearTimeout(_restoreTimer);
            clearTimeout(_pencilHideTimer);

            removePencil();
        },
        { once: true }
    );

    function getPageKey() {
        const u = new URL(location.href);
        return `${u.origin}${u.pathname}${u.search}`;
    }

    function genId() {
        return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    function isEditableTarget(node) {
        if (!node) return false;
        const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        if (!el) return false;
        return el.closest("input, textarea, [contenteditable='true']") !== null;
    }

    // =========================
    // XPath helpers
    // =========================

    function getXPath(node) {
        if (!node) return null;

        if (node.nodeType === Node.TEXT_NODE) {
            const parent = node.parentNode;
            const parentXPath = getXPath(parent);
            if (!parentXPath) return null;

            const textNodes = Array.from(parent.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE);
            const index = textNodes.indexOf(node) + 1; // XPath 1-based
            return `${parentXPath}/text()[${index}]`;
        }

        if (node.nodeType === Node.ELEMENT_NODE) {
            if (node === document.documentElement) return "/html";

            const tag = node.tagName.toLowerCase();
            const parent = node.parentNode;
            if (!parent || parent.nodeType !== Node.ELEMENT_NODE) return `/${tag}`;

            const siblings = Array.from(parent.children).filter((el) => el.tagName.toLowerCase() === tag);
            const index = siblings.indexOf(node) + 1;
            return `${getXPath(parent)}/${tag}[${index}]`;
        }

        return null;
    }

    function getNodeByXPath(xpath) {
        try {
            const res = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            return res.singleNodeValue || null;
        } catch {
            return null;
        }
    }

    // =========================
    // Block anchoring (professional stability)
    // =========================

    const BLOCK_SELECTOR = [
        "p",
        "li",
        "blockquote",
        "pre",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "article",
        "section",
        "main",
        "div",
    ].join(",");

    function getBlockElementForRange(range) {
        const el =
            range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
                ? range.commonAncestorContainer
                : range.commonAncestorContainer.parentElement;

        if (!el) return document.body;

        const block = el.closest(BLOCK_SELECTOR);
        return block || document.body;
    }

    // =========================
    // Text snapshot + stable offsets (inside root)
    // =========================

    function getAllTextNodes(root = document.body, { includeInsideHighlights = false } = {}) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;

                const p = node.parentElement;
                if (!p) return NodeFilter.FILTER_REJECT;

                if (!includeInsideHighlights) {
                    if (p.closest && p.closest(`mark.${HIGHLIGHT_CLASS}`)) return NodeFilter.FILTER_REJECT;
                }

                const tag = (p.tagName || "").toLowerCase();
                if (tag === "script" || tag === "style" || tag === "noscript")
                    return NodeFilter.FILTER_REJECT;

                return NodeFilter.FILTER_ACCEPT;
            },
        });

        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        return nodes;
    }

    function buildLinearTextAndMap(textNodes) {
        let full = "";
        const map = []; // { node, start, end }
        for (const n of textNodes) {
            const start = full.length;
            full += n.nodeValue;
            const end = full.length;
            map.push({ node: n, start, end });
        }
        return { fullText: full, map };
    }

    function buildSnapshot(rootEl) {
        const textNodes = getAllTextNodes(rootEl, { includeInsideHighlights: true });
        return buildLinearTextAndMap(textNodes);
    }

    function linearOffsetsToRange(map, startIndex, endIndex) {
        const range = document.createRange();

        function findPosition(index) {
            for (const m of map) {
                if (index >= m.start && index <= m.end) {
                    return { node: m.node, offset: index - m.start };
                }
            }
            return null;
        }

        const startPos = findPosition(startIndex);
        const endPos = findPosition(endIndex);
        if (!startPos || !endPos) return null;

        range.setStart(startPos.node, Math.max(0, Math.min(startPos.offset, startPos.node.nodeValue.length)));
        range.setEnd(endPos.node, Math.max(0, Math.min(endPos.offset, endPos.node.nodeValue.length)));

        if (range.collapsed) return null;
        return range;
    }

    function rangeToLinearOffsets(range, map) {
        function nodeOffsetToLinear(node, offset) {
            const entry = map.find((m) => m.node === node);
            if (!entry) return null;
            return entry.start + offset;
        }

        const a = nodeOffsetToLinear(range.startContainer, range.startOffset);
        const b = nodeOffsetToLinear(range.endContainer, range.endOffset);
        if (a == null || b == null) return null;

        return { startIndex: Math.min(a, b), endIndex: Math.max(a, b) };
    }

    // =========================
    // Quote anchor (fallback)
    // =========================

    function makeQuoteAnchorFromSelection(range, rootEl, contextLen = 30) {
        const textNodes = getAllTextNodes(rootEl, { includeInsideHighlights: false });
        const { fullText, map } = buildLinearTextAndMap(textNodes);

        function nodeOffsetToLinear(node, offset) {
            const entry = map.find((m) => m.node === node);
            if (!entry) return null;
            return entry.start + offset;
        }

        const startLinear = nodeOffsetToLinear(range.startContainer, range.startOffset);
        const endLinear = nodeOffsetToLinear(range.endContainer, range.endOffset);
        if (startLinear == null || endLinear == null) return null;

        const a = Math.min(startLinear, endLinear);
        const b = Math.max(startLinear, endLinear);

        const quote = fullText.slice(a, b);
        const prefix = fullText.slice(Math.max(0, a - contextLen), a);
        const suffix = fullText.slice(b, Math.min(fullText.length, b + contextLen));

        return { quote, prefix, suffix };
    }

    function findRangeByQuoteAnchor(anchor, rootEl) {
        const quote = anchor?.quote || "";
        const prefix = anchor?.prefix || "";
        const suffix = anchor?.suffix || "";
        if (!quote || !quote.trim()) return null;

        const snap = buildSnapshot(rootEl);
        const fullText = snap.fullText;
        const map = snap.map;

        const needle = `${prefix}${quote}${suffix}`;
        let idx = fullText.indexOf(needle);

        if (idx === -1) {
            idx = fullText.indexOf(quote);
            if (idx === -1) return null;
            return linearOffsetsToRange(map, idx, idx + quote.length);
        }

        const start = idx + prefix.length;
        const end = start + quote.length;
        return linearOffsetsToRange(map, start, end);
    }

    // =========================
    // ✅ SEMANTIC wrapping with <mark>
    // =========================

    function wrapTextNodePart(node, startOffset, endOffset, id) {
        const text = node.nodeValue || "";
        const len = text.length;
        const s = Math.max(0, Math.min(startOffset, len));
        const e = Math.max(0, Math.min(endOffset, len));
        if (e <= s) return null;

        const before = text.slice(0, s);
        const middle = text.slice(s, e);
        const after = text.slice(e);

        const parent = node.parentNode;
        if (!parent) return null;

        const frag = document.createDocumentFragment();

        if (before) frag.appendChild(document.createTextNode(before));

        const mark = document.createElement("mark");
        mark.className = HIGHLIGHT_CLASS;
        mark.dataset.hlId = id;
        mark.setAttribute("style", HIGHLIGHT_STYLE);
        mark.appendChild(document.createTextNode(middle));
        frag.appendChild(mark);

        if (after) frag.appendChild(document.createTextNode(after));

        parent.replaceChild(frag, node);
        return mark;
    }

    function collectTextNodesInRange(range) {
        const root =
            range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
                ? range.commonAncestorContainer
                : range.commonAncestorContainer.parentElement;

        if (!root) return [];

        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;

                const p = node.parentElement;
                if (!p) return NodeFilter.FILTER_REJECT;

                const tag = (p.tagName || "").toLowerCase();
                if (tag === "script" || tag === "style" || tag === "noscript")
                    return NodeFilter.FILTER_REJECT;

                if (p.closest && p.closest(`mark.${HIGHLIGHT_CLASS}`)) return NodeFilter.FILTER_REJECT;

                const r = document.createRange();
                r.selectNodeContents(node);

                const intersects =
                    range.compareBoundaryPoints(Range.END_TO_START, r) < 0 &&
                    range.compareBoundaryPoints(Range.START_TO_END, r) > 0;

                return intersects ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
            },
        });

        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        return nodes;
    }

    function wrapRangeSemantic(range, id) {
        const textNodes = collectTextNodesInRange(range);
        if (!textNodes.length) return null;

        for (let i = textNodes.length - 1; i >= 0; i--) {
            const node = textNodes[i];

            const start = node === range.startContainer ? range.startOffset : 0;
            const end = node === range.endContainer ? range.endOffset : node.nodeValue.length;

            wrapTextNodePart(node, start, end, id);
        }

        const sel = window.getSelection();
        if (sel) sel.removeAllRanges();

        return true;
    }

    // =========================
    // DOM operations (unwrap / find)
    // =========================

    function getHighlightsOnDom() {
        return Array.from(document.querySelectorAll(`mark.${HIGHLIGHT_CLASS}[data-hl-id]`));
    }

    function unwrapHighlightMarksById(id) {
        const marks = Array.from(
            document.querySelectorAll(`mark.${HIGHLIGHT_CLASS}[data-hl-id="${CSS.escape(id)}"]`)
        );

        for (const mark of marks) {
            const parent = mark.parentNode;
            if (!parent) continue;
            while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
            parent.removeChild(mark);
            parent.normalize();
        }
    }

    // =========================
    // ✅ Copy helpers (NEWLINES after each <p>/<block>)
    // =========================

    function getBlockKeyForNode(node) {
        const el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
        if (!el) return "body";
        const block = el.closest(BLOCK_SELECTOR) || document.body;
        return `${block.tagName.toLowerCase()}|${getXPath(block) || ""}`;
    }

    function collectMarksInDomOrder() {
        return Array.from(document.querySelectorAll(`mark.${HIGHLIGHT_CLASS}[data-hl-id]`));
    }

    function buildCopyTextWithParagraphNewlines(marks) {
        const out = [];
        let lastBlockKey = null;

        for (const m of marks) {
            const txt = (m.textContent || "").replace(/\s+/g, " ").trim();
            if (!txt) continue;

            const blockKey = getBlockKeyForNode(m);

            if (lastBlockKey && blockKey !== lastBlockKey) {
                if (out.length && out[out.length - 1] !== "\n") out.push("\n");
            } else if (out.length && out[out.length - 1] !== "\n") {
                out.push(" ");
            }

            out.push(txt);
            lastBlockKey = blockKey;
        }

        return out
            .join("")
            .replace(/[ \t]+\n/g, "\n")
            .replace(/\n[ \t]+/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }

    // =========================
    // Storage (✅ guarded)
    // =========================

    async function loadHighlightsForPage() {
        if (!isExtAlive()) return [];
        const key = getPageKey();
        try {
            const data = await chrome.storage.local.get(key);
            return Array.isArray(data[key]) ? data[key] : [];
        } catch (e) {
            if (safeIgnoreInvalidation(e)) return [];
            throw e;
        }
    }

    async function saveHighlightsForPage(list) {
        if (!isExtAlive()) return;
        const key = getPageKey();
        try {
            await chrome.storage.local.set({ [key]: list });
        } catch (e) {
            if (safeIgnoreInvalidation(e)) return;
            throw e;
        }
    }

    // =========================
    // Core features
    // =========================

    async function addHighlightFromSelection() {
        if (!isExtAlive()) return;

        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;

        const range = sel.getRangeAt(0);
        if (range.collapsed) return;

        if (isEditableTarget(range.startContainer) || isEditableTarget(range.endContainer)) return;

        const selectedText = sel.toString().trim();
        if (!selectedText) return;

        const common =
            range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
                ? range.commonAncestorContainer
                : range.commonAncestorContainer.parentElement;

        if (common && common.closest && common.closest(`mark.${HIGHLIGHT_CLASS}`)) return;

        const id = genId();

        const startXPath = getXPath(range.startContainer);
        const endXPath = getXPath(range.endContainer);
        if (!startXPath || !endXPath) return;

        const blockEl = getBlockElementForRange(range);
        const blockXPath = getXPath(blockEl) || null;

        const snap = buildSnapshot(blockEl);
        const lin = rangeToLinearOffsets(range, snap.map);

        const anchor = makeQuoteAnchorFromSelection(range, blockEl, 30);

        const record = {
            id,
            text: selectedText,

            blockXPath,
            startIndex: lin?.startIndex ?? null,
            endIndex: lin?.endIndex ?? null,

            quote: anchor?.quote || selectedText,
            prefix: anchor?.prefix || "",
            suffix: anchor?.suffix || "",

            startXPath,
            startOffset: range.startOffset,
            endXPath,
            endOffset: range.endOffset,

            createdAt: Date.now(),
        };

        try {
            wrapRangeSemantic(range, id);
        } catch {
            return;
        }

        try {
            const list = await loadHighlightsForPage();
            if (!isExtAlive()) return;
            list.push(record);
            await saveHighlightsForPage(list);
        } catch (e) {
            if (!safeIgnoreInvalidation(e)) console.error(e);
        }
    }

    async function restoreHighlights() {
        if (!isExtAlive()) return;

        try {
            const list = await loadHighlightsForPage();
            if (!isExtAlive() || !list.length) return;

            const candidates = [];

            for (const rec of list) {
                if (!isExtAlive()) return;

                if (document.querySelector(`mark.${HIGHLIGHT_CLASS}[data-hl-id="${CSS.escape(rec.id)}"]`)) {
                    continue;
                }

                let range = null;
                let sortKey = -1;

                let rootEl = null;
                if (rec.blockXPath) {
                    const node = getNodeByXPath(rec.blockXPath);
                    if (node && node.nodeType === Node.ELEMENT_NODE) rootEl = node;
                }
                if (!rootEl) rootEl = document.body;

                const snap = buildSnapshot(rootEl);

                if (typeof rec.startIndex === "number" && typeof rec.endIndex === "number") {
                    range = linearOffsetsToRange(snap.map, rec.startIndex, rec.endIndex);
                    sortKey = rec.startIndex;
                }

                if (!range) {
                    range = findRangeByQuoteAnchor(
                        {
                            quote: rec.quote || rec.text,
                            prefix: rec.prefix || "",
                            suffix: rec.suffix || "",
                        },
                        rootEl
                    );

                    if (range) {
                        const lin = rangeToLinearOffsets(range, snap.map);
                        sortKey = lin?.startIndex ?? -1;
                    }
                }

                if (!range) {
                    const startNode = getNodeByXPath(rec.startXPath);
                    const endNode = getNodeByXPath(rec.endXPath);
                    if (startNode && endNode) {
                        const r = document.createRange();
                        try {
                            r.setStart(
                                startNode,
                                Math.min(rec.startOffset, startNode.textContent?.length ?? rec.startOffset)
                            );
                            r.setEnd(
                                endNode,
                                Math.min(rec.endOffset, endNode.textContent?.length ?? rec.endOffset)
                            );
                            if (!r.collapsed) range = r;
                        } catch {
                            range = null;
                        }
                    }
                }

                if (range && !range.collapsed) {
                    candidates.push({ rec, range, sortKey });
                }
            }

            candidates.sort((a, b) => (b.sortKey || 0) - (a.sortKey || 0));

            for (const item of candidates) {
                if (!isExtAlive()) return;
                try {
                    wrapRangeSemantic(item.range, item.rec.id);
                } catch {
                    continue;
                }
            }
        } catch (e) {
            if (!safeIgnoreInvalidation(e)) console.error(e);
        }
    }

    async function removeHighlightById(id) {
        if (!isExtAlive()) return [];
        unwrapHighlightMarksById(id);

        try {
            const list = await loadHighlightsForPage();
            const next = list.filter((x) => x.id !== id);
            await saveHighlightsForPage(next);
            return next;
        } catch (e) {
            if (!safeIgnoreInvalidation(e)) console.error(e);
            return [];
        }
    }

    async function clearAllHighlights() {
        if (!isExtAlive()) return [];
        const ids = Array.from(new Set(getHighlightsOnDom().map((m) => m.dataset.hlId).filter(Boolean)));
        for (const id of ids) unwrapHighlightMarksById(id);

        try {
            await saveHighlightsForPage([]);
        } catch (e) {
            if (!safeIgnoreInvalidation(e)) console.error(e);
        }
        return [];
    }

    async function listHighlights() {
        if (!isExtAlive()) return [];
        const list = await loadHighlightsForPage();

        // ✅ keep paragraph breaks inside one highlight id too
        const domById = new Map();
        for (const m of getHighlightsOnDom()) {
            const id = m.dataset.hlId;
            if (!id) continue;

            const blockKey = getBlockKeyForNode(m);
            const t0 = (m.textContent || "").replace(/\s+/g, " ").trim();
            if (!t0) continue;

            const prev = domById.get(id) || [];
            prev.push({ blockKey, t: t0 });
            domById.set(id, prev);
        }

        return list.map((item) => {
            const parts = domById.get(item.id);

            if (!parts || !parts.length) {
                return { id: item.id, text: (item.text || "").trim() };
            }

            let text = "";
            let last = null;

            for (const p of parts) {
                if (last && p.blockKey !== last) text += "\n";
                else if (text) text += " ";
                text += p.t;
                last = p.blockKey;
            }

            return { id: item.id, text: text.trim() };
        });
    }

    // =========================
    // Pencil UI (show after selection)
    // =========================

    let _pencilBtn = null;
    let _pencilHideTimer = null;

    function removePencil() {
        if (_pencilBtn) {
            _pencilBtn.remove();
            _pencilBtn = null;
        }
    }

    function selectionIsValid(sel) {
        if (!sel || sel.rangeCount === 0) return false;
        const range = sel.getRangeAt(0);
        if (range.collapsed) return false;

        if (isEditableTarget(range.startContainer) || isEditableTarget(range.endContainer)) return false;

        const txt = sel.toString().trim();
        if (!txt) return false;

        const common =
            range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
                ? range.commonAncestorContainer
                : range.commonAncestorContainer.parentElement;

        if (common && common.closest && common.closest(`mark.${HIGHLIGHT_CLASS}`)) return false;

        return true;
    }

    function showPencilForSelection() {
        if (!isExtAlive()) return;

        clearTimeout(_pencilHideTimer);

        const sel = window.getSelection();
        if (!selectionIsValid(sel)) {
            removePencil();
            return;
        }

        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        if (!rect || (rect.width === 0 && rect.height === 0)) {
            removePencil();
            return;
        }

        if (!_pencilBtn) {
            _pencilBtn = document.createElement("button");
            _pencilBtn.type = "button";
            _pencilBtn.setAttribute("aria-label", L("ariaHighlightSelection"));
            _pencilBtn.title = L("titleHighlight");

            const img = document.createElement("img");
            img.src = chrome.runtime?.getURL ? chrome.runtime.getURL("/icons/16x16.png") : "/icons/16x16.png";
            img.alt = L("altHighlight");
            img.style.cssText = `
        width: 16px;
        height: 16px;
        display: block;
      `;

            _pencilBtn.appendChild(img);

            _pencilBtn.style.cssText = `
        position: fixed;
        z-index: 2147483647;
        border: none;
        outline: none;
        cursor: pointer;
        padding: 6px 8px;
        border-radius: 10px;
        background: rgba(20,20,20,0.92);
        box-shadow: 0 6px 18px rgba(0,0,0,0.25);
        user-select: none;
      `.trim();

            _pencilBtn.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
            });

            _pencilBtn.addEventListener("click", async (e) => {
                e.preventDefault();
                e.stopPropagation();
                await addHighlightFromSelection();
                removePencil();
            });

            document.documentElement.appendChild(_pencilBtn);
        }

        const top = Math.max(8, rect.top - 36);
        const left = Math.min(window.innerWidth - 40, rect.right + 8);

        _pencilBtn.style.top = `${top}px`;
        _pencilBtn.style.left = `${left}px`;

        _pencilHideTimer = setTimeout(() => {
            removePencil();
        }, 2500);
    }

    // =========================
    // Smart restore (dynamic pages)
    // =========================

    let _restoreTimer = null;
    let _observer = null;
    let _restoreRunId = 0;

    function debounceRestore(delay = 400) {
        clearTimeout(_restoreTimer);
        _restoreTimer = setTimeout(async () => {
            if (!isExtAlive()) return;

            const myId = ++_restoreRunId;
            try {
                await restoreHighlights();
            } catch (e) {
                if (!safeIgnoreInvalidation(e)) console.error(e);
                return;
            }
            if (myId !== _restoreRunId) return;
        }, delay);
    }

    function startSmartRestore() {
        debounceRestore(0);

        window.addEventListener("load", () => debounceRestore(0), { once: true });

        setTimeout(() => debounceRestore(0), 800);
        setTimeout(() => debounceRestore(0), 2000);

        const start = Date.now();
        _observer = new MutationObserver(() => {
            debounceRestore(500);
            if (Date.now() - start > 8000) {
                try {
                    _observer.disconnect();
                } catch { }
                _observer = null;
            }
        });

        try {
            _observer.observe(document.documentElement, {
                childList: true,
                subtree: true,
                characterData: true,
            });
        } catch { }
    }

    // =========================
    // Events
    // =========================

    document.addEventListener("mouseup", () => {
        setTimeout(() => showPencilForSelection(), 0);
    });

    document.addEventListener("selectionchange", () => {
        clearTimeout(_pencilHideTimer);
        _pencilHideTimer = setTimeout(() => showPencilForSelection(), 80);
    });

    document.addEventListener("mousedown", (e) => {
        if (_pencilBtn && e.target !== _pencilBtn) removePencil();
    });

    window.addEventListener("scroll", () => removePencil(), true);
    window.addEventListener("resize", () => removePencil());

    startSmartRestore();

    // Messages from popup
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        (async () => {
            if (!isExtAlive()) {
                try {
                    sendResponse({ ok: false, reason: "dead" });
                } catch { }
                return;
            }

            try {
                if (msg?.type === "GET_HIGHLIGHTS") {
                    const items = await listHighlights();
                    sendResponse({ ok: true, items });
                    return;
                }

                // ✅ NEW: return full stored records (for UNDO of CLEAR_ALL)
                if (msg?.type === "GET_RECORDS") {
                    const records = await loadHighlightsForPage();
                    sendResponse({ ok: true, records });
                    return;
                }

                // ✅ UPDATED: delete highlight returns deletedRecord for UNDO
                if (msg?.type === "REMOVE_HIGHLIGHT" && msg.id) {
                    const before = await loadHighlightsForPage();
                    const deletedRecord = before.find((x) => x.id === msg.id) || null;

                    const items = await removeHighlightById(msg.id);
                    sendResponse({
                        ok: true,
                        deletedRecord,
                        items: items.map((x) => ({ id: x.id, text: x.text })),
                    });
                    return;
                }

                // ✅ NEW: restore one highlight (UNDO)
                if (msg?.type === "RESTORE_HIGHLIGHT" && msg.record?.id) {
                    try {
                        const rec = msg.record;

                        const list = await loadHighlightsForPage();
                        if (!list.some((x) => x.id === rec.id)) {
                            list.push(rec);
                            await saveHighlightsForPage(list);
                        }

                        await restoreHighlights();

                        const items = await listHighlights();
                        sendResponse({ ok: true, items });
                        return;
                    } catch (e) {
                        if (!safeIgnoreInvalidation(e)) console.error(e);
                        sendResponse({ ok: false });
                        return;
                    }
                }

                if (msg?.type === "CLEAR_ALL") {
                    await clearAllHighlights();
                    sendResponse({ ok: true, items: [] });
                    return;
                }

                // ✅ newline after each <p>/<block> when copying
                if (msg?.type === "COPY_ALL") {
                    const marks = collectMarksInDomOrder();
                    const text = buildCopyTextWithParagraphNewlines(marks);
                    sendResponse({ ok: true, text });
                    return;
                }

                sendResponse({ ok: false });
            } catch (e) {
                if (!safeIgnoreInvalidation(e)) console.error(e);
                try {
                    sendResponse({ ok: false });
                } catch { }
            }
        })();

        return true;
    });
})();
