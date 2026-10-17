const PDFJS_VERSION = "4.10.38";
const PDFJS_MODULE_URL = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.mjs`;
const PDFJS_WORKER_URL = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.mjs`;
let pdfJsModulePromise;

async function loadPdfJs() {
    if (window.__snapnotesPdfJsForTests) return window.__snapnotesPdfJsForTests;
    if (!pdfJsModulePromise) {
        pdfJsModulePromise = import(PDFJS_MODULE_URL).then(module => {
            module.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
            return module;
        }).catch(error => {
            pdfJsModulePromise = null;
            throw error;
        });
    }
    return pdfJsModulePromise;
}

function makeButton(label, text, disabled = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-label", label);
    button.textContent = text;
    button.disabled = disabled;
    return button;
}

function isCancellation(error) {
    return error?.name === "RenderingCancelledException" ||
        error?.name === "AbortException" ||
        /cancelled|canceled/i.test(error?.message || "");
}

function readablePdfError(error) {
    const message = String(error?.message || error || "");
    if (/password/i.test(message)) return "This PDF is password-protected. Download it and open it with a PDF reader.";
    if (/fetch|network|cors|range|failed to load|unexpected server response|worker/i.test(message)) {
        return "SnapNotes couldn't read this PDF from storage. The link may have expired, or storage CORS/range settings may be blocking the preview. Reopen the attachment and try again.";
    }
    if (/invalid pdf|missing pdf|format error|damaged|corrupt/i.test(message)) {
        return "This file doesn't appear to be a valid PDF or may be damaged. You can still download it.";
    }
    return "The PDF could not be rendered. Check your connection and try again, or use Download.";
}

