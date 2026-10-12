import assert from 'node:assert/strict';
import test from 'node:test';
import type TonalClient from '@dlwiest/ts-tonal-client';
import { allTools, toolsRegistry } from '../src/tools/registry.js';
import type { MCPResponse } from '../src/types/index.js';

const workoutId = '00000000-0000-4000-8000-000000000001';
const programId = '00000000-0000-4000-8000-000000000002';
const names = ['search_workout_library', 'search_program_library', 'get_library_workout', 'get_library_program'];
function fake(methods: Record<string, unknown>): TonalClient {
  return methods as unknown as TonalClient;
}
function data(response: MCPResponse): Record<string, any> {
  const content = response.content[0];
  assert.ok(content?.type === 'text');
  assert.notEqual(response.isError, true, content.text);
  return JSON.parse(content.text);
}
function tool(name: string) {
  const found = toolsRegistry.get(name);
  assert.ok(found, `${name} must be registered`);
  return found;
}
async function call(name: string, client: TonalClient, args?: Record<string, unknown>) {
  return tool(name).handler(client, args);
}
function catalog(rows: unknown) {
  const calls: unknown[][] = [];
  return {
    calls,
    client: fake({ httpClient: { request: async (...args: unknown[]) => {
      calls.push(args);
      return rows;
    } } }),
  };
}
const workout = {
  id: workoutId, title: 'Synthetic strength', description: 'Controlled upper work',
  shortDescription: 'Synthetic session', level: 'Beginner', targetArea: 'UpperBody',
  duration: 1200, accessories: ['Bench', 'Handles'], supportedDevices: ['Tonal'],
  mobileFriendly: false, featureGroupIds: ['synthetic-feature'], publishState: 'published',
  assetId: 'do-not-output', videoUrl: 'https://example.invalid/media',
};
const program = {
  id: programId, name: 'Synthetic progression', description: 'Controlled strength',
  level: 'Intermediate', weeks: 4, workoutsPerWeek: 3, mobileFriendly: true,
  supportedDevices: ['Mobile'], workouts: [], publishState: 'published',
};

test('registers all four library tools with read-only annotations and bounded schemas', () => {
  for (const name of names) {
    const found = tool(name);
    assert.equal(allTools.filter(t => t.name === name).length, 1);
    assert.equal(found.annotations?.readOnlyHint, true);
    assert.equal(found.annotations?.destructiveHint, false);
    if (name.startsWith('search')) {
      assert.deepEqual(found.inputSchema.required, []);
      assert.equal(found.inputSchema.properties.limit.default, 10);
      assert.equal(found.inputSchema.properties.limit.maximum, 50);
      assert.equal(found.inputSchema.properties.limit.minimum, 1);
      assert.equal(found.inputSchema.properties.offset.default, 0);
      assert.equal(found.inputSchema.properties.offset.minimum, 0);
    } else {
      const idField = name.endsWith('workout') ? 'workoutId' : 'programId';
      assert.deepEqual(found.inputSchema.required, [idField]);
      assert.equal(found.inputSchema.properties[idField].format, 'uuid');
    }
  }
});

test('fetches fixed GET indexes and applies default/max limits with exact local paging', async () => {
  for (const [name, path] of [['search_workout_library', '/workouts'], ['search_program_library', '/programs']]) {
    const base = name.includes('workout') ? workout : program;
    const rows = Array.from({ length: 61 }, (_, n) => ({ ...base, id: `synthetic-${String(n).padStart(2, '0')}` }));
    const mock = catalog(rows.slice().reverse());
    const first = data(await call(name, mock.client));
    assert.equal(first.returned, 10);
    assert.equal(first.total, 61);
    assert.equal(first.offset, 0);
    assert.equal(first.limit, 10);
    assert.equal(first.has_more, true);
    assert.equal(first.results[0].id, 'synthetic-00');
    const max = data(await call(name, mock.client, { limit: 50, offset: 10 }));
    assert.equal(max.returned, 50);
    assert.equal(max.results[0].id, 'synthetic-10');
    assert.equal(max.has_more, true);
    const last = data(await call(name, mock.client, { limit: 50, offset: 60 }));
    assert.equal(last.returned, 1);
    assert.equal(last.has_more, false);
    const past = data(await call(name, mock.client, { offset: 100 }));
    assert.equal(past.returned, 0);
    assert.equal(past.total, 61);
    assert.equal(past.has_more, false);
    assert.deepEqual(mock.calls, Array(4).fill([path, { method: 'GET' }]));
  }
});

