-- 候选操作的脱敏结果（主规格 §9.2 的 GET /admin/operations/:id 需要返回代理探测阶段与凭证状态）。
-- 这里只保存清洗后的结果，绝不保存候选密文、Token 片段或上游响应正文。
ALTER TABLE pending_operations ADD COLUMN result_json TEXT;
