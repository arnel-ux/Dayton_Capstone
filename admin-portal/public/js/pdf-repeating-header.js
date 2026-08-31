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

        let top = 0;
        let node = block;
        while (node && node !== element) { top += node.offsetTop; node = node.offsetParent; }
        const bottom = top + block.offsetHeight;

        const pageIndex = Math.floor(top / pageContentHeightPx);
        const boundary = (pageIndex + 1) * pageContentHeightPx;
        if (bottom <= boundary) return null; // already fits on its current page

        const spacer = document.createElement('div');
        spacer.style.height = Math.ceil(boundary - top) + 4 + 'px';
        block.parentNode.insertBefore(spacer, block);
        return spacer;
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
     * @param {(pageNum: number, totalPages: number) => {title, subtitle, period, meta, docCode}} getHeaderForPage
     * @param {{columns: {label,widthPct,align}[], startYIn: number}} [columnHeader] -
     *   optional repeating data-table column header, drawn at a fixed Y on every
     *   page right below the report header (its own real `<thead>` should be
     *   hidden via headerHideSelectors so it isn't captured twice).
     * @param {string} [avoidSplitSelector] - optional CSS selector for one block
     *   (e.g. the signature/interpretation section) that must never be split
     *   across pages — see pushBelowPageBreakIfNeeded above.
     */
    async function exportRepeatingHeaderPdf({ elementId, filename, opt, headerHeightIn, headerHideSelectors, getHeaderForPage, columnHeader, avoidSplitSelector }) {
        const element = document.getElementById(elementId);
        if (!element) return;

        const logoDataUrl = await loadLogoDataUrl(element);

        const hidden = [];
        (headerHideSelectors || []).forEach((sel) => {
            element.querySelectorAll(sel).forEach((el) => {
                hidden.push([el, el.style.display]);
                el.style.display = 'none';
            });
        });

        let spacer = null;
        if (avoidSplitSelector) {
            const pageContentHeightIn = 11 - headerHeightIn - opt.margin[2];
            spacer = pushBelowPageBreakIfNeeded(element, avoidSplitSelector, pageContentHeightIn, opt.margin[1], opt.margin[3]);
        }

        const finalOpt = Object.assign({}, opt, {
            margin: [headerHeightIn, opt.margin[1], opt.margin[2], opt.margin[3]]
        });

        try {
            const worker = global.html2pdf().set(finalOpt).from(element).toPdf();
            const pdf = await worker.get('pdf');
            const totalPages = pdf.internal.getNumberOfPages();
            for (let page = 1; page <= totalPages; page++) {
                pdf.setPage(page);
                drawHeader(pdf, logoDataUrl, getHeaderForPage(page, totalPages) || {});
                if (columnHeader) drawColumnHeader(pdf, columnHeader.startYIn, columnHeader.columns);
            }
            pdf.save(filename);
        } finally {
            hidden.forEach(([el, display]) => { el.style.display = display; });
            if (spacer && spacer.parentNode) spacer.parentNode.removeChild(spacer);
        }
    }

    global.exportRepeatingHeaderPdf = exportRepeatingHeaderPdf;
})(window);
