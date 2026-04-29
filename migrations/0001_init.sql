-- Glint v2 initial schema
-- Tables: captures, threads, turns
-- Virtual: captures_fts, turns_fts (FTS5 keyword)
-- Optional: capture_vec (sqlite-vss; loaded conditionally)

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS threads (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  title       TEXT,
  pinned      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS captures (
  id            TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL,
  png_path      TEXT NOT NULL,
  thumb_path    TEXT,
  ocr_text      TEXT,
  ocr_conf      REAL,
  text_density  REAL,
  route         TEXT NOT NULL CHECK (route IN ('text', 'vision')),
  tags          TEXT,
  thread_id     TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  embed_pending INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS turns (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  model       TEXT
);

CREATE INDEX IF NOT EXISTS idx_captures_created ON captures(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_captures_thread  ON captures(thread_id);
CREATE INDEX IF NOT EXISTS idx_turns_thread     ON turns(thread_id, created_at);

-- FTS5 virtual tables for keyword search
CREATE VIRTUAL TABLE IF NOT EXISTS captures_fts USING fts5(
  ocr_text, tags, content='captures', content_rowid='rowid'
);
CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
  content, content='turns', content_rowid='rowid'
);

-- FTS5 sync triggers
CREATE TRIGGER IF NOT EXISTS captures_ai AFTER INSERT ON captures BEGIN
  INSERT INTO captures_fts(rowid, ocr_text, tags) VALUES (new.rowid, new.ocr_text, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS captures_ad AFTER DELETE ON captures BEGIN
  INSERT INTO captures_fts(captures_fts, rowid, ocr_text, tags) VALUES ('delete', old.rowid, old.ocr_text, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS captures_au AFTER UPDATE ON captures BEGIN
  INSERT INTO captures_fts(captures_fts, rowid, ocr_text, tags) VALUES ('delete', old.rowid, old.ocr_text, old.tags);
  INSERT INTO captures_fts(rowid, ocr_text, tags) VALUES (new.rowid, new.ocr_text, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
  INSERT INTO turns_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS turns_ad AFTER DELETE ON turns BEGIN
  INSERT INTO turns_fts(turns_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