test('text search is case-insensitive across title/name/descriptions and sorts deterministically', async () => {
  const rows = [
    { ...workout, id: 'z', title: 'Beta' },
    { ...workout, id: 'b', title: 'alpha', description: 'Needle' },
    { ...workout, id: 'a', title: 'Alpha', description: 'needle' },
    { id: 'n', name: 'NEEDLE fallback' },
  ];
  const result = data(await call('search_workout_library', catalog(rows).client, { query: 'NEEDLE' }));
  assert.deepEqual(result.results.map((r: any) => r.id), ['a', 'b', 'n']);
  assert.equal(data(await call('search_workout_library', catalog(rows).client, { query: 'BETA' })).returned, 1);
  assert.equal(data(await call('search_workout_library', catalog(rows).client, { query: 'synthetic session' })).returned, 3);
  assert.equal(data(await call('search_program_library', catalog([program]).client, { query: 'PROGRESSION' })).returned, 1);
  assert.equal(data(await call('search_program_library', catalog([program]).client, { query: 'CONTROLLED' })).returned, 1);
});

test('workout filters use seconds for inclusive minute bounds and explicit compatibility', async () => {
  const mock = catalog([workout, { ...workout, id: 'long', duration: 1201 }, { ...workout, id: 'short', duration: 1199 }]);
  const result = data(await call('search_workout_library', mock.client, {
    difficulty: 'beginner', targetArea: 'upperbody', minDurationMinutes: 20,
    maxDurationMinutes: 20, equipment: ['BENCH', 'handles'], supportedDevices: ['tonal'], mobileFriendly: false,
  }));
  assert.equal(result.returned, 1);
  assert.equal(result.results[0].durationMinutes, 20);
  assert.deepEqual(result.results[0].supportedDevices, ['Tonal']);
  for (const args of [{ equipment: ['Mat'] }, { supportedDevices: ['Mobile'] }, { mobileFriendly: true }, { difficulty: 'Advanced' }, { targetArea: 'Core' }]) {
    assert.equal(data(await call('search_workout_library', catalog([workout]).client, args)).returned, 0);
  }
});

test('program filters do not infer session counts from empty index workouts', async () => {
  const args = { difficulty: 'intermediate', weeks: 4, workoutsPerWeek: 3, supportedDevices: ['mobile'], mobileFriendly: true };
  const result = data(await call('search_program_library', catalog([program]).client, args));
  assert.equal(result.returned, 1);
  assert.equal(result.results[0].weeks, 4);
  assert.equal(result.results[0].workoutsPerWeek, 3);
  assert.equal('sessionCount' in result.results[0], false);
  for (const filter of [{ weeks: 5 }, { workoutsPerWeek: 2 }, { supportedDevices: ['Tonal'] }, { mobileFriendly: false }, { difficulty: 'Beginner' }]) {
    assert.equal(data(await call('search_program_library', catalog([program]).client, filter)).returned, 0);
  }
});

test('empty/missing/null metadata is safe and unknown compatibility never matches a filter', async () => {
  for (const name of names.slice(0, 2)) {
    const empty = data(await call(name, catalog([]).client));
    assert.deepEqual([empty.total, empty.returned, empty.has_more, empty.results], [0, 0, false, []]);
    const row = { id: 'null-metadata', title: null, name: null, description: null, duration: null, level: null, accessories: null, supportedDevices: null, mobileFriendly: null };
    const result = data(await call(name, catalog([row]).client));
    assert.equal(result.returned, 1);
    assert.equal(result.results[0].supportedDevices, null);
    assert.equal(result.results[0].mobileFriendly, null);
    assert.equal(data(await call(name, catalog([row]).client, { supportedDevices: ['Tonal'] })).returned, 0);
    assert.equal(data(await call(name, catalog([row]).client, { mobileFriendly: false })).returned, 0);
    assert.equal(data(await call(name, catalog([{ id: 'missing' }]).client)).returned, 1);
  }
  assert.equal(data(await call('search_workout_library', catalog([{ id: 'x' }]).client, { minDurationMinutes: 0 })).returned, 0);
});

test('search summaries allowlist fields and bound descriptions', async () => {
  const result = data(await call('search_workout_library', catalog([{ ...workout, description: 'x'.repeat(2000) }]).client));
  assert.ok(result.results[0].description.length <= 300);
  assert.equal('sets' in result.results[0], false);
  assert.equal('assetId' in result.results[0], false);
  assert.equal('videoUrl' in result.results[0], false);
});

