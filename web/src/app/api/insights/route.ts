import { insightsResponse } from "@/lib/history-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  return insightsResponse(req);
}
