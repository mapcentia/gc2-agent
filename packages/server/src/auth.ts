/**
 * Preflight: prove the caller's token is valid against GC2 before spending
 * LLM tokens. GC2 itself enforces per-tool rights afterwards.
 */
export const verifyToken = async (token: string): Promise<boolean> => {
  const base = process.env["API_BASE_URL"] ?? "https://api.centia.io";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${base}/api/v4/schemas?namesOnly=true`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};
