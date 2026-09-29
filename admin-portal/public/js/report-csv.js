/**
 * Builds the CSV downloads shown next to each Download PDF button.
 * Builds the file from the report's data instead of scraping the tables, so each section keeps its own columns.
 */
(function (global) {
    // Excel and Sheets treat a leading =, +, - or @ as a formula, so those cells get an apostrophe prefix to stay text.
    function sanitizeCell(value) {
        const text = value === null || value === undefined ? '' : String(value);
        return /^[=+\-@\t\r]/.test(text) ? "'" + text : text;
    }

    // Formats one CSV field, flattening newlines and tabs to spaces and always quoting the value.
    function csvCell(value) {
        const text = sanitizeCell(value)
            .replace(/\r\n|\r|\n|\t/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim()
            .replace(/"/g, '""');
        return '"' + text + '"';
    }

    function csvRow(cells) {
        return (cells || []).map(csvCell).join(',');
    }

    // Builds the CSV text from a list of sections, each with an optional title, optional columns, and rows.
    function build(sections) {
        const lines = [];
        (sections || []).forEach((section, index) => {
            if (!section) return;
            if (index > 0) lines.push('');
            if (section.title) lines.push(csvRow([section.title]));
            if (section.columns && section.columns.length) lines.push(csvRow(section.columns));
            (section.rows || []).forEach(row => lines.push(csvRow(row)));
        });
        // Adds a UTF8 BOM so Excel on Windows reads accented characters correctly.
        return '﻿' + lines.join('\r\n') + '\r\n';
    }

    function download(filename, sections) {
        const blob = new Blob([build(sections)], { type: 'text/csv;charset=utf-8;' });
        const url = global.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.download = filename;
        link.href = url;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        // Removes the link and frees the blob URL now that the download started.
        document.body.removeChild(link);
        global.URL.revokeObjectURL(url);
    }

    // Reads a rendered tbody into rows of cell text, for tables filled in at runtime from the API.
    function rowsFromTbody(tbody) {
        if (!tbody) return [];
        return Array.from(tbody.querySelectorAll('tr')).map(tr =>
            Array.from(tr.querySelectorAll('td, th')).map(cell => cell.innerText)
        );
    }

    // Builds a timestamp for the filename so repeated exports don't overwrite each other.
    function stamp() {
        const d = new Date();
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
    }

    function safeName(text) {
        return String(text || 'Report').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'Report';
    }

    global.ReportCsv = { build, download, rowsFromTbody, stamp, safeName };
})(window);
