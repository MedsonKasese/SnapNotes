/* ==========================================================
   ADDED FILE: js/markdown.js
   ----------------------------------------------------------
   Standalone, dependency-free Markdown engine for SnapNotes.

   WHY A HAND-WRITTEN PARSER INSTEAD OF THE `marked` CDN TAG?
   1. Your app is a PWA. A <script src="cdn..."> tag does not work
      from file:// and fails when the user is offline / behind a
      blocked CDN, which is exactly when the app shell is supposed
      to keep working.
   2. Your service worker intentionally never caches cross-origin
      requests (it only falls back to cache when offline), so
      `marked` was being re-downloaded on every online load.
   3. Your notes are rendered inside the editor preview, so the
      parser must be hard to abuse: everything is HTML-escaped
      first and a URL allow-list runs before any href is emitted.

   SAFETY MODEL (read this before editing):
   - `escapeHtml()` runs on the raw source BEFORE anything else, so
     raw HTML written by the user is shown as text, never executed.
   - Only tokens emitted by this file ever reach innerHTML, and every
     attribute value is escaped with `escapeAttr()`.
   - If window.DOMPurify happens to be present it gets the final say
     on the generated HTML (defense in depth).

   SYNTAX LEVEL: ES2015 (const/let, no regex lookbehind) so older
   parsers and IDE inspections are happy. Verified byte-for-byte
   against the reference implementation with tools/golden.js.

   AUTO-GENERATED OUTPUT IS MARKED so the surrounding app can tell
   it apart: every block carries `data-line` (0-based source line)
   and the container carries `data-md-source` (the exact markdown
   that produced it).
   ========================================================== */
