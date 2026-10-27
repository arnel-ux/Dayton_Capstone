// Redraws the letterhead and report title on every page of the generated PDF using jsPDF.
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

    // Draws one page's letterhead and report title block.
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
                // Underlines the subtitle by drawing a line under it, since jsPDF has no text decoration.
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
            // Left aligned label/value column.
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

    // Draws a translucent diagonal caution watermark across one page. Falls back to opaque if GState is missing.
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
        // jsPDF's align:'center' is unreliable on rotated text, so anchor the baseline start by hand:
        // walk back half the text width along the 45deg direction, then drop half the cap height
        // perpendicular to it, so the glyphs' midpoint lands on the page center.
        const rad = Math.PI / 4;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const halfWidth = pdf.getTextWidth(text) / 2;
        const halfCap = (34 / 72) * 0.72 / 2;
        const startX = pageWidth / 2 - halfWidth * cos + halfCap * sin;
        const startY = pageHeight / 2 + halfWidth * sin + halfCap * cos;
        pdf.text(text, startX, startY, { angle: 45 });
        if (hasGState) {
            try { pdf.setGState(new pdf.GState({ opacity: 1 })); } catch (e) { /* already opaque */ }
        }
        pdf.setTextColor(0, 0, 0);
    }

    // Draws the document footer (effectivity date, revision, page number) at the bottom of one page.
    function drawFooter(pdf, footer, pageNum, totalPages) {
        const pageWidth = pdf.internal.pageSize.getWidth();
        const pageHeight = pdf.internal.pageSize.getHeight();
        const left = 0.5;
        const right = pageWidth - 0.5;
        // Measured up from the bottom edge so the footer lands on the same line on every page.
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

    // Draws a repeating column header row below the report header. columns is [{ label, widthPct, align }].
    function drawColumnHeader(pdf, startY, columns) {
        const pageWidth = pdf.internal.pageSize.getWidth();
        const left = 0.5, right = pageWidth - 0.5;
        const usableWidth = right - left;
        const rowHeight = 0.24;

        // #8faadc matches the report table header color used elsewhere.
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

    // A block's distance from element's top edge, in real layout pixels.
    function topWithinElement(element, block) {
        return block.getBoundingClientRect().top - element.getBoundingClientRect().top;
    }

    // Inserts a spacer before selector's element if it would cross a page boundary, so it starts cleanly on the next page.
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
        if (bottom <= boundary) return null; // fits on its current page already

        const spacer = document.createElement('div');
        spacer.style.height = Math.ceil(boundary - top) + 4 + 'px';
        block.parentNode.insertBefore(spacer, block);
        return spacer;
    }

    // Forces selector's element to start at the top of the next page regardless of whether it would already fit.
    function forceStartOnFreshPage(element, selector, pageContentHeightPx) {
        const block = element.querySelector(selector);
        if (!block || block.offsetParent === null) return null;

        const top = topWithinElement(element, block);
        const remainder = top % pageContentHeightPx;
        if (remainder < 1) return null; // already sits right at a page boundary

        const spacer = document.createElement('div');
        spacer.style.height = Math.ceil(pageContentHeightPx - remainder) + 'px';
        block.parentNode.insertBefore(spacer, block);
        return spacer;
    }

    // Assigns each of `sections`' elements a run of physical PDF pages, based on each
    // section's real measured position. Returns { key: { start, end } }, 1-indexed, end is Infinity for the last section.
    function computeSectionRanges(element, sections, pageContentHeightIn, marginLeftIn, marginRightIn) {
        const availableWidthIn = 8.5 - marginLeftIn - marginRightIn;
        const pxPerIn = element.offsetWidth / availableWidthIn;
        const pageContentHeightPx = pageContentHeightIn * pxPerIn;

        // A section hidden via display:none contributes no pages and is left out.
        const present = sections
            .map((s) => ({ key: s.key, block: element.querySelector(s.selector) }))
            .filter((s) => s.block && s.block.offsetParent !== null);

        const ranges = {};
        present.forEach((s) => {
            const top = topWithinElement(element, s.block);
            // The first section always opens at page 1. Every section after it sits at an exact page boundary already.
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
     * @param {object} opt - the html2pdf opt object. margin[0] gets overridden with headerHeightIn.
     * @param {number} headerHeightIn - blank space in inches reserved at the top of every page for the header.
     * @param {string[]} headerHideSelectors - selectors hidden during capture and restored after.
     * @param {(pageNum: number, totalPages: number) => {title, subtitle, period, meta, docCode}} [getHeaderForPage] -
     *   required unless `sections` is given instead.
     * @param {{key: string, selector: string, header: object}[]} [sections] -
     *   alternative to getHeaderForPage for a document made of several parts whose page counts vary.
     * @param {{columns: {label,widthPct,align}[], startYIn: number}} [columnHeader] -
     *   optional repeating column header row drawn below the report header on every page.
     * @param {string[]} [forcePageBreakSelectors] - selectors pushed to start at the top of a fresh page.
     * @param {string|string[]} [avoidSplitSelector] - one or more selectors that must never split across pages.
     * @param {{effectivity?: string, revision?: string, heightIn?: number, onPages?: (pageNum: number, totalPages: number) => boolean, section?: string}} [footer] -
     *   prints the Effectivity/Rev/Page footer, optionally limited to onPages or a section's page range.
     * @param {{text: string, onPages?: (pageNum: number, totalPages: number) => boolean, section?: string, rowSelector?: string}} [watermark] -
     *   stamps a translucent diagonal watermark, optionally limited to onPages, a section, or pages matching rowSelector.
     */
    async function exportRepeatingHeaderPdf({ elementId, filename, opt, headerHeightIn, headerHideSelectors, getHeaderForPage, sections, columnHeader, avoidSplitSelector, forcePageBreakSelectors, footer, watermark }) {
        const element = document.getElementById(elementId);
        if (!element) return;

        const logoDataUrl = await loadLogoDataUrl(element);

        // Keeps the footer band clear on every page by treating it as a real margin html2pdf paginates against.
        const footerHeightIn = footer ? (footer.heightIn || 0.55) : 0;
        const bottomMarginIn = Math.max(opt.margin[2], footerHeightIn);

        const pageContentHeightIn = 11 - headerHeightIn - bottomMarginIn;
        const availableWidthIn = 8.5 - opt.margin[1] - opt.margin[3];

        // html2pdf reflows the element at its own narrower print width before capturing, so we measure and space
        // against a detached clone forced to that width, sitting inside an off screen wrapper.
        const measureRoot = element.cloneNode(true);
        measureRoot.style.width = availableWidthIn + 'in';
        measureRoot.style.margin = '0';
        const measureWrapper = document.createElement('div');
        measureWrapper.style.position = 'fixed';
        measureWrapper.style.top = '0';
        measureWrapper.style.left = '-100000px';
        measureWrapper.appendChild(measureRoot);
        document.body.appendChild(measureWrapper);

        // Zeroes out the on screen preview spacing between report containers on the clone only, so it doesn't
        // throw off page break measurements.
        measureRoot.querySelectorAll('.report-container').forEach((el) => { el.style.marginBottom = '0'; });

        // Hides the in-flow .page-footer on the clone when a footer is drawn, so it doesn't print twice.
        const hideSelectors = (headerHideSelectors || []).concat(footer ? ['.page-footer'] : []);
        hideSelectors.forEach((sel) => {
            measureRoot.querySelectorAll(sel).forEach((el) => { el.style.display = 'none'; });
        });

        const pxPerIn = measureRoot.offsetWidth / availableWidthIn;
        const pageContentHeightPx = pageContentHeightIn * pxPerIn;

        // Applied first, in document order, so every later measurement can assume page boundaries land
        // at clean multiples of pageContentHeightPx.
        (forcePageBreakSelectors || []).forEach((sel) => {
            forceStartOnFreshPage(measureRoot, sel, pageContentHeightPx);
        });

        // Accepts one selector or several, applied in order so each spacer is inserted before the next is measured.
        (avoidSplitSelector ? [].concat(avoidSplitSelector) : []).forEach((sel) => {
            pushBelowPageBreakIfNeeded(measureRoot, sel, pageContentHeightIn, opt.margin[1], opt.margin[3]);
        });

        // Measured after the spacer above so a pushed section is measured at its real, final position.
        const sectionRanges = (sections && sections.length)
            ? computeSectionRanges(measureRoot, sections, pageContentHeightIn, opt.margin[1], opt.margin[3])
            : null;
        const sectionForPage = (pageNum) => {
            if (!sectionRanges) return null;
            for (const key in sectionRanges) {
                const r = sectionRanges[key];
                if (pageNum >= r.start && pageNum <= r.end) return key;
            }
            // No range matched, so fall back to whichever section starts earliest.
            let firstKey = null, firstStart = Infinity;
            for (const key in sectionRanges) { if (sectionRanges[key].start < firstStart) { firstStart = sectionRanges[key].start; firstKey = key; } }
            return firstKey;
        };
        // Which physical pages actually contain a watermark.rowSelector match, read from the already paginated clone.
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