test('invalid search arguments fail before any fetch', async () => {
  const common = [
    { offset: -1 }, { offset: 1.5 }, { offset: NaN }, { offset: Infinity }, { offset: Number.MAX_SAFE_INTEGER + 1 }, { offset: '0' }, { offset: null },
    { limit: 0 }, { limit: 51 }, { limit: 1.5 }, { limit: NaN }, { limit: Infinity }, { limit: '10' }, { limit: null },
    { query: 1 }, { query: null }, { difficulty: [] }, { difficulty: '' },
    { supportedDevices: 'Tonal' }, { supportedDevices: [1] }, { supportedDevices: [''] }, { supportedDevices: null }, { mobileFriendly: 'true' },
  ];
  for (const name of names.slice(0, 2)) {
    const extra = name.includes('workout')
      ? [{ minDurationMinutes: -1 }, { minDurationMinutes: NaN }, { maxDurationMinutes: Infinity }, { maxDurationMinutes: '20' }, { minDurationMinutes: 30, maxDurationMinutes: 20 }, { equipment: [null] }, { equipment: null }, { targetArea: false }]
      : [{ weeks: 0 }, { weeks: 1.2 }, { weeks: '4' }, { weeks: null }, { weeks: Infinity }, { workoutsPerWeek: NaN }, { workoutsPerWeek: -1 }];
    for (const args of [...common, ...extra]) {
      const mock = catalog([]);
      const response = await call(name, mock.client, args);
      assert.equal(response.isError, true, JSON.stringify(args));
      assert.equal(mock.calls.length, 0);
    }
  }
});

test('UUID detail validation rejects literal malformed IDs before fetching', async () => {
  let calls = 0;
  const client = fake({ getWorkoutById: async () => { calls++; }, getProgramById: async () => { calls++; } });
  for (const name of names.slice(2)) {
    const field = name.endsWith('workout') ? 'workoutId' : 'programId';
    for (const value of [undefined, null, 42, '', 'not-a-uuid', `/workouts/${workoutId}`, ` ${workoutId}`, `${workoutId} `, `${workoutId}\n`, `${workoutId}?x=1`]) {
      assert.equal((await call(name, client, { [field]: value })).isError, true);
    }
  }
  assert.equal(calls, 0);
});

test('workout detail preserves prescribed set array order, movement IDs and programming, not completed activity', async () => {
  const ids: string[] = [];
  const result = data(await call('get_library_workout', fake({ getWorkoutById: async (id: string) => {
    ids.push(id);
    return { ...workout, sets: [
      { id: 's2', movementId: 'movement-b', blockNumber: 2, prescribedReps: 8, weightPercentage: 55, warmUp: false, chains: true },
      { id: 's1', movementId: 'movement-a', blockNumber: 1, prescribedDuration: 30, blockStart: true, description: 'Controlled set', videoUrl: 'omit' },
    ] };
  } }), { workoutId }));
  assert.deepEqual(ids, [workoutId]);
  assert.deepEqual(result.sets.map((s: any) => s.movementId), ['movement-b', 'movement-a']);
  assert.equal(result.sets[0].prescribedReps, 8);
  assert.equal(result.sets[0].weightPercentage, 55);
  assert.equal(result.sets[0].chains, true);
  assert.equal(result.sets[1].prescribedDuration, 30);
  assert.equal('videoUrl' in result.sets[1], false);
  assert.match(result.note, /prescribed/i);
  assert.match(result.note, /not completed/i);
});

test('valid mixed-case UUIDs pass through unchanged; null sets stay unknown', async () => {
  const id = 'ABCDEF00-0000-4000-8000-000000000001';
  const calls: string[] = [];
  const result = data(await call('get_library_workout', fake({ getWorkoutById: async (value: string) => {
    calls.push(value); return { ...workout, id: value, sets: null };
  } }), { workoutId: id }));
  assert.deepEqual(calls, [id]);
  assert.equal(result.sets, null);
});

test('program details use ordered session IDs, retain repeated workouts, schedule and compatibility', async () => {
  const calls: string[] = [];
  const result = data(await call('get_library_program', fake({ getProgramById: async (id: string) => {
    calls.push(id);
    return { ...program, cadence: [true, false, true, false, true, false, false],
      programWorkoutIds: ['session-2', 'session-1', 'session-3'],
      programWorkouts: [
        { id: 'session-1', workoutId, workoutNumber: 1, programWeek: 1, programDay: 1, workoutTitle: 'First' },
        { id: 'session-2', workoutId: 'other-workout', workoutNumber: 2, programWeek: 1, programDay: 3, workoutTitle: 'Second' },
        { id: 'session-3', workoutId, workoutNumber: 3, programWeek: 1, programDay: 5 },
      ], workouts: [workout],
    };
  } }), { programId }));
  assert.deepEqual(calls, [programId]);
  assert.deepEqual(result.sessions.map((s: any) => s.id), ['session-2', 'session-1', 'session-3']);
  assert.deepEqual(result.sessions.map((s: any) => s.workoutId), ['other-workout', workoutId, workoutId]);
  assert.equal(result.sessions[0].programDay, 3);
  assert.deepEqual(result.cadence, [true, false, true, false, true, false, false]);
  assert.equal(result.workoutsPerWeek, 3);
  assert.deepEqual(result.supportedDevices, ['Mobile']);
});

