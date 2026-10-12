/**
 * 容器健康检查。
 *
 * 只访问本机 ready 接口，不调用 GitHub；因此上游故障不会让容器被反复重启。
 */

const port = process.env['PORT'] ?? '8080';
const url = `http://127.0.0.1:${port}/health/ready`;

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 4000);

try {
  const response = await fetch(url, { signal: controller.signal });
  clearTimeout(timer);
  if (!response.ok) {
    process.stderr.write(`ready probe failed: HTTP ${response.status}\n`);
    process.exit(1);
  }
  process.exit(0);
} catch (error) {
  clearTimeout(timer);
  process.stderr.write(`ready probe error: ${error instanceof Error ? error.message : 'unknown'}\n`);
  process.exit(1);
}
