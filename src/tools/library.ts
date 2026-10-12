import type TonalClient from '@dlwiest/ts-tonal-client';
import type { MCPResponse, MCPToolDefinition } from '../types/index.js';
import { LibraryRecord, libraryRecord, programLibrary, workoutLibrary } from '../services/library-service.js';
import { TonalMCPError, handleToolError } from '../utils/error-handler.js';

type Args = Record<string, unknown>;
const uuidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
function invalid(message: string): never {
  throw new TonalMCPError(message, 'VALIDATION_ERROR', 400);
}
function validateArgs(args: Args | undefined, properties: Args): Args {
  if (args === undefined) return {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) invalid('Arguments must be an object');
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(properties, key)) invalid(`Unknown library argument: ${key}`);
  }
  return args;
}
function numberArg(args: Args, key: string, min: number, max = Number.MAX_SAFE_INTEGER, integer = true): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max ||
      (integer && !Number.isSafeInteger(value))) invalid(`${key} must be ${integer ? 'an integer' : 'a finite number'} between ${min} and ${max}`);
  return value;
}
function validateSearch(args: Args | undefined, kind: 'workout' | 'program'): void {
  const input = validateArgs(args, kind === 'workout' ? workoutProperties : programProperties);
  numberArg(input, 'limit', 1, 50);
  numberArg(input, 'offset', 0);
  for (const key of ['query', 'difficulty', ...(kind === 'workout' ? ['targetArea'] : [])]) {
    const value = input[key];
    if (value !== undefined && (typeof value !== 'string' || (key !== 'query' && !value.trim()))) invalid(`${key} must be ${key === 'query' ? 'a string' : 'a non-empty string'}`);
  }
  for (const key of ['supportedDevices', ...(kind === 'workout' ? ['equipment'] : [])]) {
    const value = input[key];
    if (value !== undefined && (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v.trim()))) invalid(`${key} must be an array of non-empty strings`);
  }
  if (input.mobileFriendly !== undefined && typeof input.mobileFriendly !== 'boolean') invalid('mobileFriendly must be a boolean');
  if (kind === 'workout') {
    const min = numberArg(input, 'minDurationMinutes', 0, Number.MAX_SAFE_INTEGER / 60, false);
    const max = numberArg(input, 'maxDurationMinutes', 0, Number.MAX_SAFE_INTEGER / 60, false);
    if (min !== undefined && max !== undefined && min > max) invalid('minDurationMinutes must not exceed maxDurationMinutes');
  } else {
    numberArg(input, 'weeks', 1);
    numberArg(input, 'workoutsPerWeek', 1);
  }
}
function detailId(args: Args | undefined, key: string): string {
  const input = validateArgs(args, { [key]: true });
  const id = input[key];
  // Do not trim, repair, encode or lowercase identifiers. Validate the literal.
  if (typeof id !== 'string' || id.length !== 36 || !new RegExp(uuidPattern).test(id)) invalid(`${key} must be a literal UUID`);
  return id;
}
const text = (value: unknown): string | null => typeof value === 'string' ? value : null;
const numeric = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const boolean = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null;
function strings(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : null;
}
const lower = (value: unknown): string => text(value)?.toLowerCase() ?? '';
const clipped = (value: unknown): string | null => text(value)?.slice(0, 300) ?? null;
const minutes = (value: unknown): number | null => numeric(value) === null ? null : (value as number) / 60;
function compatibility(row: Args) {
  return {
    supportedDevices: strings(row.supportedDevices), mobileFriendly: boolean(row.mobileFriendly),
    featureGroupIds: strings(row.featureGroupIds),
  };
}
function summary(row: LibraryRecord, kind: 'workout' | 'program') {
  const common = {
    id: row.id, title: text(row.title) ?? text(row.name), description: clipped(row.description),
    difficulty: text(row.level), publishState: text(row.publishState), ...compatibility(row),
  };
  return kind === 'workout' ? {
    ...common, targetArea: text(row.targetArea), durationMinutes: minutes(row.duration),
    equipment: strings(row.accessories) ?? strings(row.equipment),
  } : { ...common, weeks: numeric(row.weeks), workoutsPerWeek: numeric(row.workoutsPerWeek) };
}
function matches(row: LibraryRecord, args: Args, kind: 'workout' | 'program'): boolean {
  if (args.query !== undefined && ![row.title, row.name, row.description, row.shortDescription].some(v => lower(v).includes(lower(args.query)))) return false;
  if (args.difficulty !== undefined && lower(row.level) !== lower(args.difficulty)) return false;
  if (args.mobileFriendly !== undefined && boolean(row.mobileFriendly) !== args.mobileFriendly) return false;
  const devices = args.supportedDevices as string[] | undefined;
  if (devices?.length && !devices.some(d => strings(row.supportedDevices)?.some(v => lower(v) === lower(d)))) return false;
  if (kind === 'program') {
    return (args.weeks === undefined || numeric(row.weeks) === args.weeks) &&
      (args.workoutsPerWeek === undefined || numeric(row.workoutsPerWeek) === args.workoutsPerWeek);
  }
  if (args.targetArea !== undefined && lower(row.targetArea) !== lower(args.targetArea)) return false;
  const duration = numeric(row.duration);
  // Convert user minutes to API seconds; don't round before comparing boundaries.
  if (args.minDurationMinutes !== undefined && (duration === null || duration < (args.minDurationMinutes as number) * 60)) return false;
  if (args.maxDurationMinutes !== undefined && (duration === null || duration > (args.maxDurationMinutes as number) * 60)) return false;
  const equipment = args.equipment as string[] | undefined;
  const available = strings(row.accessories) ?? strings(row.equipment);
  return !equipment?.length || equipment.every(e => available?.some(v => lower(v) === lower(e)));
}
// Locale-independent lexical order, then exact ID. Array order breaks exact ties.
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
function response(value: unknown): MCPResponse {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}
async function search(client: TonalClient, args: Args | undefined, kind: 'workout' | 'program'): Promise<MCPResponse> {
  const name = `search_${kind}_library`;
  try {
    validateSearch(args, kind);
    const input = args ?? {};
    const limit = input.limit as number | undefined ?? 10;
    const offset = input.offset as number | undefined ?? 0;
    const rows = await (kind === 'workout' ? workoutLibrary(client) : programLibrary(client));
    const filtered = rows.filter(row => matches(row, input, kind)).sort((a, b) =>
      compare(lower(a.title ?? a.name), lower(b.title ?? b.name)) || compare(a.id, b.id));
    const results = filtered.slice(offset, offset + limit).map(row => summary(row, kind));
    return response({ total: filtered.length, returned: results.length, offset, limit,
      has_more: offset + results.length < filtered.length, results });
  } catch (error) { return handleToolError(error, name); }
}
export function searchWorkoutLibrary(client: TonalClient, args?: Args): Promise<MCPResponse> {
  return search(client, args, 'workout');
}
export function searchProgramLibrary(client: TonalClient, args?: Args): Promise<MCPResponse> {
  return search(client, args, 'program');
}
const setFields = [
  'id', 'movementId', 'blockNumber', 'blockStart', 'prescribedReps', 'prescribedDuration',
  'repetition', 'repetitionTotal', 'weightPercentage', 'durationBasedRepGoal', 'setGroup',
  'round', 'warmUp', 'dropSet', 'burnout', 'spotter', 'eccentric', 'chains', 'skipSetup',
  'skipDemo', 'finalSet', 'calibration', 'practice', 'flex', 'progressive',
];
function object(value: unknown): Args {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Args : {};
}
function prescribedSet(value: unknown, order: number): Args {
  const row = object(value);
  const result: Args = { order: order + 1 };
  for (const key of setFields) {
    const value = row[key];
    if (typeof value === 'string' || typeof value === 'boolean' || numeric(value) !== null || value === null) result[key] = value;
  }
  // Always retain explicit unknown movement identity instead of implying completeness.
  result.movementId = text(row.movementId);
  result.description = clipped(row.description);
  return result;
}
export async function getLibraryWorkout(client: TonalClient, args?: Args): Promise<MCPResponse> {
  try {
    const id = detailId(args, 'workoutId');
    const row = libraryRecord(await client.getWorkoutById(id));
    return response({ ...summary(row, 'workout'),
      note: 'Prescribed sets in API array order, not completed training. Publication does not guarantee playback on your machine. Unknown compatibility is not approval.',
      sets: Array.isArray(row.sets) ? row.sets.map(prescribedSet) : null });
  } catch (error) { return handleToolError(error, 'get_library_workout'); }
}
function programSessions(row: LibraryRecord): Args[] {
  const sessions = Array.isArray(row.programWorkouts) ? row.programWorkouts.map(object) : [];
  const workouts = Array.isArray(row.workouts) ? row.workouts.map(object) : [];
  const ids = strings(row.programWorkoutIds);
  // Live responses reference workout IDs here; tolerate session-record IDs too.
  // Match explicit linked fields, consume each record once, and never infer an
  // unknown reference's type from its shape. Repeated workouts are separate slots.
  let ordered: Args[];
  if (ids?.length) {
    const consumed = new Set<number>();
    const candidates = sessions.map((_, index) => index).sort((a, b) =>
      (numeric(sessions[a].workoutNumber) ?? Infinity) - (numeric(sessions[b].workoutNumber) ?? Infinity));
    ordered = ids.map(id => {
      const exact = candidates.find(index => !consumed.has(index) && sessions[index].id === id);
      const index = exact ?? candidates.find(index => !consumed.has(index) && sessions[index].workoutId === id);
      if (index !== undefined) {
        consumed.add(index);
        return sessions[index];
      }
      const workout = workouts.find(w => w.id === id);
      return workout ? {
        workoutId: workout.id, workoutTitle: workout.title ?? workout.name,
        duration: workout.duration, workoutNumber: workout.workoutNumber,
        programWeek: workout.programWeek, programDay: workout.programDay,
      } : { id, unresolvedReferenceId: id };
    });
    ordered.push(...sessions.filter((_, index) => !consumed.has(index)));
  } else if (sessions.length) {
    ordered = sessions.slice().sort((a, b) => (numeric(a.workoutNumber) ?? Infinity) - (numeric(b.workoutNumber) ?? Infinity));
  } else {
    ordered = workouts.map(w => ({ workoutId: w.id, workoutTitle: w.title ?? w.name, duration: w.duration }));
  }
  return ordered.map((session, index) => {
    const workout = workouts.find(w => w.id === session.workoutId);
    return {
      order: index + 1, id: text(session.id), workoutId: text(session.workoutId),
      unresolvedReferenceId: text(session.unresolvedReferenceId),
      title: text(session.workoutTitle) ?? text(workout?.title) ?? text(workout?.name),
      workoutNumber: numeric(session.workoutNumber), programWeek: numeric(session.programWeek),
      programDay: numeric(session.programDay), durationMinutes: minutes(session.duration ?? workout?.duration),
      ...compatibility(workout ?? {}),
    };
  });
}
export async function getLibraryProgram(client: TonalClient, args?: Args): Promise<MCPResponse> {
  try {
    const id = detailId(args, 'programId');
    const row = libraryRecord(await client.getProgramById(id));
    return response({ ...summary(row, 'program'),
      note: 'Prescribed program sessions, not enrollment or completed training. Order uses programWorkoutIds when present, then workoutNumber, then the workouts array. Schedule values are reported as supplied; unknown values are null. Publication does not guarantee playback on your machine.',
      cadence: Array.isArray(row.cadence) ? row.cadence.map(boolean) : null,
      programWorkoutIds: strings(row.programWorkoutIds), sessions: programSessions(row) });
  } catch (error) { return handleToolError(error, 'get_library_program'); }
}

