/**
 * Redraws the official CSPC letterhead + report title/subtitle/period on every
 * page of an html2pdf-generated PDF.
 *
 * html2canvas/html2pdf render the source element as one continuous image and
 * slice it into pages — CSS `position: fixed` does NOT repeat per page the way
 * it would in a native browser print, so the in-flow header (views/layout/
 * report-header.ejs + the report's own title/subtitle/period markup) only ever
 * shows once, wherever it happens to land in that image.
 *
 * The fix: hide the in-flow header elements before capture (so they don't get
 * captured at all), reserve a matching blank top margin on every page via
 * html2pdf's own `margin` option, generate the PDF as usual, then use jsPDF's
 * page API (pdf.setPage / pdf.text / pdf.line / pdf.addImage — exposed via
 * html2pdf's `.toPdf().get('pdf')` hook) to draw the header into that reserved
 * space on every page before saving. This is the "page events/hooks" approach,
 * not a CSS-only fake — html2canvas has no reliable repeating-header feature.
 *
 * The official Effectivity / Rev. / Page footer has exactly the same problem
 * and is solved the same way (see drawFooter and the `footer` option). In the
 * markup it is an ordinary in-flow <div> that lands wherever the content
 * happens to end — halfway up the last sheet, or stranded mid-document on a
 * page of its own — and its page label was a string typed into the template
 * ("Page 1 of 3"), which stopped being true the moment a long comments table
 * spilled onto a fourth page. Drawing it per page from jsPDF puts it at the
 * bottom edge of every sheet and lets it count the pages the PDF actually has.
 */
