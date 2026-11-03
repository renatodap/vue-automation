import { loadEnvConfig } from '@next/env';
import { db } from '../src/lib/db';
import { discoverHistory, syncHistory } from '../src/lib/history-ingest';

loadEnvConfig(process.cwd());
async function main() {
  const args = process.argv.slice(2);
  const value = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  if (args.includes('--discover')) {
    const inventory = await discoverHistory();
    console.log(JSON.stringify({ timeZone: inventory.timeZone, temperatureUnit: inventory.temperatureUnit,
      totalEntities: inventory.states.length,
      entities: [...inventory.entities].map(([entityId,e]) => ({ entityId,kind:e.kind,room:e.room,name:e.attributes.friendly_name ?? entityId })),
    },null,2));
    return;
  }
  console.log(JSON.stringify(await syncHistory({ start: value('--start'),end: value('--end'),
    maxDays: args.includes('--backfill') ? Infinity : 3,
    onProgress: progress => console.log(JSON.stringify(progress)),
  })));
  const sql = db();
  if (sql) {
    for (const table of ['lamp_state_history','climate_history','scene_application']) {
      const rows = await sql.unsafe(`SELECT count(*)::int AS rows,min(at) AS first_at,max(at) AS last_at,count(DISTINCT entity_id)::int AS entities FROM ${table}`);
      console.log(JSON.stringify({ table,...rows[0] }));
    }
  }
}
main().catch(error => {
  console.error(error instanceof Error && !('severity' in error) ? error.message : 'History database operation failed');
  process.exitCode = 1;
}).finally(async () => { await db()?.end({timeout:5}); });
