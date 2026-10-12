-- 项目发现改为默认能力（主规格 §8.1 修订）。
--
-- 发现模块此前由 settings.discovery_enabled 开关控制，现在不再提供开关：单例行固定为启用。
-- 列本身保留（发现游标、上次成功时间等状态仍挂在 settings 上，读取路径不变），
-- 只是不再有把它关掉的入口：管理接口的更新契约里已移除该字段。
UPDATE settings SET discovery_enabled = 1 WHERE id = 1;
