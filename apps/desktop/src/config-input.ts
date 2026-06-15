export function parseJsonObject(
  value: string,
  fileName: string
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (reason) {
    const detail =
      reason instanceof Error
        ? reason.message
        : typeof reason === "string"
          ? reason
          : JSON.stringify(reason);
    throw new Error(`${fileName} 不是有效 JSON：${detail}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${fileName} 的根节点必须是 JSON 对象`);
  }
  return parsed as Record<string, unknown>;
}