test('program detail fallback sorts workoutNumber, preserves unknown ID-only sessions and missing schedule', async () => {
  const get = (overrides: Record<string, unknown>) => call('get_library_program', fake({ getProgramById: async () => ({ ...program, ...overrides }) }), { programId });
  assert.deepEqual(data(await get({ programWorkouts: [{ workoutId: 'b', workoutNumber: 2 }, { workoutId: 'a', workoutNumber: 1 }] })).sessions.map((s: any) => s.workoutId), ['a', 'b']);
  const idsOnly = data(await get({ programWorkoutIds: ['unknown-session'] }));
  assert.equal(idsOnly.sessions[0].id, 'unknown-session');
  assert.equal(idsOnly.sessions[0].workoutId, null);
  const fallback = data(await get({ workouts: [workout], cadence: null }));
  assert.equal(fallback.sessions[0].workoutId, workoutId);
  assert.equal(fallback.sessions[0].programDay, null);
  assert.equal(fallback.cadence, null);
});

test('fractional duration bounds compare against seconds without rounding', async () => {
  const rows = [{ ...workout, duration: 1230 }, { ...workout, id: 'nearby', duration: 1229 }];
  const result = data(await call('search_workout_library', catalog(rows).client, { minDurationMinutes: 20.5, maxDurationMinutes: 20.5 }));
  assert.equal(result.returned, 1);
  assert.equal(result.results[0].durationMinutes, 20.5);
});

test('empty filter arrays are unrestricted; equipment requires all values and devices any value', async () => {
  assert.equal(data(await call('search_workout_library', catalog([workout]).client, { equipment: [], supportedDevices: [] })).returned, 1);
  assert.equal(data(await call('search_workout_library', catalog([workout]).client, { supportedDevices: ['Unknown', 'tonal'] })).returned, 1);
  assert.equal(data(await call('search_workout_library', catalog([workout]).client, { equipment: ['Bench', 'Mat'] })).returned, 0);
  assert.equal(data(await call('search_workout_library', catalog([{ ...workout, accessories: null, equipment: ['Mat'] }]).client, { equipment: ['mat'] })).returned, 1);
});

test('handlers reject non-object arguments and unknown keys, including prototype names', async () => {
  const mock = catalog([]);
  for (const name of names) {
    for (const args of [null, [], 'bad', { toString: 'not-a-filter' }, { unexpected: true }] as unknown[]) {
      assert.equal((await call(name, mock.client, args as Record<string, unknown>)).isError, true);
    }
  }
  assert.equal(mock.calls.length, 0);
});

test('null/fractional/non-finite numeric arguments and blank array entries fail before fetch', async () => {
  const mock = catalog([]);
  for (const args of [{ minDurationMinutes: null }, { maxDurationMinutes: NaN }, { equipment: [' '] }, { supportedDevices: [true] }]) {
    assert.equal((await call('search_workout_library', mock.client, args)).isError, true);
  }
  for (const args of [{ workoutsPerWeek: null }, { workoutsPerWeek: 2.5 }, { workoutsPerWeek: Infinity }, { weeks: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.equal((await call('search_program_library', mock.client, args)).isError, true);
  }
  assert.equal(mock.calls.length, 0);
});

test('malformed index rows and missing detail objects produce errors instead of misleading counts', async () => {
  for (const row of [null, {}, { id: null }, { id: 1 }, []]) {
    assert.equal((await call('search_workout_library', catalog([row]).client)).isError, true);
    assert.equal((await call('search_program_library', catalog([row]).client)).isError, true);
  }
  assert.equal((await call('get_library_workout', fake({ getWorkoutById: async () => null }), { workoutId })).isError, true);
  assert.equal((await call('get_library_program', fake({ getProgramById: async () => null }), { programId })).isError, true);
});

test('API failures, malformed index bodies and missing private transport return MCP errors', async () => {
  for (const name of names.slice(0, 2)) {
    for (const client of [fake({}), catalog(null).client, catalog({ workouts: [] }).client, fake({ httpClient: { request: async () => { throw new Error('synthetic endpoint unavailable'); } } })]) {
      assert.equal((await call(name, client)).isError, true);
    }
  }
  for (const name of names.slice(2)) {
    const client = fake({ getWorkoutById: async () => { throw new Error('synthetic detail unavailable'); }, getProgramById: async () => { throw new Error('synthetic detail unavailable'); } });
    const response = await call(name, client, name.endsWith('workout') ? { workoutId } : { programId });
    assert.equal(response.isError, true);
    assert.match(JSON.stringify(response.content), /synthetic detail unavailable/);
  }
});