(function (global) {
    function loadLogoDataUrl(root) {
        return new Promise((resolve) => {
            const img = (root || document).querySelector('.report-logo');
            if (!img) return resolve(null);
            const draw = () => {
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = img.naturalWidth || 100;
                    canvas.height = img.naturalHeight || 100;
                    canvas.getContext('2d').drawImage(img, 0, 0);
                    resolve(canvas.toDataURL('image/png'));
                } catch (e) { resolve(null); }
            };
            if (img.complete && img.naturalWidth) draw();
            else { img.addEventListener('load', draw); img.addEventListener('error', () => resolve(null)); }
        });
    }

    // Draws one page's letterhead + report identity block, matching
    // views/layout/report-header.ejs's layout (logo+institution left, blue
    // rule below, form code on the rule when applicable, then the report's
    // own centered title/subtitle/period underneath).
    function drawHeader(pdf, logoDataUrl, header) {
        const pageWidth = pdf.internal.pageSize.getWidth();
        const left = 0.5;
        const right = pageWidth - 0.5;
        let y = 0.45;

        if (logoDataUrl) {
            try { pdf.addImage(logoDataUrl, 'PNG', left, y - 0.06, 0.5, 0.5); } catch (e) { /* logo optional */ }
        }
        const textLeft = left + 0.68;
        pdf.setTextColor(0, 0, 0);
        pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9);
        pdf.text('Republic of the Philippines', textLeft, y);
        pdf.setFont('helvetica', 'bold'); pdf.setFontSize(10.5);
        pdf.text('CAMARINES SUR POLYTECHNIC COLLEGES', textLeft, y + 0.17);
        pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9);
        pdf.text('Nabua, Camarines Sur', textLeft, y + 0.32);

        y += 0.48;
        const docCodeW = header.docCode ? (pdf.getStringUnitWidth(header.docCode) * 8) / 72 + 0.08 : 0;
        pdf.setDrawColor(30, 136, 229);
        pdf.setLineWidth(0.025);
        pdf.line(left, y, right - docCodeW, y);
        if (header.docCode) {
            pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8);
            pdf.text(header.docCode, right, y + 0.02, { align: 'right' });
        }

        y += 0.24;
        const centerX = pageWidth / 2;
        const maxTextWidth = pageWidth - 1.3;

        if (header.title) {
            pdf.setFont('helvetica', 'bold'); pdf.setFontSize(11.5);
            const lines = pdf.splitTextToSize(header.title, maxTextWidth);
            lines.forEach((line) => { pdf.text(line, centerX, y, { align: 'center' }); y += 0.17; });
            if (header.subtitleUnderline) y += 0.08;
        }
        if (header.subtitle) {
            pdf.setFont('helvetica', 'bold'); pdf.setFontSize(10.5);
            const lines = pdf.splitTextToSize(String(header.subtitle).toUpperCase(), maxTextWidth);
            lines.forEach((line) => {
                pdf.text(line, centerX, y, { align: 'center' });
                // Underlined, like the SQD report's office name on the original
                // printed report — jsPDF has no text-decoration, so the rule is
                // drawn under each line. Only when the caller asks for it
                // (subtitleUnderline) — the PER CLUSTER report's "PER CLUSTER"
                // subtitle is not underlined in its original template.
                if (header.subtitleUnderline) {
                    const w = (pdf.getStringUnitWidth(line) * 10.5) / 72;
                    pdf.setDrawColor(0, 0, 0); pdf.setLineWidth(0.008);
                    pdf.line(centerX - w / 2, y + 0.025, centerX + w / 2, y + 0.025);
                }
                y += 0.19;
            });
        }
        if (header.serviceLine) {
            pdf.setFont('helvetica', 'italic'); pdf.setFontSize(9.5);
            const lines = pdf.splitTextToSize(header.serviceLine, maxTextWidth);
            lines.forEach((line) => { pdf.text(line, centerX, y, { align: 'center' }); y += 0.16; });
        }

        if (header.metaLines && header.metaLines.length) {
            y += 0.12;
            // Left-aligned label/value column, like the original printed report —
            // not centered text like the report title/office name above it.
            pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9.5);
            const labelX = left;
            const valueX = left + 1.9;
            header.metaLines.forEach((row) => {
                pdf.text(row.label, labelX, y);
                pdf.setFont('helvetica', 'bold');
                pdf.text(String(row.value), valueX, y);
                pdf.setFont('helvetica', 'normal');
                y += 0.17;
            });
        } else {
            if (header.period) {
                y += 0.09;
                pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9.5);
                pdf.text(header.period, centerX, y, { align: 'center' });
                y += 0.15;
            }
            if (header.meta) {
                pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9);
                pdf.text(header.meta, centerX, y, { align: 'center' });
            }
        }
    }

    // Draws a translucent, diagonal caution watermark across one page — used
    // to flag a downloaded SQD scorecard whose respondent count hasn't yet
    // reached the office's reporting minimum, so a reader can't mistake an
    // early/partial count for a finished result. jsPDF's GState (present in
    // the jsPDF build html2pdf.js 0.10.1 bundles) gives true transparency; if
    // a future bundle lacks it, the text still draws, just fully opaque,
    // rather than throwing and losing the rest of the page.
    function drawWatermark(pdf, text) {
        const pageWidth = pdf.internal.pageSize.getWidth();
        const pageHeight = pdf.internal.pageSize.getHeight();
        const hasGState = typeof pdf.GState === 'function' && typeof pdf.setGState === 'function';
        if (hasGState) {
            try { pdf.setGState(new pdf.GState({ opacity: 0.16 })); } catch (e) { /* draw opaque */ }
        }
        pdf.setTextColor(200, 30, 30);
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(34);
        pdf.text(text, pageWidth / 2, pageHeight / 2, { align: 'center', angle: 45 });
        if (hasGState) {
            try { pdf.setGState(new pdf.GState({ opacity: 1 })); } catch (e) { /* already opaque */ }
        }
        pdf.setTextColor(0, 0, 0);
    }

    // Draws the official CQA document footer — Effectivity date, revision
    // number, and the page label — pinned to the bottom edge of ONE page,
    // matching views/layout/report-footer.ejs (same three cells, same blue rule
    // above them, same left/centre/right spread).
    //
    // `totalPages` is the PDF's real page count, so "Page 2 of 5" is what the
    // document actually is rather than what the template guessed it would be.
    function drawFooter(pdf, footer, pageNum, totalPages) {
        const pageWidth = pdf.internal.pageSize.getWidth();
        const pageHeight = pdf.internal.pageSize.getHeight();
        const left = 0.5;
        const right = pageWidth - 0.5;
        // Measured up from the bottom edge, never down from the content: that
        // is the whole point — the footer sits on the same line on every
        // sheet whether the page above it is full or a third full.
        const ruleY = pageHeight - 0.42;
        const textY = ruleY + 0.15;

        pdf.setDrawColor(108, 155, 210);
        pdf.setLineWidth(0.02);
        pdf.line(left, ruleY, right, ruleY);

        pdf.setTextColor(0, 0, 0);
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(8);
        pdf.text('Effectivity: ' + (footer.effectivity || 'June 2024'), left, textY);
        pdf.text(footer.revision || 'Rev. 4', pageWidth / 2, textY, { align: 'center' });
        pdf.text('Page ' + pageNum + ' of ' + totalPages, right, textY, { align: 'right' });
    }

    // Draws a repeating data-table column header row (e.g. NO. | NAME OF OFFICE |
    // OVERALL SCORE | INTERPRETATION) directly below the report header, since
    // html2canvas screenshots the content as one flat image and slices it into
    // pages — a real `<thead>` never gets a chance to repeat itself the way it
    // would under a genuine paginating print engine. `columns` is
    // [{ label, widthPct, align }], widthPct fractions of the printable width.
    function drawColumnHeader(pdf, startY, columns) {
        const pageWidth = pdf.internal.pageSize.getWidth();
        const left = 0.5, right = pageWidth - 0.5;
        const usableWidth = right - left;
        const rowHeight = 0.24;

        // #8faadc — matches .cluster-report-table th and the SQD report's own
        // .header-blue, so both official report tables read as one template.
        pdf.setFillColor(143, 170, 220);
        pdf.rect(left, startY, usableWidth, rowHeight, 'F');
        pdf.setDrawColor(0, 0, 0);
        pdf.setLineWidth(0.01);
        pdf.rect(left, startY, usableWidth, rowHeight);

        pdf.setFont('helvetica', 'bold'); pdf.setFontSize(9);
        pdf.setTextColor(255, 255, 255);
        let x = left;
        columns.forEach((col, i) => {
            const w = usableWidth * col.widthPct;
            if (i > 0) { pdf.setDrawColor(0, 0, 0); pdf.line(x, startY, x, startY + rowHeight); }
            const textX = col.align === 'left' ? x + 0.06 : x + w / 2;
            pdf.text(col.label, textX, startY + rowHeight / 2 + 0.03, { align: col.align === 'left' ? 'left' : 'center' });
            x += w;
        });
        pdf.setTextColor(0, 0, 0);
        return startY + rowHeight;
    }

    // A block's distance from `element`'s top edge, in real layout pixels.
    // getBoundingClientRect() is used instead of walking the offsetParent
    // chain (summing offsetTop node by node) because that walk silently
    // produces a wrong, much larger number whenever some ancestor between
    // `block` and `element` never becomes anyone's offsetParent (e.g. a plain
    // `position: static` element with no layout context of its own) — the
    // loop then never hits `element === node` and keeps climbing past it,
    // picking up unrelated page chrome above it. Two viewport-relative
    // rectangles avoid that entirely regardless of the DOM's positioning.
    function topWithinElement(element, block) {
        return block.getBoundingClientRect().top - element.getBoundingClientRect().top;
    }

    // html2pdf's own page-break-avoidance (CSS `break-inside: avoid` /
    // the `pagebreak.avoid` selector list) is screenshot-based and has proven
    // unreliable for a CSS Grid block sitting near a page boundary — it can
    // start rendering the block on the current page and then simply stop
    // instead of pushing the whole thing onto a fresh page, silently losing
    // content. This computes, in real layout pixels, whether `selector`'s
    // element would cross a page boundary and — only if it actually would —
    // inserts a spacer immediately before it so it starts cleanly at the top
    // of the next page instead. Returns the inserted spacer (or null) so the
    // caller can remove it again afterward.
    function pushBelowPageBreakIfNeeded(element, selector, pageContentHeightIn, marginLeftIn, marginRightIn) {
        const block = element.querySelector(selector);
        if (!block) return null;

        const availableWidthIn = 8.5 - marginLeftIn - marginRightIn;
        const pxPerIn = element.offsetWidth / availableWidthIn;
        const pageContentHeightPx = pageContentHeightIn * pxPerIn;

        const top = topWithinElement(element, block);
        const bottom = top + block.offsetHeight;

        const pageIndex = Math.floor(top / pageContentHeightPx);
        const boundary = (pageIndex + 1) * pageContentHeightPx;
        if (bottom <= boundary) return null; // already fits on its current page

        const spacer = document.createElement('div');
        spacer.style.height = Math.ceil(boundary - top) + 4 + 'px';
        block.parentNode.insertBefore(spacer, block);
        return spacer;
    }

    // Unconditionally pushes `selector`'s element down to the exact start of
    // the next page, regardless of whether it would otherwise fit where it is.
    // This exists to replace html2pdf's own CSS `page-break-before: always`
    // handling (the `.page-break` class, under `pagebreak.mode: ['css', ...]`)
    // for multi-section documents (respondents breakdown → SQD scorecard → AI
    // Feedback), which was observed to duplicate a section's tail content
    // (e.g. its signature block rendering once alone on an otherwise blank
    // page, then again with the rest of that section's content on the page
    // after) rather than cleanly starting it fresh — the two mechanisms
    // (html2pdf's own CSS-driven break and this module's pixel-measured one)
    // don't agree on where a page boundary actually falls once any earlier
    // section's height varies from whatever html2pdf assumed. Doing every
    // forced break this same pixel-measured way, and none of them through
    // html2pdf's CSS mode, keeps exactly one mechanism deciding page
    // boundaries — see the `forcePageBreakSelectors` option below.
    function forceStartOnFreshPage(element, selector, pageContentHeightPx) {
        const block = element.querySelector(selector);
        if (!block || block.offsetParent === null) return null;

        const top = topWithinElement(element, block);
        const remainder = top % pageContentHeightPx;
        if (remainder < 1) return null; // already sitting right at a page boundary

        const spacer = document.createElement('div');
        spacer.style.height = Math.ceil(pageContentHeightPx - remainder) + 'px';
        block.parentNode.insertBefore(spacer, block);
        return spacer;
    }

    // Assigns each of `sections`' elements (given in document order) a run of
    // physical PDF pages. Returns { key: { start, end } } (1-indexed, `end` is
    // Infinity for the last present section).
    //
    // Reads each section's OWN real, final position (topWithinElement) instead
    // of re-deriving where it must have landed by stacking earlier sections'
    // measured heights. The two used to disagree: every section after the
    // first is a forcePageBreakSelectors target, already pushed by
    // forceStartOnFreshPage to sit at an exact page boundary — but that push
    // is computed from the earlier section's real layout position, which
    // includes things a plain `getBoundingClientRect().height` never sees,
    // such as a margin-bottom on the section's own container. Stacking
    // heights alone silently dropped that margin, so it could compute one
    // page fewer than the forced spacer actually produced — e.g. call the
    // first section done in 1 page when the real forced position already
    // reflects it running into a 2nd — leaving the header/footer/watermark
    // for every section after it drawn one page off from where its content
    // genuinely landed (a stray page reading as the previous section's
    // header with nothing on it, and that section's real content appearing
    // under the NEXT section's header instead). Reading the true post-push
    // position directly can't drift out of sync with itself this way.
    function computeSectionRanges(element, sections, pageContentHeightIn, marginLeftIn, marginRightIn) {
        const availableWidthIn = 8.5 - marginLeftIn - marginRightIn;
        const pxPerIn = element.offsetWidth / availableWidthIn;
        const pageContentHeightPx = pageContentHeightIn * pxPerIn;

        // A section hidden via display:none (e.g. the scorecard/AI Feedback
        // parts when only "Number of Respondents" was requested, or the
        // respondents-breakdown signature hidden for capture during a full
        // packet) contributes no pages at all — it's simply left out.
        const present = sections
            .map((s) => ({ key: s.key, block: element.querySelector(s.selector) }))
            .filter((s) => s.block && s.block.offsetParent !== null);

        const ranges = {};
        present.forEach((s) => {
            const top = topWithinElement(element, s.block);
            // The very first section always opens the document at top: 0, i.e.
            // page 1 — trivially a boundary. Every section after it is a
            // forcePageBreakSelectors target already sitting at an exact page
            // boundary, so this recovers which one directly instead of assuming.
            ranges[s.key] = { start: Math.round(top / pageContentHeightPx) + 1 };
        });
        present.forEach((s, i) => {
            ranges[s.key].end = (i + 1 < present.length) ? ranges[present[i + 1].key].start - 1 : Infinity;
        });
        return ranges;
    }

    /**
     * @param {string} elementId - id of the element passed to html2pdf().from()
     * @param {string} filename
     * @param {object} opt - the html2pdf opt object (margin/image/html2canvas/jsPDF/pagebreak).
     *   opt.margin[0] (top) is overridden with headerHeightIn so content never
     *   renders under the redrawn header, on every page.
     * @param {number} headerHeightIn - blank space (inches) reserved at the top
     *   of every page for the redrawn header (and column header row, if given).
     *   Size generously for the longest title/subtitle this report can show
     *   (e.g. a wrapped long office name).
     * @param {string[]} headerHideSelectors - CSS selectors, relative to the
     *   element, whose matches are hidden during capture (the in-flow header
     *   markup that's being replaced by the redrawn one) and restored after.
     * @param {(pageNum: number, totalPages: number) => {title, subtitle, period, meta, docCode}} [getHeaderForPage] -
     *   required unless `sections` is given instead.
     * @param {{key: string, selector: string, header: object}[]} [sections] -
     *   alternative to `getHeaderForPage` for a document made of several
     *   in-order parts (e.g. respondents breakdown, then scorecard, then AI
     *   Feedback) whose page count each can vary. Each part's actual starting
     *   page is measured from `selector`'s real position (see
     *   computeSectionRanges) instead of assumed, so the right header/footer/
     *   watermark still land on the right pages even if an earlier part grows
     *   or shrinks. `footer.section` / `watermark.section` (a `key` from this
     *   list) restrict those to that part's measured page range.
     * @param {{columns: {label,widthPct,align}[], startYIn: number}} [columnHeader] -
     *   optional repeating data-table column header, drawn at a fixed Y on every
     *   page right below the report header (its own real `<thead>` should be
     *   hidden via headerHideSelectors so it isn't captured twice).
     * @param {string[]} [forcePageBreakSelectors] - CSS selectors, in document
     *   order, each pushed to start at the exact top of a fresh physical page.
     *   Use this instead of the `.page-break` CSS class + `pagebreak.mode:
     *   ['css', ...]` for a multi-section document (see `sections`) — that
     *   combination was observed to duplicate content (a section's tail
     *   rendering once alone on an otherwise blank page, then again in full on
     *   the page after) once an earlier section's height no longer matches
     *   what html2pdf assumed when it decided where to break. This measures
     *   real layout pixels instead and is the only thing deciding page breaks
     *   for these transitions — `opt.pagebreak.mode` should be `['legacy']`
     *   only when this is used, not `['css', 'legacy']`, so the two mechanisms
     *   can't disagree.
     * @param {string|string[]} [avoidSplitSelector] - one CSS selector, or
     *   several, each naming one block (e.g. a signature section) that must
     *   never be split across pages — see pushBelowPageBreakIfNeeded above.
     *   Prefer this over html2pdf's own `pagebreak.avoid` CSS list for a block
     *   near a page boundary: that mechanism has proven unreliable here,
     *   observed to duplicate the block (render it once where it would have
     *   split, and again pushed whole onto the next page) rather than cleanly
     *   moving it — this measures real layout pixels and moves it itself.
     * @param {{effectivity?: string, revision?: string, heightIn?: number, onPages?: (pageNum: number, totalPages: number) => boolean, section?: string}} [footer] -
     *   pass this to print the official Effectivity / Rev. / Page footer along
     *   the bottom edge of every page, or only the pages `onPages` returns true
     *   for, or only the measured page range of `section` (see `sections`
     *   above) — e.g. the SQD scorecard part only, not the respondents
     *   breakdown or AI Feedback parts sharing the same download. Omitting
     *   both restricts it draws on every page. The in-flow `.page-footer`
     *   markup is hidden during capture so it is not printed twice, and the
     *   bottom margin is widened to `heightIn` so content can never run
     *   underneath it.
     * @param {{text: string, onPages?: (pageNum: number, totalPages: number) => boolean, section?: string, rowSelector?: string}} [watermark] -
     *   pass this to stamp a translucent diagonal caution watermark (e.g. "INSUFFICIENT
     *   RESPONDENTS") on every page, or only `onPages`/`section` pages as with `footer`.
     *   `rowSelector` is for a multi-office table (Per Cluster / Overall Cluster /
     *   Summary of Respondents report): it stamps only the pages that actually
     *   contain a matching row (e.g. `.office-insufficient`, an office below the
     *   reporting minimum) instead of every page or a whole section, since a
     *   single page can otherwise mix offices above and below the threshold. Takes
     *   priority over `section`/`onPages` when given. The caller decides
     *   `text`/whether to pass `watermark` at all based on its own respondent-count
     *   threshold — this module only draws it.
     */
    async function exportRepeatingHeaderPdf({ elementId, filename, opt, headerHeightIn, headerHideSelectors, getHeaderForPage, sections, columnHeader, avoidSplitSelector, forcePageBreakSelectors, footer, watermark }) {
        const element = document.getElementById(elementId);
        if (!element) return;

        const logoDataUrl = await loadLogoDataUrl(element);

        // The band the footer occupies has to be kept clear on every page, not
        // just the last one, so it is taken out of the printable area the same
        // way the header's is — as a real margin html2pdf paginates against.
        // Without this the footer would be drawn ON TOP of whatever table row
        // happened to reach the bottom of that page.
        const footerHeightIn = footer ? (footer.heightIn || 0.55) : 0;
        const bottomMarginIn = Math.max(opt.margin[2], footerHeightIn);

        const pageContentHeightIn = 11 - headerHeightIn - bottomMarginIn;
        const availableWidthIn = 8.5 - opt.margin[1] - opt.margin[3];

        // html2pdf.js never screenshots `element` at whatever width it happens to
        // be on screen. Its own toContainer() step clones the source into a
        // hidden, off-document container it hard-sets to `pageSize.inner.width`
        // (this same availableWidthIn, at 96 CSS px/in) and lets it reflow there
        // — `height: auto` — before html2canvas ever runs. So the real page
        // breaks always land according to THAT narrower reflow, never according
        // to the wide on-screen layout (which can be 1200px+ in a normal browser
        // window, versus ~750px of actual printable width). Measuring spacer
        // placement against the live, on-screen `element` was therefore checking
        // the wrong layout: text wraps differently at ~750px than it does at
        // full window width, so every height/position read off the live element
        // silently disagreed with how tall that content would really be once
        // html2pdf reflowed it — which is exactly what let the SQD scorecard's
        // signature block drift past where this module assumed the page break
        // was, spilling onto a stray extra page instead of landing where the
        // math below expects.
        //
        // The fix: do the entire measure-and-space pipeline (forcePageBreak,
        // avoid-split, section ranges) against our OWN detached, off-screen
        // clone that is force-width'ed to this same availableWidthIn up front —
        // so every measurement already reflects the narrow reflow html2pdf is
        // going to use — then hand that already-corrected clone to html2pdf
        // instead of the live element.
        //
        // The off-screen positioning goes on a plain WRAPPER around the clone,
        // not on the clone itself: html2pdf.from(measureRoot) clones measureRoot
        // AGAIN internally and reparents that inner clone into its own overlay,
        // carrying over any inline style measureRoot has — a `position: fixed`
        // on measureRoot itself was found (via a real capture) to travel along
        // into that inner clone and escape html2pdf's overlay/container
        // entirely, capturing as a blank page. Keeping measureRoot itself at
        // its normal static position and moving only the wrapper off-screen
        // avoids that, while still never being shown to the user; both are
        // torn down again in `finally` below regardless of outcome.
        const measureRoot = element.cloneNode(true);
        measureRoot.style.width = availableWidthIn + 'in';
        measureRoot.style.margin = '0';
        const measureWrapper = document.createElement('div');
        measureWrapper.style.position = 'fixed';
        measureWrapper.style.top = '0';
        measureWrapper.style.left = '-100000px';
        measureWrapper.appendChild(measureRoot);
        document.body.appendChild(measureWrapper);

        // Each `.report-container` (one per physical report page — respondents
        // breakdown, SQD scorecard, AI Feedback, ...) carries an inline
        // margin-bottom purely so the on-screen preview shows visible daylight
        // between pages stacked in one scrolling column. In the actual PDF that
        // gap is pure waste: a forced page break already puts these on separate
        // sheets, so the gap does nothing but add dead space above the next
        // one — and when a page's real content already comes within that gap's
        // width of a page boundary (a common, unremarkable amount of content,
        // not a near-miss edge case), that dead space is what tips the next
        // section's measured position just past the boundary, so
        // forceStartOnFreshPage rounds it up to the page AFTER the one it
        // should have started on — wasting an entire blank page for every
        // report this happens to. Zeroed here, on the measurement/capture
        // clone only, so the live on-screen preview keeps its visual spacing.
        measureRoot.querySelectorAll('.report-container').forEach((el) => { el.style.marginBottom = '0'; });

        // `.page-footer` is added unconditionally when a footer is being drawn:
        // the in-flow copy is the one that lands in the middle of a sheet, and
        // leaving it visible would print it twice — once adrift in the content,
        // once correctly along the bottom edge. Applied to the clone only — the
        // live page never needs to be touched (or restored) at all now.
        const hideSelectors = (headerHideSelectors || []).concat(footer ? ['.page-footer'] : []);
        hideSelectors.forEach((sel) => {
            measureRoot.querySelectorAll(sel).forEach((el) => { el.style.display = 'none'; });
        });

        const pxPerIn = measureRoot.offsetWidth / availableWidthIn;
        const pageContentHeightPx = pageContentHeightIn * pxPerIn;

        // Applied FIRST, in document order, before anything else is measured:
        // each of these selectors' elements (e.g. the SQD scorecard container,
        // then the AI Feedback container) is pushed to start at an exact page
        // boundary. Everything that follows — the avoid-split spacers below and
        // computeSectionRanges — assumes page boundaries fall at clean multiples
        // of pageContentHeightPx, which is only actually true once every forced
        // section start has been aligned this way; doing it here, ahead of
        // those, is what makes that assumption hold.
        (forcePageBreakSelectors || []).forEach((sel) => {
            forceStartOnFreshPage(measureRoot, sel, pageContentHeightPx);
        });

        // Accepts one selector or several (e.g. the SQD scorecard's signature
        // grid AND the AI Feedback page's separate signature block both need
        // this same protection in the same document) — applied in order, each
        // one's own spacer inserted before the next is measured, so a spacer
        // for an earlier block can't throw off where a later block appears to
        // sit relative to it.
        (avoidSplitSelector ? [].concat(avoidSplitSelector) : []).forEach((sel) => {
            pushBelowPageBreakIfNeeded(measureRoot, sel, pageContentHeightIn, opt.margin[1], opt.margin[3]);
        });

        // Measured after the spacer above (if any) so a section pushed onto a
        // fresh page by it is measured at its real, final position rather than
        // the position it would have had before that push.
        const sectionRanges = (sections && sections.length)
            ? computeSectionRanges(measureRoot, sections, pageContentHeightIn, opt.margin[1], opt.margin[3])
            : null;
        const sectionForPage = (pageNum) => {
            if (!sectionRanges) return null;
            for (const key in sectionRanges) {
                const r = sectionRanges[key];
                if (pageNum >= r.start && pageNum <= r.end) return key;
            }
            // The only way to reach here is a page number smaller than every
            // section's measured start (the last section's range always ends
            // at Infinity, so nothing after it is ever unmatched) — pick the
            // section that starts earliest, i.e. whichever one actually opens
            // the document, rather than the one that happens to iterate last.
            let firstKey = null, firstStart = Infinity;
            for (const key in sectionRanges) { if (sectionRanges[key].start < firstStart) { firstStart = sectionRanges[key].start; firstKey = key; } }
            return firstKey;
        };
        // Which physical pages actually contain a `watermark.rowSelector` match,
        // read the same way computeSectionRanges reads a section's start — real,
        // final position in the already-paginated clone — rather than assumed
        // from the untouched offsets forceStartOnFreshPage's spacers would throw
        // off if measured before them.
        const watermarkPages = (watermark && watermark.rowSelector)
            ? new Set(Array.from(measureRoot.querySelectorAll(watermark.rowSelector)).map((el) =>
                Math.floor(topWithinElement(measureRoot, el) / pageContentHeightPx) + 1
            ))
            : null;

        const resolvedGetHeaderForPage = sections
            ? (pageNum) => {
                const key = sectionForPage(pageNum);
                const match = sections.find((s) => s.key === key);
                return match ? match.header : {};
            }
            : getHeaderForPage;

        const finalOpt = Object.assign({}, opt, {
            margin: [headerHeightIn, opt.margin[1], bottomMarginIn, opt.margin[3]]
        });

        try {
            const worker = global.html2pdf().set(finalOpt).from(measureRoot).toPdf();
            const pdf = await worker.get('pdf');
            const totalPages = pdf.internal.getNumberOfPages();
            for (let page = 1; page <= totalPages; page++) {
                pdf.setPage(page);
                drawHeader(pdf, logoDataUrl, resolvedGetHeaderForPage(page, totalPages) || {});
                if (columnHeader) drawColumnHeader(pdf, columnHeader.startYIn, columnHeader.columns);
                const footerShows = footer && (
                    footer.section && sectionRanges ? sectionForPage(page) === footer.section :
                    footer.onPages ? footer.onPages(page, totalPages) :
                    true
                );
                if (footerShows) drawFooter(pdf, footer, page, totalPages);
                const watermarkShows = watermark && watermark.text && (
                    watermarkPages ? watermarkPages.has(page) :
                    watermark.section && sectionRanges ? sectionForPage(page) === watermark.section :
                    watermark.onPages ? watermark.onPages(page, totalPages) :
                    true
                );
                if (watermarkShows) drawWatermark(pdf, watermark.text);
            }
            pdf.save(filename);
        } finally {
            if (measureWrapper.parentNode) measureWrapper.parentNode.removeChild(measureWrapper);
        }
    }

    global.exportRepeatingHeaderPdf = exportRepeatingHeaderPdf;
})(window);
