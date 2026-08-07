/**
 * basePath-aware fetch for client components.
 *
 * Next prepends basePath to its own router, Link and asset internals — but not
 * to a raw fetch("/api/..."). Under a path-mounted deploy that request escapes
 * this app entirely and hits whatever else lives at the domain root.
 */
const base = process.env.NEXT_PUBLIC_BASE_PATH || "";

export function apiUrl(path: string): string {
  return `${base}${path}`;
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(apiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(
      (data as { message?: string })?.message ??
        (data as { error?: string })?.error ??
        `Request failed (${response.status})`,
      response.status,
    );
  }
  return data as T;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}
