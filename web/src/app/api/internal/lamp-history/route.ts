import { historyResponse } from "@/lib/history-http";
import { internalSecretOk, unauthorized } from "../_lib/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  if (!internalSecretOk(req)) return unauthorized();
  return historyResponse(req, "lamps");
}
