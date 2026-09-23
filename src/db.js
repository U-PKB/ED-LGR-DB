import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const FIELDS = [
  'title',
  'link',
  'attachment_path',
  'attachment_name',
  'attachment_type',
  'category',
  'notes',
  'keywords',
  'date_entered',
  'region',
  'authority',
  'relevance',
  'briefing',
  'key_messages',
  'analysis_status',
  'analysis_error',
  'analysed_at',
];

export function openDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'ed-lgr.db'));
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      title            TEXT NOT NULL DEFAULT '',
      link             TEXT,
      attachment_path  TEXT,
      attachment_name  TEXT,
      attachment_type  TEXT,
      category         TEXT NOT NULL CHECK (category IN ('LGR', 'ED')),
      notes            TEXT NOT NULL DEFAULT '',
      keywords         TEXT NOT NULL DEFAULT '',
      date_entered     TEXT NOT NULL,
      region           TEXT NOT NULL,
      authority        TEXT NOT NULL DEFAULT '',
      relevance        TEXT,
      briefing         TEXT,
      key_messages     TEXT,
      analysis_status  TEXT NOT NULL DEFAULT 'pending',
      analysis_error   TEXT,
      analysed_at      TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_entries_category ON entries(category);
    CREATE INDEX IF NOT EXISTS idx_entries_region ON entries(region);
    CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date_entered);
  `);

  const toEntry = (row) =>
    row && {
      ...row,
      key_messages: row.key_messages ? JSON.parse(row.key_messages) : [],
    };

  const serialise = (data) => {
    const out = {};
    for (const field of FIELDS) {
      if (field in data) {
        out[field] =
          field === 'key_messages' && Array.isArray(data[field])
            ? JSON.stringify(data[field])
            : data[field];
      }
    }
    return out;
  };

  return {
    list() {
      return db
        .prepare('SELECT * FROM entries ORDER BY date_entered DESC, id DESC')
        .all()
        .map(toEntry);
    },

    get(id) {
      return toEntry(db.prepare('SELECT * FROM entries WHERE id = ?').get(id));
    },

    create(data) {
      const values = serialise(data);
      const cols = Object.keys(values);
      const info = db
        .prepare(
          `INSERT INTO entries (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`,
        )
        .run(values);
      return this.get(info.lastInsertRowid);
    },

    update(id, data) {
      const values = serialise(data);
      const cols = Object.keys(values);
      if (cols.length === 0) return this.get(id);
      db.prepare(
        `UPDATE entries SET ${cols.map((c) => `${c} = @${c}`).join(', ')},
           updated_at = datetime('now') WHERE id = @id`,
      ).run({ ...values, id });
      return this.get(id);
    },

    remove(id) {
      return db.prepare('DELETE FROM entries WHERE id = ?').run(id).changes > 0;
    },

    idsWithStatus(...statuses) {
      return db
        .prepare(
          `SELECT id FROM entries WHERE analysis_status IN (${statuses.map(() => '?').join(', ')}) ORDER BY id`,
        )
        .all(...statuses)
        .map((r) => r.id);
    },

    close() {
      db.close();
    },
  };
}
