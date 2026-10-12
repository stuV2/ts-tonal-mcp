import type TonalClient from '@dlwiest/ts-tonal-client';
import { TonalMCPError } from '../utils/error-handler.js';

// Index metadata can be absent/null despite the client's stricter detail declarations.
// Only id is mandatory; tools project the remaining unknown fields explicitly.
export interface LibraryRecord {
  id: string;
  [field: string]: unknown;
}
type LibraryEndpoint = '/workouts' | '/programs';
interface LibraryTransport {
  request(endpoint: LibraryEndpoint, options: { method: 'GET' }): Promise<unknown>;
}

export function libraryRecord(value: unknown): LibraryRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !('id' in value) || typeof value.id !== 'string' || !value.id) {
    throw new TonalMCPError('Invalid library record returned by Tonal', 'API_RESPONSE_ERROR');
  }
  return value as LibraryRecord;
}

/**
 * Client 0.6.0 has no public full-index methods. Its TypeScript-private httpClient
 * is an ordinary runtime property. Keep the single cast here, check it at runtime,
 * and restrict this adapter to two fixed GET paths. Never expose a caller path.
 * Existing public methods handle details. Revisit when the client adds indexes.
 */
async function index(client: TonalClient, endpoint: LibraryEndpoint): Promise<LibraryRecord[]> {
  const transport = (client as unknown as { httpClient?: LibraryTransport }).httpClient;
  if (!transport || typeof transport.request !== 'function') {
    throw new TonalMCPError('Tonal client library transport is unavailable; check client compatibility', 'CLIENT_COMPATIBILITY_ERROR');
  }
  const response = await transport.request(endpoint, { method: 'GET' });
  if (!Array.isArray(response)) {
    throw new TonalMCPError('Expected a full library array from Tonal', 'API_RESPONSE_ERROR');
  }
  return response.map(libraryRecord);
}
export function workoutLibrary(client: TonalClient): Promise<LibraryRecord[]> {
  return index(client, '/workouts');
}
export function programLibrary(client: TonalClient): Promise<LibraryRecord[]> {
  return index(client, '/programs');
}