export async function renderPdfPreview({ state, url, container, isCurrent, onError }) {
    const viewer = document.createElement("section");
    viewer.className = "pdfjs-viewer";
    viewer.setAttribute("aria-label", "PDF document viewer");

    const toolbar = document.createElement("div");
    toolbar.className = "pdfjs-toolbar";
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "PDF controls");

    const previous = makeButton("Previous PDF page", "Previous", true);
    const pageLabel = document.createElement("span");
    pageLabel.className = "pdfjs-page-label";
    pageLabel.setAttribute("aria-live", "polite");
    pageLabel.textContent = "Loading pages…";
    const next = makeButton("Next PDF page", "Next", true);
    const zoomOut = makeButton("Zoom out", "−", true);
    const zoomIn = makeButton("Zoom in", "+", true);
    const fitWidth = makeButton("Fit PDF to width", "Fit width", true);
    toolbar.append(previous, pageLabel, next, zoomOut, zoomIn, fitWidth);

    const stage = document.createElement("div");
    stage.className = "pdfjs-page-stage";
    stage.setAttribute("role", "region");
    stage.setAttribute("aria-label", "PDF page");
    const status = document.createElement("p");
    status.className = "pdfjs-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.textContent = "Loading PDF…";
    stage.appendChild(status);
    viewer.append(toolbar, stage);
    container.replaceChildren(viewer);

    try {
        const pdfjs = await loadPdfJs();
        if (!isCurrent(state)) return;

        // PDF.js can use HTTP byte ranges where the storage server supports them.
        // Only one page canvas is kept in the DOM at a time to bound canvas memory on mobile.
        const loadingTask = pdfjs.getDocument({
            url,
            rangeChunkSize: 64 * 1024,
            disableAutoFetch: true,
            disableStream: true
        });
        state.pdfLoadingTask = loadingTask;
        const pdf = await loadingTask.promise;
        if (!isCurrent(state)) {
            await loadingTask.destroy?.();
            return;
        }
        state.pdfDocument = pdf;
        state.pdfPageNumber = 1;
        state.pdfScale = 1;
        state.pdfRenderTask = null;
        state.pdfPageRenderId = 0;

        async function renderCurrentPage() {
            if (!isCurrent(state)) return;
            const renderId = ++state.pdfPageRenderId;
            if (state.pdfRenderTask) {
                const oldTask = state.pdfRenderTask;
                state.pdfRenderTask = null;
                try { oldTask.cancel(); } catch {}
                try { await oldTask.promise; } catch {}
            }
            if (!isCurrent(state) || renderId !== state.pdfPageRenderId) return;

            status.hidden = false;
            status.textContent = `Rendering page ${state.pdfPageNumber} of ${pdf.numPages}…`;
            stage.replaceChildren(status);
            previous.disabled = state.pdfPageNumber <= 1;
            next.disabled = state.pdfPageNumber >= pdf.numPages;
            zoomOut.disabled = state.pdfScale <= 0.5;
            zoomIn.disabled = state.pdfScale >= 2.5;
            fitWidth.disabled = false;
            pageLabel.textContent = `Page ${state.pdfPageNumber} of ${pdf.numPages}`;

            let page;
            try {
                page = await pdf.getPage(state.pdfPageNumber);
                if (!isCurrent(state) || renderId !== state.pdfPageRenderId) {
                    page.cleanup?.();
                    return;
                }
                const viewport = page.getViewport({ scale: state.pdfScale });
                const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
                const canvas = document.createElement("canvas");
                canvas.className = "pdfjs-canvas";
                canvas.setAttribute("role", "img");
                canvas.setAttribute("aria-label", `PDF page ${state.pdfPageNumber}`);
                canvas.width = Math.max(1, Math.floor(viewport.width * pixelRatio));
                canvas.height = Math.max(1, Math.floor(viewport.height * pixelRatio));
                canvas.style.width = `${viewport.width}px`;
                canvas.style.height = "auto";
                const context = canvas.getContext("2d", { alpha: false });
                if (!context) throw new Error("Canvas rendering is unavailable in this browser.");
                status.hidden = true;
                stage.replaceChildren(status, canvas);
                const renderTask = page.render({
                    canvasContext: context,
                    viewport,
                    transform: pixelRatio === 1 ? null : [pixelRatio, 0, 0, pixelRatio, 0, 0]
                });
                state.pdfRenderTask = renderTask;
                await renderTask.promise;
                if (!isCurrent(state) || renderId !== state.pdfPageRenderId) return;
                page.cleanup?.();
                state.pdfRenderTask = null;
                pageLabel.textContent = `Page ${state.pdfPageNumber} of ${pdf.numPages}`;
                previous.disabled = state.pdfPageNumber <= 1;
                next.disabled = state.pdfPageNumber >= pdf.numPages;
                zoomOut.disabled = state.pdfScale <= 0.5;
                zoomIn.disabled = state.pdfScale >= 2.5;
            } catch (error) {
                page?.cleanup?.();
                if (isCancellation(error) || !isCurrent(state) || renderId !== state.pdfPageRenderId) return;
                onError(readablePdfError(error));
            }
        }

        previous.addEventListener("click", () => {
            if (state.pdfPageNumber > 1) {
                state.pdfPageNumber--;
                void renderCurrentPage();
            }
        });
        next.addEventListener("click", () => {
            if (state.pdfPageNumber < pdf.numPages) {
                state.pdfPageNumber++;
                void renderCurrentPage();
            }
        });
        zoomOut.addEventListener("click", () => {
            state.pdfScale = Math.max(0.5, Math.round((state.pdfScale - 0.25) * 100) / 100);
            void renderCurrentPage();
        });
        zoomIn.addEventListener("click", () => {
            state.pdfScale = Math.min(2.5, Math.round((state.pdfScale + 0.25) * 100) / 100);
            void renderCurrentPage();
        });
        fitWidth.addEventListener("click", async () => {
            try {
                const page = await pdf.getPage(state.pdfPageNumber);
                if (!page || !isCurrent(state)) return;
                const naturalWidth = page.getViewport({ scale: 1 }).width;
                const availableWidth = Math.max(240, stage.clientWidth - 32);
                state.pdfScale = Math.min(2.5, Math.max(0.5, availableWidth / naturalWidth));
                page.cleanup?.();
                void renderCurrentPage();
            } catch (error) {
                if (isCurrent(state)) onError(readablePdfError(error));
            }
        });
        await renderCurrentPage();
    } catch (error) {
        if (isCurrent(state)) onError(readablePdfError(error));
    }
}

export function disposePdfPreview(state) {
    if (!state) return;
    if (state.pdfRenderTask) {
        try { state.pdfRenderTask.cancel(); } catch {}
        state.pdfRenderTask = null;
    }
    if (state.pdfLoadingTask?.destroy) {
        try { Promise.resolve(state.pdfLoadingTask.destroy()).catch(() => {}); } catch {}
        state.pdfLoadingTask = null;
    }
    if (state.pdfDocument?.destroy) {
        try { Promise.resolve(state.pdfDocument.destroy()).catch(() => {}); } catch {}
        state.pdfDocument = null;
    }
}