const stringSchema = { type: 'string', minLength: 1 };
const arraySchema = { type: 'array', items: stringSchema, description: 'Case-insensitive exact metadata values. Empty array means no filter.' };
const commonProperties = {
  query: { type: 'string', description: 'Case-insensitive substring in title, name or description.' },
  difficulty: { ...stringSchema, description: 'Case-insensitive exact level metadata, e.g. Beginner.' },
  supportedDevices: { ...arraySchema, description: 'Require any listed supported device. Unknown metadata does not match.' },
  mobileFriendly: { type: 'boolean', description: 'Require an explicit mobileFriendly value. Unknown does not match.' },
  limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
  offset: { type: 'integer', minimum: 0, default: 0, description: 'Offset after local filtering and title/ID sorting.' },
};
const workoutProperties = {
  ...commonProperties,
  targetArea: { ...stringSchema, description: 'Case-insensitive exact targetArea metadata.' },
  minDurationMinutes: { type: 'number', minimum: 0, maximum: Number.MAX_SAFE_INTEGER / 60, description: 'Inclusive minimum duration in minutes, converted to API seconds.' },
  maxDurationMinutes: { type: 'number', minimum: 0, maximum: Number.MAX_SAFE_INTEGER / 60, description: 'Inclusive maximum duration in minutes, converted to API seconds.' },
  equipment: { ...arraySchema, description: 'Require all listed accessories/equipment, not a list of equipment you own.' },
};
const programProperties = {
  ...commonProperties,
  weeks: { type: 'integer', minimum: 1, description: 'Exact number of weeks in index metadata.' },
  workoutsPerWeek: { type: 'integer', minimum: 1, description: 'Exact weekly workout count in index metadata, not index workouts array length.' },
};
const annotations = { readOnlyHint: true, destructiveHint: false };
export const libraryTools: MCPToolDefinition[] = [
  { name: 'search_workout_library', description: 'Search the full published workout index with local filters and bounded summaries. Not workout history; publication does not guarantee machine playback.',
    inputSchema: { type: 'object', properties: workoutProperties, required: [], additionalProperties: false }, annotations,
    validateArgs: args => validateSearch(args, 'workout'), handler: searchWorkoutLibrary },
  { name: 'search_program_library', description: 'Search the full published program index with local filters and bounded summaries. Index workouts may be empty; use get_library_program for sessions.',
    inputSchema: { type: 'object', properties: programProperties, required: [], additionalProperties: false }, annotations,
    validateArgs: args => validateSearch(args, 'program'), handler: searchProgramLibrary },
  { name: 'get_library_workout', description: 'Read a library workout by literal UUID, including ordered prescribed sets and movement IDs. Not a completed activity; does not start, modify or schedule workouts.',
    inputSchema: { type: 'object', properties: { workoutId: { type: 'string', format: 'uuid', pattern: uuidPattern, minLength: 36, maxLength: 36 } }, required: ['workoutId'], additionalProperties: false }, annotations,
    validateArgs: args => { detailId(args, 'workoutId'); }, handler: getLibraryWorkout },
  { name: 'get_library_program', description: 'Read a library program by literal UUID, with ordered sessions, workout IDs and supplied schedule. Does not enroll or schedule; unknown compatibility is not approval.',
    inputSchema: { type: 'object', properties: { programId: { type: 'string', format: 'uuid', pattern: uuidPattern, minLength: 36, maxLength: 36 } }, required: ['programId'], additionalProperties: false }, annotations,
    validateArgs: args => { detailId(args, 'programId'); }, handler: getLibraryProgram },
];
