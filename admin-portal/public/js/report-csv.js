/**
 * report-csv.js — builds the CSV downloads offered next to every "Download PDF"
 * button (report.ejs, cluster-detail.ejs, survey-records.ejs).
 *
 * WHAT WAS WRONG WITH DOING IT INLINE
 * Each page used to build its CSV by walking `.report-table tr` and dumping
 * every cell it found into one flat file. A CSV is a single grid, and those
 * pages do not hold a single grid — the SQD scorecard is 3 columns, the written
 * comments table is 4, the respondents breakdown is 9, and the scorecard's own
 * header is two rows deep with a rowspan and a colspan in it. Concatenated, the
 * result opened in Excel as one ragged block: a half-empty header row, then
 * three-column rows, then four-column rows underneath them in the same columns,
 * with nothing saying where one table ended and the next began, and no office,
 * period or respondent count anywhere in the file.
 *
 * So the export is built from the report's DATA rather than scraped from its
 * layout: named sections, each with its own header row and its own column
 * count, separated by a blank line, under a title block naming the office and
 * period. Excel and Sheets both read that back as labelled blocks.
 *
 * Every page calls this so the three downloads cannot drift into three formats.
 */
(function (global) {
    // Excel and Sheets treat a leading =, +, - or @ as the start of a formula,
    // and these files carry text written by members of the public. A comment
    // beginning "=1+1" must arrive as those four characters, not as a cell the
    // spreadsheet evaluates, so it is prefixed with an apostrophe — the
    // spreadsheet convention for "this is literally text".
    function sanitizeCell(value) {
        const text = value === null || value === undefined ? '' : String(value);
        return /^[=+\-@\t\r]/.test(text) ? "'" + text : text;
    }

    // One CSV field: newlines and tabs flattened to spaces (a wrapped comment
    // is one cell, not three rows), doubled quotes, always quoted.
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

    /**
     * @param {object[]} sections - each { title?, columns?, rows }:
     *   title   - a heading line printed above the block (optional)
     *   columns - the block's header row (optional; omit for label/value pairs)
     *   rows    - array of arrays, one array per line
     * @returns {string} the CSV text, CRLF-terminated and BOM-prefixed.
     */
    function build(sections) {
        const lines = [];
        (sections || []).forEach((section, index) => {
            if (!section) return;
            if (index > 0) lines.push('');
            if (section.title) lines.push(csvRow([section.title]));
            if (section.columns && section.columns.length) lines.push(csvRow(section.columns));
            (section.rows || []).forEach(row => lines.push(csvRow(row)));
        });
        // CRLF, and a UTF-8 BOM in front: without the BOM Excel on Windows opens
        // the file in the system codepage, which turns every accented character
        // in a Filipino comment into mojibake.
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
        // Both are the cleanup the old inline version never did: the <a> stayed
        // in the DOM and the blob URL stayed alive for the life of the page,
        // every time someone pressed the button.
        document.body.removeChild(link);
        global.URL.revokeObjectURL(url);
    }

    /**
     * Reads a rendered <tbody> into rows of cell text. Used for the tables whose
     * rows are built at runtime from the API response (the written comments, the
     * SQD rating-bucket breakdowns) rather than sitting in the template.
     * A row whose only cell spans the table is the "no rows" message — it is
     * carried across as a single-cell line, so the file says why a section is
     * empty instead of just being empty.
     */
    function rowsFromTbody(tbody) {
        if (!tbody) return [];
        return Array.from(tbody.querySelectorAll('tr')).map(tr =>
            Array.from(tr.querySelectorAll('td, th')).map(cell => cell.innerText)
        );
    }

    // Timestamped filenames — an office that exports the same report twice in a
    // day used to get "CSM_Data.csv" and "CSM_Data (1).csv" in its Downloads
    // folder with nothing to tell them apart.
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
