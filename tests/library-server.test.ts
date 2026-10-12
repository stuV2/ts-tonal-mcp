import assert from 'node:assert/strict';
import test from 'node:test';
import type TonalClient from '@dlwiest/ts-tonal-client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TonalMCPServer } from '../src/server.js';

// In-process MCP connection only. Replace getClient before connecting so this
// test cannot authenticate or contact Tonal, even if credentials exist in env.
test('MCP lists library tools, validates before client initialization and dispatches mock GETs', async () => {
  const application = new TonalMCPServer();
  const internals = application as unknown as {
    server: Server;
    tonalService: { getClient(): Promise<TonalClient> };
  };
  let clientInitializations = 0;
  const requests: unknown[][] = [];
  internals.tonalService.getClient = async () => {
    clientInitializations++;
    return { httpClient: { request: async (...args: unknown[]) => {
      requests.push(args);
      return [{ id: '00000000-0000-4000-8000-000000000001', title: 'Synthetic MCP session' }];
    } } } as unknown as TonalClient;
  };
  const connection = new Client({ name: 'synthetic-library-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([internals.server.connect(serverTransport), connection.connect(clientTransport)]);
    const listed = await connection.listTools();
    for (const name of ['search_workout_library', 'search_program_library', 'get_library_workout', 'get_library_program']) {
      const definition = listed.tools.find(tool => tool.name === name);
      assert.ok(definition);
      assert.equal(definition.annotations?.readOnlyHint, true);
      assert.equal(definition.annotations?.destructiveHint, false);
    }
    for (const [name, args] of [
      ['get_library_workout', { workoutId: 'bad-uuid' }],
      ['get_library_program', { programId: ' /programs/not-a-uuid' }],
      ['search_workout_library', { limit: 51 }],
      ['search_program_library', { weeks: 1.5 }],
    ] as const) {
      const result = await connection.callTool({ name, arguments: args });
      assert.equal(result.isError, true);
    }
    assert.equal(clientInitializations, 0);
    assert.equal(requests.length, 0);
    const result = await connection.callTool({ name: 'search_workout_library', arguments: {} });
    assert.notEqual(result.isError, true);
    assert.equal(clientInitializations, 1);
    assert.deepEqual(requests, [['/workouts', { method: 'GET' }]]);
  } finally {
    await connection.close();
    await internals.server.close();
  }
});
