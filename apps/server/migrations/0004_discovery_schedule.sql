-- 发现模块的每日导入计划（主规格 §8.1）。
--
-- 上游在 UTC 01:00 运行，本系统在北京时间 10:00 附近错峰检查；偏移量在库创建时随机生成一次，
-- 之后对该部署稳定不变，避免所有实例同时打上游。
ALTER TABLE settings ADD COLUMN discovery_offset_seconds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE settings ADD COLUMN discovery_next_run_at INTEGER;

UPDATE settings
   SET discovery_offset_seconds = abs(random()) % 3600,
       discovery_next_run_at = NULL
 WHERE id = 1;
