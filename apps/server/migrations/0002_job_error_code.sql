-- 任务失败原因（主规格 §9.2 的 GET /admin/jobs 需要展示逐任务失败与延后原因）。
-- 仓库级错误仍保存在 monitor_streams.last_error_code；这里只记录本次任务尝试的结论。
ALTER TABLE jobs ADD COLUMN error_code TEXT;
