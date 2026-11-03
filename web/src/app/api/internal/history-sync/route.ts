import { internalSecretOk, unauthorized } from '../_lib/guard';
import { syncHistory } from '@/lib/history-ingest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(req: Request) {
  if (!internalSecretOk(req)) return unauthorized();
  try {
    const result = await syncHistory({maxDays:3});
    return Response.json({ok:true,...result},{headers:{'Cache-Control':'no-store'}});
  } catch {
    return Response.json({ok:false,error:'History ingestion failed; the next scheduled run will retry.'},{status:503,headers:{'Cache-Control':'no-store'}});
  }
}
