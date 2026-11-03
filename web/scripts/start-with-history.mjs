// Lighting controls stay available while the optional history collector retries.
import { superviseHistory } from './history-supervisor.mjs';

const supervisor = superviseHistory();
process.once('SIGTERM', () => supervisor.stop(0));
process.once('SIGINT', () => supervisor.stop(0));
