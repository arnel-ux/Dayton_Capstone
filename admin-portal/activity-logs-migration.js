// Converts the older admin_activity_logs layout (admin_name, entity_type, entity_name, details)
// into the current one (admin_username, admin_fullname, admin_role, module, description) in place.
// Idempotent: does nothing once the old columns are gone, and every old row is carried over before they are dropped.
module.exports = function migrateActivityLogs(db, table, done) {
    const q = (sql, params) => new Promise((resolve, reject) => db.query(sql, params || [], (e, r) => (e ? reject(e) : resolve(r))));

    (async () => {
        const old = await q(
            "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME IN ('admin_name','entity_type','entity_name','details','admin_username')",
            [table]
        );
        const have = new Set(old.map(r => r.COLUMN_NAME));
        if (!have.has('admin_name')) return false; // already the current layout

        if (!have.has('admin_username')) {
            await q(`ALTER TABLE \`${table}\`
                ADD COLUMN admin_username VARCHAR(100) NOT NULL DEFAULT '',
                ADD COLUMN admin_fullname VARCHAR(255) NULL,
                ADD COLUMN admin_role VARCHAR(50) NULL,
                ADD COLUMN module VARCHAR(50) NOT NULL DEFAULT '',
                ADD COLUMN description TEXT NULL`);
        }
        // Names and roles come from the live admins row where it still exists, else from the copy stored on the log row.
        await q(`UPDATE \`${table}\` l LEFT JOIN admins a ON a.id = l.admin_id SET
            l.admin_username = COALESCE(a.username, l.admin_name),
            l.admin_fullname = COALESCE(a.fullname, l.admin_name),
            l.admin_role = a.role,
            l.module = l.entity_type,
            l.description = CONCAT(
                CASE LOWER(l.action) WHEN 'add' THEN 'Added' WHEN 'create' THEN 'Added' WHEN 'edit' THEN 'Edited' WHEN 'update' THEN 'Edited'
                    WHEN 'archive' THEN 'Archived' WHEN 'restore' THEN 'Restored' WHEN 'delete' THEN 'Deleted' ELSE 'Changed' END,
                ' ', LOWER(l.entity_type), COALESCE(CONCAT(' "', l.entity_name, '"'), ''), '.',
                COALESCE(CONCAT(' ', l.details, IF(RIGHT(l.details, 1) = '.', '', '.')), '')),
            l.action = CASE LOWER(l.action) WHEN 'add' THEN 'CREATE' WHEN 'edit' THEN 'UPDATE' ELSE UPPER(l.action) END
            WHERE l.admin_username = ''`);
        await q(`ALTER TABLE \`${table}\` MODIFY description TEXT NOT NULL`);
        await q(`ALTER TABLE \`${table}\` DROP COLUMN admin_name, DROP COLUMN entity_type, DROP COLUMN entity_name, DROP COLUMN details`);
        try { await q(`ALTER TABLE \`${table}\` ADD INDEX idx_activity_admin (admin_id)`); } catch (e) { /* already there */ }
        return true;
    })().then(changed => done(null, changed), err => done(err));
};
