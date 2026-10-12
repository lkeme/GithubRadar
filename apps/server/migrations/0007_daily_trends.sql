-- 每日趋势报告代次（来源 difyz9/github-trend-monitor 的 reports/*.md）。
--
-- 与 discovery_* 分开建表：报告只有「名称 / Star / 分类」三列且按名次排序，
-- 与分类 CSV 的候选全集不是同一份数据，混在一张表里会让两边的唯一键互相牵制。
CREATE TABLE daily_trend_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 报告文件名里的日期（YYYY-MM-DD），已导入过的日期不重复抓取。
  report_day   TEXT    NOT NULL CHECK (report_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  source_commit TEXT   NOT NULL,
  source_manifest_json TEXT NOT NULL,
  parser_version INTEGER NOT NULL,
  imported_at  INTEGER NOT NULL
);

CREATE UNIQUE INDEX daily_trend_runs_day_uq ON daily_trend_runs (report_day);
CREATE INDEX daily_trend_runs_imported_idx ON daily_trend_runs (imported_at);

CREATE TABLE daily_trend_items (
  run_id       INTEGER NOT NULL REFERENCES daily_trend_runs (id) ON DELETE CASCADE,
  -- 报告内名次：同一天同一仓库可能因分类不同出现两次，唯一键必须用名次。
  rank         INTEGER NOT NULL CHECK (rank >= 1),
  full_name    TEXT    NOT NULL,
  html_url     TEXT    NOT NULL,
  stars        INTEGER NOT NULL CHECK (stars >= 0),
  domain       TEXT,
  PRIMARY KEY (run_id, rank)
);

CREATE INDEX daily_trend_items_name_idx ON daily_trend_items (full_name);

-- 每日趋势的下一次导入计划；与项目发现共用窗口偏移，再错开 5 分钟避免同时打上游。
ALTER TABLE settings ADD COLUMN trends_next_run_at INTEGER;
-- 最近一次导入尝试的结论。报告只在成功时落库，没有这两列就看不出"每天都在失败"。
ALTER TABLE settings ADD COLUMN trends_last_attempt_state TEXT
  CHECK (trends_last_attempt_state IS NULL OR trends_last_attempt_state IN ('published', 'skipped', 'failed'));
ALTER TABLE settings ADD COLUMN trends_last_attempt_error TEXT;
ALTER TABLE settings ADD COLUMN trends_last_attempt_at INTEGER;
-- 最近一次**真实失败**：一次 skipped 不能把持续失败的结论抹掉，因此单独记录。
ALTER TABLE settings ADD COLUMN trends_last_failure_error TEXT;
ALTER TABLE settings ADD COLUMN trends_last_failure_at INTEGER;
