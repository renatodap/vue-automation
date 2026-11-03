import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn } from 'node:child_process';
import { superviseHistory } from '../scripts/history-supervisor.mjs';

class FakeChild extends EventEmitter {
  signals: string[] = [];
  kill(signal: string) { this.signals.push(signal); return true; }
  end(code = 1) { this.emit('exit', code, null); }
}

function fixture() {
  let clock = 0;
  let sequence = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const children: FakeChild[] = [];
  const commands: string[][] = [];
  const exits: number[] = [];
  const logs: string[] = [];
  let failNextSpawn = false;
  const fakeSpawn = ((_command: string, args: string[]) => {
    if (failNextSpawn) { failNextSpawn = false; throw new Error('spawn failed'); }
    commands.push(args);
    const child = new FakeChild(); children.push(child);
    return child as unknown as ChildProcess;
  }) as typeof spawn;
  const supervisor = superviseHistory({
    spawnChild: fakeSpawn,
    setTimer: ((run: () => void, delay: number) => {
      const id = ++sequence; timers.set(id, { at: clock + delay, run }); return id;
    }) as unknown as typeof setTimeout,
    clearTimer: ((id: number) => { timers.delete(id); }) as unknown as typeof clearTimeout,
    now: () => clock,
    exit: ((code: number) => { exits.push(code); }) as (code: number) => never,
    log: (message: string) => { logs.push(message); },
  });
  function advance(ms: number) {
    const target = clock + ms;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]); clock = next[1].at; next[1].run();
    }
    clock = target;
  }
  return { supervisor, children, commands, exits, logs, timers, advance, failSpawn: () => { failNextSpawn = true; } };
}

test('collector failures keep Next alive and retry with capped exponential backoff', () => {
  const f = fixture();
  assert.deepEqual(f.commands[0], ['node_modules/next/dist/bin/next', 'start']);
  assert.equal(f.commands[1].at(-1), 'scripts/history-worker.ts');
  for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
    const count = f.children.length;
    f.children.at(-1)!.end();
    assert.equal(JSON.parse(f.logs.at(-1)!).delay_ms, delay);
    assert.deepEqual(f.children[0].signals, [], 'a collector outage must never stop light controls');
    assert.deepEqual(f.exits, []);
    f.advance(delay - 1);
    assert.equal(f.children.length, count, 'do not busy-loop failed workers');
    f.advance(1);
    assert.equal(f.children.length, count + 1);
    assert.equal(f.commands.at(-1)!.at(-1), 'scripts/history-worker.ts');
  }
});

test('a recovered collector resets the backoff after a minute of uptime', () => {
  const f = fixture();
  f.children[1].end(); f.advance(1000);
  f.children[2].end(); f.advance(2000);
  f.advance(60_000);
  f.children[3].end();
  assert.equal(JSON.parse(f.logs.at(-1)!).delay_ms, 1000);
});

test('worker spawn errors retry once, even if the same child also emits exit', () => {
  const f = fixture();
  f.children[1].emit('error', new Error('spawn failed'));
  f.children[1].end();
  assert.equal(f.timers.size, 1);
  f.failSpawn(); f.advance(1000);
  assert.equal(f.timers.size, 1, 'synchronous spawn failures must also back off');
  assert.deepEqual(f.children[0].signals, []);
  assert.deepEqual(f.exits, []);
  assert.equal(JSON.parse(f.logs.at(-1)!).delay_ms, 2000);
});

test('when Next exits the supervisor stops the collector and exits for Coolify restart', () => {
  const f = fixture();
  f.children[0].end(2);
  assert.deepEqual(f.children[1].signals, ['SIGTERM']);
  assert.deepEqual(f.exits, [], 'allow the collector to flush before exiting');
  f.children[1].end(0);
  assert.deepEqual(f.exits, [2]);
  f.advance(60_000);
  assert.equal(f.children.length, 2, 'shutdown must never restart the collector');
});

test('SIGTERM-style stop terminates both children, waits for exit, and returns success', () => {
  const f = fixture();
  f.supervisor.stop(0);
  assert.deepEqual(f.children.map((child) => child.signals), [['SIGTERM'], ['SIGTERM']]);
  f.children[0].end(0);
  assert.deepEqual(f.exits, []);
  f.children[1].end(0);
  assert.deepEqual(f.exits, [0]);
  assert.equal(f.timers.size, 0);
});

test('shutdown cancels a pending worker retry and kills an unresponsive child after grace time', () => {
  const f = fixture();
  f.children[1].end();
  f.supervisor.stop(0);
  f.advance(9999);
  assert.equal(f.children.length, 2);
  assert.deepEqual(f.children[0].signals, ['SIGTERM']);
  f.advance(1);
  assert.deepEqual(f.children[0].signals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(f.exits, [0]);
  f.children[0].end(0);
  assert.deepEqual(f.exits, [0], 'late child events must not exit twice');
});
