/**
 * Builds a readable message from an IMAP/connection error.
 *
 * Node wraps multi-address connect failures (e.g. localhost -> ::1 + 127.0.0.1)
 * in an `AggregateError` whose own `.message` is empty, so the per-address
 * failures in `err.errors` are summarised instead, e.g.
 * `ECONNREFUSED ::1:25, 127.0.0.1:25`. `err.code` and ImapFlow's
 * `err.responseText` are appended when they add information.
 */
export function formatImapError(err: any): string {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;

  const parts: string[] = [];
  const nested: any[] = Array.isArray(err.errors) ? err.errors : [];

  if (nested.length > 0) {
    const targetsByCode = new Map<string, string[]>();
    for (const e of nested) {
      const code = e?.code || e?.name || "ERROR";
      const target = e?.address
        ? `${e.address}${e.port ? `:${e.port}` : ""}`
        : e?.message || "unknown";
      targetsByCode.set(code, [...(targetsByCode.get(code) ?? []), target]);
    }
    parts.push(
      [...targetsByCode]
        .map(([code, targets]) => `${code} ${targets.join(", ")}`)
        .join("; "),
    );
  } else if (err.message) {
    parts.push(err.message);
  }

  const summary = parts.join(" ");
  if (err.code && !summary.includes(String(err.code))) {
    parts.push(`code: ${err.code}`);
  }
  if (err.responseText && !summary.includes(String(err.responseText))) {
    parts.push(`server: ${err.responseText}`);
  }

  return parts.length > 0 ? parts.join(" | ") : err.name || String(err);
}