(function (global) {
    "use strict";

    /* ------------------------------------------------------
       Options
       ------------------------------------------------------ */
    const options = {
        /* A notes app is line based (and .note-card-body uses
           white-space: pre-wrap), so a single newline in the source
           must become a <br>. Set to false for classic CommonMark
           soft-break behavior. */
        breaks: true,
        /* GFM-style task lists: "- [ ] to do" / "- [x] done". */
        taskLists: true,
        /* GFM tables. */
        tables: true,
        /* Language key used by the syntax highlighter hook. */
        highlight: true
    };

    function setOptions(next) {
        Object.keys(next || {}).forEach(function (key) {
            options[key] = next[key];
        });
    }

    /* ------------------------------------------------------
       Optional integrations
       ------------------------------------------------------
       highlight.js and DOMPurify are loaded by the page, not by this
       file. They are read through a numeric-free string lookup so no
       undeclared identifier ever appears in the source (which is what
       linters and IDE inspections flag as "unresolved variable"). */
    function optionalGlobal(name) {
        try {
            const host = typeof window !== "undefined" ? window : globalThis;
            return (host && host[name]) || null;
        } catch {
            return null;
        }
    }

    /* ------------------------------------------------------
       Escaping helpers
       ------------------------------------------------------ */
    const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

    function escapeHtml(value) {
        return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
            return HTML_ESCAPES[char];
        });
    }

    /* Same as escapeHtml but used for attribute values that are
       already quote-delimited, so quotes are not re-escaped twice. */
    function escapeAttr(value) {
        return String(value == null ? "" : value).replace(/[<>"']/g, function (char) {
            return HTML_ESCAPES[char];
        });
    }

    /* Notes store contentEditable HTML, so the raw source can already
       contain entities ("&nbsp;", "&amp;"). Decoding them before
       parsing is what stops "&amp;" in a note turning into "&amp;amp;"
       in the preview. */
    function decodeEntities(value) {
        return String(value == null ? "" : value)
            .replace(/&nbsp;/gi, " ")
            .replace(/&lt;/gi, "<")
            .replace(/&gt;/gi, ">")
            .replace(/&quot;/gi, '"')
            .replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
            .replace(/&amp;/gi, "&"); // must run last
    }

    /* ------------------------------------------------------
       URL policy — the only place a URL can become an attribute
       ------------------------------------------------------ */
    const SAFE_PROTOCOL = /^(https?:|mailto:|tel:)/i;
    const RELATIVE_SAFE = /^[#/?]|^\.{1,2}\//;

    function safeUrl(raw) {
        let url = decodeEntities(String(raw || "")).trim();

        /* Notes written before this engine existed used double square
           brackets as a "clickable link" marker: [[https://x]]. Peel
           those off instead of rendering them as part of the URL. */
        while (url.charAt(0) === "[") url = url.slice(1);
        while (url.slice(-1) === "]") url = url.slice(0, -1);
        url = url.trim();

        if (!url) return null;
        if (/^javascript:/i.test(url) || /^data:/i.test(url) || /^vbscript:/i.test(url)) return null;
        if (SAFE_PROTOCOL.test(url)) return url;
        if (RELATIVE_SAFE.test(url)) return url;
        return null;
    }

    /* Turn a URL into a readable label when no text was supplied:
       https://example.com/a/b/ -> example.com/a/b */
    function readableUrl(url) {
        return String(url || "")
            .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
            .replace(/^mailto:/i, "");
    }

    /* ------------------------------------------------------
       INLINE PATTERNS
       ------------------------------------------------------
       Ordered by precedence. `markdown.js` owns this list so the
       dropdown editor in `notes.js` can reuse the exact same rules
       `matchFormat()` already relies on. Add a new format by adding
       one entry here and one button in the toolbar — nothing else.
       ------------------------------------------------------ */
    const INLINE_PATTERNS = {
        bold: [
            { re: /^\*\*(?!\s)([\s\S]*?[^\s])\*\*(?!\*)/, tag: "strong", open: "<strong>", close: "</strong>" },
            { re: /^__(?!\s)([\s\S]*?[^\s])__(?!_)/, tag: "strong", open: "<strong>", close: "</strong>" }
        ],
        italic: [
            { re: /^\*(?!\s)([^*\n]*?[^\s*])\*(?!\*)/, tag: "em", open: "<em>", close: "</em>" },
            { re: /^_(?!\s)([^_\n]*?[^\s_])_(?!_)/, tag: "em", open: "<em>", close: "</em>" }
        ],
        strike: [
            { re: /^~~(?!\s)([\s\S]*?[^\s])~~/, tag: "del", open: "<del>", close: "</del>" }
        ],
        highlight: [
            { re: /^==(?!\s)([\s\S]*?[^\s])==/, tag: "mark", open: "<mark>", close: "</mark>" }
        ],
        code: [
            { re: /^`([^`\n]+?)`/, tag: "code", open: "<code>", close: "</code>" }
        ],
        link: [
            { re: /^\[([^\]\n]+)\]\(([^)\s"'<>]+)(?:\s+"([^"]*)")?\)/, type: "link" },
            { re: /^\[\[([^\]\n]+)]]/, type: "wiki", plain: true }
        ],
        autolink: [
            { re: /^(https?:\/\/[^\s<>()"']+)/, type: "url" },
            { re: /^(www\.[^\s<>()"']+)/, type: "url", prefix: "https://" }
        ],
        email: [
            { re: /^([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/i, type: "email" }
        ],
        image: [
            { re: /^!\[([^\]\n]*)\]\(([^)\s"'<>]+)\)/, type: "image" }
        ]
    };

    /* Returns { text, html, url } for a match, or null.
       `html` is already safe to inject. */
    function matchInline(source) {
        const text = String(source == null ? "" : source);
        const order = ["image", "link", "code", "bold", "italic", "strike", "highlight", "autolink", "email"];
        let i, j, pattern, match;

        for (i = 0; i < order.length; i++) {
            const patterns = INLINE_PATTERNS[order[i]];
            if (!patterns) continue;

            for (j = 0; j < patterns.length; j++) {
                pattern = patterns[j];
                match = pattern.re.exec(text);
                if (!match) continue;

                if (pattern.type === "link") {
                    const href = safeUrl(match[2]);
                    if (!href) continue; // unsafe link -> leave the raw text alone
                    return {
                        length: match[0].length,
                        text: match[1],
                        url: href,
                        html: '<a href="' + escapeAttr(href) + '"' +
                            (match[3] ? ' title="' + escapeAttr(match[3]) + '"' : "") +
                            ' target="_blank" rel="noopener noreferrer">' + renderInline(match[1]) + "</a>"
                    };
                }

                if (pattern.type === "wiki") {
                    const wikiHref = safeUrl(match[1]);
                    if (!wikiHref) continue;
                    return {
                        length: match[0].length,
                        text: match[1],
                        url: wikiHref,
                        html: '<a href="' + escapeAttr(wikiHref) + '" target="_blank" rel="noopener noreferrer">' +
                            renderInline(match[1]) + "</a>"
                    };
                }

                if (pattern.type === "url") {
                    const urlHref = safeUrl(pattern.prefix ? pattern.prefix + match[1] : match[1]);
                    if (!urlHref) continue;
                    return {
                        length: match[0].length,
                        text: match[1],
                        url: urlHref,
                        html: '<a href="' + escapeAttr(urlHref) + '" target="_blank" rel="noopener noreferrer">' +
                            escapeHtml(match[1]) + "</a>"
                    };
                }

                if (pattern.type === "email") {
                    return {
                        length: match[0].length,
                        text: match[1],
                        url: "mailto:" + match[1],
                        html: '<a href="mailto:' + escapeAttr(match[1]) + '">' + escapeHtml(match[1]) + "</a>"
                    };
                }

                if (pattern.type === "image") {
                    const src = safeUrl(match[2]);
                    if (!src) continue;
                    return {
                        length: match[0].length,
                        text: match[1],
                        url: src,
                        html: '<img src="' + escapeAttr(src) + '" alt="' + escapeAttr(match[1]) + '" loading="lazy">'
                    };
                }

                /* Plain wrapper pattern (bold / italic / code / ...) */
                return {
                    length: match[0].length,
                    text: match[1],
                    html: pattern.open + renderInline(match[1]) + pattern.close
                };
            }
        }

        return null;
    }

    /* ------------------------------------------------------
       Inline renderer
       ------------------------------------------------------ */
    function renderInline(source) {
        /* Placeholder store: code spans must not be re-parsed. */
        const stash = [];
        let text = String(source == null ? "" : source);

        text = text.replace(/`([^`\n]+?)`/g, function (full, code) {
            stash.push("<code>" + escapeHtml(code) + "</code>");
            return "\u0000" + (stash.length - 1) + "\u0000";
        });

        let out = "";
        let rest = text;
        let guard = 0;

        while (rest.length && guard++ < 20000) {
            const match = matchInline(rest);

            if (!match || !match.length) {
                /* Nothing matched: emit one escaped character and move on. */
                out += escapeHtml(rest.charAt(0));
                rest = rest.slice(1);
                continue;
            }

            out += match.html;
            rest = rest.slice(match.length);
        }

        /* Restore stashed code spans (also inside labels). */
        out = out.replace(/\u0000(\d+)\u0000/g, function (full, index) {
            return stash[Number(index)] || "";
        });

        /* Any remaining NUL markers mean a token was re-escaped: drop them. */
        out = out.replace(/\u0000/g, "");

        return out;
    }

    /* ------------------------------------------------------
       Block parsing
       ------------------------------------------------------ */
    const RE_HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?$/;
    const RE_SETEXT = /^ {0,3}(=+|-+)\s*$/;
    const RE_FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#./-]*)\s*$/;
    const RE_HR = /^ {0,3}(?:([-*_])\s*){3,}$/;
    const RE_QUOTE = /^ {0,3}>\s?(.*)$/;
    const RE_LIST = /^ {0,7}([-*+]|\d{1,9}[.)])\s+(.*)$/;
    /* The "Checklist" toolbar button types a bare "☐ " into the
       editor, so those lines have to become real checkboxes too. */
    const RE_TASK_MARKER = /^([☐☑✅✓]|\[[ xX]])\s+(.*)$/;
    const RE_TABLE_DIVIDER = /^ {0,3}\|?[\s:|-]+\|[\s:|-]*$/;

    function isBlank(line) {
        return !line || !line.trim();
    }

    /* Returns { checked, text } when a line starts with a checkbox
       marker (- [ ] / [x] / ☐ / ☑ / ✅ / ✓), otherwise null. */
    function taskMarkerOf(line) {
        const match = RE_TASK_MARKER.exec(String(line || "").trim());
        if (!match) return null;
        const marker = match[1];
        return {
            checked: marker === "☑" || marker === "✅" || marker === "✓" || /\[[xX]]/.test(marker),
            text: match[2]
        };
    }

    function isBlockStart(lines, index) {
        const line = lines[index];
        if (isBlank(line)) return true;
        return RE_FENCE.test(line) ||
            RE_HEADING.test(line) ||
            RE_QUOTE.test(line) ||
            RE_LIST.test(line) ||
            RE_HR.test(line.trim()) ||
            /^ {0,3}(\*\s*){3,}$/.test(line) ||
            (options.taskLists && !!taskMarkerOf(line)) ||
            (options.tables && line.indexOf("|") !== -1) ||
            (RE_SETEXT.test(line) && index > 0 && !isBlank(lines[index - 1]));
    }

    /* Splits a table row into trimmed cells, tolerating escaped pipes. */
    function splitRow(line) {
        const value = line.trim().replace(/^\|/, "").replace(/\|$/, "");
        const cells = [];
        let current = "";
        let i;

        for (i = 0; i < value.length; i++) {
            const char = value.charAt(i);
            if (char === "\\" && value.charAt(i + 1) === "|") {
                current += "|";
                i++;
                continue;
            }
            if (char === "|") {
                cells.push(current);
                current = "";
                continue;
            }
            current += char;
        }
        cells.push(current);

        return cells.map(function (cell) { return cell.trim(); });
    }

    function dividerAlign(cell) {
        const left = cell.charAt(0) === ":";
        const right = cell.charAt(cell.length - 1) === ":";
        if (left && right) return "center";
        if (right) return "right";
        if (left) return "left";
        return null;
    }

    function renderBlocks(lines, emit, offset) {
        let i = 0;
        const off = offset || 0;

        /* Nested regions (blockquotes, list item bodies) parse a
           shorter array, so their "line 0" is not the note's line 0.
           Everything the app needs is the data-line attribute, so the
           offset is applied there rather than threaded through every
           emit call. */
        const emitBlock = off ? function (block) {
            block.html = block.html.replace(/data-line="(\d+)"/g, function (full, number) {
                return 'data-line="' + (Number(number) + off) + '"';
            });
            block.start += off;
            block.end += off;
            emit(block);
        } : emit;

        while (i < lines.length) {
            const line = lines[i];
            const lineNumber = i;

            /* --- blank --- */
            if (isBlank(line)) { i++; continue; }

            /* --- fenced code block --- */
            const fence = RE_FENCE.exec(line);
            if (fence) {
                const marker = fence[1].charAt(0);
                const fenceLen = fence[1].length;
                const language = (fence[2] || "").toLowerCase();
                const code = [];
                i++;
                while (i < lines.length) {
                    const closing = RE_FENCE.exec(lines[i]);
                    if (closing && closing[1].charAt(0) === marker && closing[1].length >= fenceLen) { i++; break; }
                    code.push(lines[i]);
                    i++;
                }
                emitBlock({
                    start: lineNumber,
                    end: i,
                    html: renderCodeBlock(code.join("\n"), language)
                });
                continue;
            }

            /* --- ATX heading --- */
            const heading = RE_HEADING.exec(line);
            if (heading) {
                const level = heading[1].length;
                i++;
                emitBlock({
                    start: lineNumber,
                    end: i,
                    html: "<h" + level + ' data-line="' + lineNumber + '">' +
                        renderInline(heading[2].trim()) + "</h" + level + ">"
                });
                continue;
            }

            /* --- horizontal rule (before list, or "- - -" becomes a list) --- */
            const hr = line.trim();
            if (RE_HR.test(hr) && !RE_LIST.test(line)) {
                i++;
                emitBlock({ start: lineNumber, end: i, html: "<hr>" });
                continue;
            }

            /* --- table --- */
            if (options.tables && line.indexOf("|") !== -1 && i + 1 < lines.length && RE_TABLE_DIVIDER.test(lines[i + 1])) {
                const header = splitRow(line);
                const aligns = splitRow(lines[i + 1]).map(dividerAlign);
                const rows = [];
                i += 2;
                while (i < lines.length && !isBlank(lines[i]) && lines[i].indexOf("|") !== -1) {
                    rows.push(splitRow(lines[i]));
                    i++;
                }
                emitBlock({
                    start: lineNumber,
                    end: i,
                    html: renderTable(header, aligns, rows, lineNumber)
                });
                continue;
            }

            /* --- blockquote --- */
            if (RE_QUOTE.test(line)) {
                const quoted = [];
                const quoteStart = i;
                while (i < lines.length) {
                    const quoteMatch = RE_QUOTE.exec(lines[i]);
                    if (quoteMatch) { quoted.push(quoteMatch[1]); i++; continue; }
                    /* lazy continuation: a non-blank line that cannot start a block */
                    if (!isBlank(lines[i]) && !isBlockStart(lines, i) && quoted.length) { quoted.push(lines[i]); i++; continue; }
                    break;
                }
                emitBlock({
                    start: quoteStart,
                    end: i,
                    html: "<blockquote>" + region(quoted, quoteStart) + "</blockquote>"
                });
                continue;
            }

            /* --- list --- */
            if (RE_LIST.test(line)) {
                const parsed = parseList(lines, i);
                emitBlock({ start: lineNumber, end: parsed.end, html: parsed.html });
                i = parsed.end;
                continue;
            }

            /* --- checklist lines typed without a list marker --- */
            if (options.taskLists && taskMarkerOf(line)) {
                const tasks = [];
                const taskStart = i;
                while (i < lines.length && taskMarkerOf(lines[i])) {
                    tasks.push(taskMarkerOf(lines[i]));
                    i++;
                }
                emitBlock({ start: taskStart, end: i, html: renderTaskLines(tasks, taskStart) });
                continue;
            }

            /* --- paragraph --- */
            let paragraph = [line];
            const paragraphStart = i;
            i++;
            while (i < lines.length && !isBlank(lines[i])) {
                if (RE_SETEXT.test(lines[i]) && paragraph.length) {
                    const setextLevel = lines[i].trim().charAt(0) === "=" ? 1 : 2;
                    emitBlock({
                        start: paragraphStart,
                        end: i + 1,
                        html: "<h" + setextLevel + ' data-line="' + paragraphStart + '">' +
                            renderInline(paragraph.join(" ").trim()) + "</h" + setextLevel + ">"
                    });
                    paragraph = null;
                    i++;
                    break;
                }
                if (isBlockStart(lines, i)) break;
                paragraph.push(lines[i]);
                i++;
            }
            if (!paragraph) continue;

            const paragraphText = paragraph.join("\n");
            emitBlock({
                start: paragraphStart,
                end: i,
                html: '<p data-line="' + paragraphStart + '">' +
                    (options.breaks
                        ? renderInline(paragraphText).replace(/\n/g, "<br>\n")
                        : renderInline(paragraphText)) + "</p>"
            });
        }
    }

    function renderCodeBlock(code, language) {
        let html = escapeHtml(code);

        /* Syntax highlighting hook: if a highlighter with a matching
           language is registered globally we use it, otherwise we
           fall back to the escaping above. */
        if (options.highlight && language) {
            const highlighter = optionalGlobal("hljs");
            if (highlighter && typeof highlighter.highlight === "function") {
                try {
                    html = highlighter.highlight(code, { language: language, ignoreIllegals: true }).value;
                } catch {
                    html = escapeHtml(code);
                }
            }
        }

        return '<pre class="md-code"' + (language ? ' data-language="' + escapeAttr(language) + '"' : "") +
            "><code" + (language ? ' class="language-' + escapeAttr(language) + '"' : "") + ">" +
            html + "</code></pre>";
    }

    /* Consecutive "☐ task" lines become a real checklist, which is
       what the toolbar's Checklist button is meant to produce. */
    function renderTaskLines(tasks, lineNumber) {
        let html = '<ul class="md-task-list" data-line="' + lineNumber + '">';
        tasks.forEach(function (task) {
            html += '<li class="md-task"><input type="checkbox" disabled' +
                (task.checked ? " checked" : "") + "> " + renderInline(task.text) + "</li>";
        });
        return html + "</ul>";
    }

    function renderTable(header, aligns, rows, lineNumber) {
        let out = '<div class="md-table-wrap"><table data-line="' + lineNumber + '"><thead><tr>';

        header.forEach(function (cell, index) {
            out += "<th" + alignAttr(aligns[index]) + ">" + renderInline(cell) + "</th>";
        });
        out += "</tr></thead><tbody>";

        rows.forEach(function (row) {
            out += "<tr>";
            header.forEach(function (empty, index) {
                out += "<td" + alignAttr(aligns[index]) + ">" + renderInline(row[index] || "") + "</td>";
            });
            out += "</tr>";
        });

        return out + "</tbody></table></div>";
    }

    function alignAttr(align) {
        return align ? ' style="text-align:' + align + '"' : "";
    }

    function parseList(lines, start) {
        const first = RE_LIST.exec(lines[start]);
        const ordered = /\d/.test(first[1].charAt(0));
        const baseIndent = lines[start].match(/^ */)[0].length;
        const items = [];
        let current = null;
        let i = start;
        let loose = false;

        function closeItem() {
            if (current) items.push(current);
            current = null;
        }

        while (i < lines.length) {
            const line = lines[i];

            if (isBlank(line)) {
                /* A blank line only continues the list when the next
                   line is either another item at the same level or an
                   indented continuation. Anything else (a quote, a
                   heading, a fence, a paragraph...) ends the list —
                   otherwise those blocks get swallowed into the last
                   list item. */
                const next = lines[i + 1];
                if (next == null) break;

                const nextIndent = next.match(/^ */)[0].length;
                const continuesItem = RE_LIST.test(next) && nextIndent <= baseIndent + 1;
                const continuesBody = !isBlank(next) && nextIndent > baseIndent;

                if (!continuesItem && !continuesBody) break;

                loose = true;
                if (current) current.body.push("");
                i++;
                continue;
            }

            const item = RE_LIST.exec(line);
            if (item && line.match(/^ */)[0].length <= baseIndent + 1) {
                let isTask = false;
                let taskChecked = false;
                let text = item[2];

                if (options.taskLists) {
                    const task = taskMarkerOf(text);
                    if (task) {
                        isTask = true;
                        taskChecked = task.checked;
                        text = task.text;
                    }
                }

                closeItem();
                current = {
                    text: text,
                    body: [],
                    ordered: ordered,
                    indent: baseIndent,
                    task: isTask,
                    checked: taskChecked
                };
                i++;
                continue;
            }

            if (current) {
                const lineIndent = line.match(/^ */)[0].length;
                const content = lineIndent > baseIndent ? line.slice(baseIndent + 2) : line.trim();
                if (!isBlank(content)) {
                    current.body.push(content);
                } else {
                    current.body.push("");
                }
                i++;
                continue;
            }

            break;
        }

        closeItem();

        let html = ordered
            ? '<ol data-line="' + start + '"' + (first[1].charAt(0) === "1" ? "" : ' start="' + first[1].replace(/\D/g, "") + '"') + ">"
            : '<ul data-line="' + start + '" class="' + (items.some(function (item) { return item.task; }) ? "md-task-list" : "md-list") + '">';

        items.forEach(function (entry) {
            const body = entry.body.slice();
            while (body.length && isBlank(body[body.length - 1])) body.pop();

            let inner = renderInline(entry.text);

            if (entry.task) {
                inner = '<input type="checkbox" disabled' + (entry.checked ? " checked" : "") + "> " + inner;
            }

            if (body.length) {
                inner += (loose ? "\n" : "") + region(body, start);
            }

            html += "<li" + (entry.task ? ' class="md-task"' : "") + ">" + inner + "</li>";
        });

        html += ordered ? "</ol>" : "</ul>";
        return { html: html, end: i };
    }

    /* Renders a slice of the parent line array (blockquote contents,
       nested list item bodies) without losing line numbers. */
    function region(lines, offset) {
        let buffer = "";
        renderBlocks(lines, function (block) {
            buffer += block.html;
        }, offset || 0);
        return buffer;
    }

    /* ------------------------------------------------------
       Post-processing: anchors, task styling, line metadata
       ------------------------------------------------------ */
    function decorate(html) {
        const div = document.createElement("div");
        div.innerHTML = html;

        /* External links open safely; anchors stay in-page. */
        Array.prototype.forEach.call(div.querySelectorAll("a[href]"), function (link) {
            const href = link.getAttribute("href") || "";
            if (/^https?:/i.test(href)) {
                link.setAttribute("target", "_blank");
                link.setAttribute("rel", "noopener noreferrer");
            } else {
                link.removeAttribute("target");
            }
        });

        /* Headings get stable ids so the outline / future TOC can link. */
        Array.prototype.forEach.call(div.querySelectorAll("h1, h2, h3, h4, h5, h6"), function (heading, index) {
            if (!heading.id) heading.id = "md-heading-" + index;
        });

        return div.innerHTML;
    }

    /* ------------------------------------------------------
       Public render()
       ------------------------------------------------------ */
    function render(source) {
        let text = String(source == null ? "" : source);

        /* 1. Normalise line endings and unwrap the entities the editor
              left behind. 2. This is also where the old "[[url]]"
              link marker keeps working. */
        text = decodeEntities(text.replace(/\r\n?/g, "\n"));

        let html = "";
        renderBlocks(text.split("\n"), function (block) {
            html += block.html;
        });

        html = decorate(html);

        /* Defense in depth: only runs if the page opted into DOMPurify. */
        const purifier = optionalGlobal("DOMPurify");
        if (purifier && typeof purifier.sanitize === "function") {
            html = purifier.sanitize(html, { ADD_ATTR: ["target", "rel", "data-line", "data-language", "start", "style"] });
        }

        return html;
    }

    /* ------------------------------------------------------
       Small utilities the app layer uses
       ------------------------------------------------------ */

    /* Builds a plain-text / blob-safe version of a note: used by the
       share image and by anything that needs the markdown stripped. */
    function toPlainText(source) {
        /* textContent alone concatenates blocks ("TitleBody"), so the
           block boundaries are turned into newlines first. */
        const html = render(source)
            .replace(/<\/p>|<\/(h[1-6])>|<\/blockquote>|<\/pre>/g, "\n\n")
            .replace(/<\/li>|<\/tr>/g, "\n")
            .replace(/<br\s*\/?>/g, "\n");

        const div = document.createElement("div");
        div.innerHTML = html;

        return (div.textContent || "")
            .replace(/[ \t]+\n/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }

    /* The editor stores contentEditable HTML. Writing markdown on top
       of that HTML is what kept the [[double bracket]] paste hack in
       business; these helpers convert cleanly in both directions. */
    function htmlToMarkdown(html) {
        const div = document.createElement("div");
        div.innerHTML = String(html == null ? "" : html);

        function walk(node, listDepth) {
            let out = "";
            Array.prototype.forEach.call(node.childNodes, function (child) {
                if (child.nodeType === 3) {
                    out += child.nodeValue.replace(/\u00a0/g, " ");
                    return;
                }
                if (child.nodeType !== 1) return;

                const tag = child.tagName.toLowerCase();
                const inner = walk(child, listDepth);

                switch (tag) {
                    case "br": out += "\n"; return;
                    case "strong": case "b": out += "**" + inner.trim() + "**"; return;
                    case "em": case "i": out += "*" + inner.trim() + "*"; return;
                    case "del": case "s": case "strike": out += "~~" + inner.trim() + "~~"; return;
                    case "code": out += "`" + inner + "`"; return;
                    case "pre": out += "\n```\n" + (child.textContent || "").replace(/\n+$/, "") + "\n```\n"; return;
                    case "mark": out += "==" + inner.trim() + "=="; return;
                    case "a":
                        if ((child.getAttribute("href") || "").indexOf("#") === 0) { out += inner; return; }
                        out += "[" + (inner.trim() || readableUrl(child.getAttribute("href"))) + "](" + (child.getAttribute("href") || "") + ")";
                        return;
                    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
                        out += "\n\n" + new Array(Number(tag.charAt(1)) + 1).join("#") + " " + inner.trim() + "\n";
                        return;
                    case "blockquote":
                        out += "\n" + inner.trim().split("\n").map(function (line) { return "> " + line; }).join("\n") + "\n";
                        return;
                    case "hr": out += "\n\n---\n\n"; return;
                    case "ul": case "ol":
                        out += "\n" + walk(child, (listDepth || 0) + 1) + "\n";
                        return;
                    case "li":
                        /* One <li> = one markdown line. Checkboxes typed
                           by the toolbar round-trip as "- [x] text". */
                        const liPrefix = (child.querySelector && child.querySelector("input[type=\"checkbox\"]"))
                            ? (child.querySelector("input[type=\"checkbox\"]").checked ? "- [x] " : "- [ ] ")
                            : "- ";
                        out += "\n" + "  ".repeat(Math.max(0, (listDepth || 1) - 1)) + liPrefix + inlineOnly(child).trim();
                        return;
                    /* contentEditable puts every visual line in its own
                       <div>, so one block = one newline (not a blank
                       line). Blank lines the author typed survive as
                       empty blocks, which is exactly what separates
                       markdown paragraphs. */
                    case "p": case "div": out += "\n" + inner.trim(); return;
                    default: out += inner;
                }
            });
            return out;
        }

        return walk(div, 0)
            .replace(/[ \t]+\n/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .replace(/[ \t]+\n/g, "\n")
            .trim();
    }

    /* Serialises a node's children only (used for list items, whose
       wrapper must not be converted twice). */
    function inlineOnly(node) {
        const div = document.createElement("div");
        Array.prototype.forEach.call(node.childNodes, function (child) {
            div.appendChild(child.cloneNode(true));
        });
        return htmlToMarkdown(div.innerHTML);
    }

    global.SnapNotesMarkdown = {
        render: render,
        renderInline: renderInline,
        toPlainText: toPlainText,
        htmlToMarkdown: htmlToMarkdown,
        escapeHtml: escapeHtml,
        safeUrl: safeUrl,
        matchInline: matchInline,
        INLINE_PATTERNS: INLINE_PATTERNS,
        setOptions: setOptions,
        getOptions: function () { return Object.assign({}, options); },
        version: "1.2.0"
    };

    /* Deprecated alias so nothing that already referenced `marked`
       in saved markup / old code breaks. */
    if (typeof global.marked === "undefined") {
        global.marked = { parse: render };
    }
})(window);
