-- 应用主密钥改为系统自管理（主规格 §10.2 修订）。
--
-- 旧实现要求部署者预先提供 32 字节密钥文件；现在由系统在首次启动时生成并写入本表单行，
-- 之后每次启动读回同一值。主密钥只用于库内凭证（PAT、代理密码、候选操作密文）的
-- AES-256-GCM 加密；删除本行等同于废弃全部已存加密凭证（需重新配置 Token 与代理）。
CREATE TABLE app_secret (
  name       TEXT PRIMARY KEY,
  value      BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
