# Guided library API notes

## Read paths and client boundary

- `search_workout_library` fetches the full published index at `GET /v6/workouts`.
- `search_program_library` fetches the full published index at `GET /v6/programs`.
- `get_library_workout` uses the client's public `getWorkoutById` for `GET /v6/workouts/{id}`.
- `get_library_program` uses the client's public `getProgramById` for `GET /v6/programs/{id}`.

The client 0.6.0 declarations make `httpClient` private, although its implementation exposes an ordinary runtime property. `src/services/library-service.ts` contains one narrow cast, checks the transport at runtime, and permits only the two fixed index paths with explicit `GET`. Missing transport or malformed responses produce MCP error responses. Replace the adapter when the client adds public full-index methods. There are no new credentials or direct authentication code.

`/explore/workouts` and `/explore/programs` are curated previews, not full indexes. These tools never use them. They do not call user-workout writes, enrollment, scheduling, duration estimation or device endpoints.

## Search arguments

Both searches accept:

| Argument | Meaning |
| --- | --- |
| `query` | Case-insensitive substring in title, name, description or short description. Empty string means no text restriction. |
| `difficulty` | Case-insensitive exact `level` metadata. |
| `supportedDevices` | Array of device metadata strings. Any requested value must match. Unknown metadata does not match. |
| `mobileFriendly` | Require an explicit true or false metadata value. Unknown is not false. |
| `limit` | Integer from 1 to 50, default 10. Invalid values fail, not clamp. |
| `offset` | Non-negative safe integer, default 0, applied after filtering and sorting. |

Workout search also accepts:

| Argument | Meaning |
| --- | --- |
| `targetArea` | Case-insensitive exact target-area metadata. |
| `minDurationMinutes` | Inclusive lower bound, finite non-negative minutes. Fractions are allowed. |
| `maxDurationMinutes` | Inclusive upper bound, finite non-negative minutes. Must not be less than the minimum. |
| `equipment` | Array of required accessory/equipment metadata strings. All requested values must match. This is not a list of equipment you own and does not exclude other required accessories. |

Program search also accepts positive safe integer `weeks` and `workoutsPerWeek`, each matched exactly against index metadata. It never infers session counts from `workouts.length`, which can be zero in an index entry even when details have sessions.

String filters match API metadata, not a maintained enum of supported devices or difficulty labels. Arrays must contain only non-empty strings; empty arrays mean no filter. Null arguments, wrong types, unknown argument names and invalid numbers produce validation errors before client initialization. Unknown or null metadata is safe to display but cannot satisfy an explicit filter.

Every search fetches the index, filters locally, sorts by case-insensitive title/name in locale-independent lexical order, then exact ID, and slices one page. Exact duplicate sort keys retain API order. No catalog size is hardcoded or cached. Repeating a search can see a changed catalog, so pagination is not a snapshot guarantee.

Search responses are JSON in a single MCP text block:

```json
{
  "total": 0,
  "returned": 0,
  "offset": 0,
  "limit": 10,
  "has_more": false,
  "results": []
}
```

This is an illustrative empty response, not account data. `total` counts all matching index rows, `returned` counts this page, and `has_more` means matching rows exist beyond this page. An offset past the end returns zero rows while retaining the matching total. Results use allowlisted summary fields, IDs, compatibility metadata and descriptions capped at 300 characters. They omit media URLs and prescribed sets.

## Examples

Search for beginner upper-body sessions with a duration from 15 to 25 minutes:

```json
{
  "query": "strength",
  "difficulty": "Beginner",
  "targetArea": "UPPER BODY",
  "minDurationMinutes": 15,
  "maxDurationMinutes": 25,
  "limit": 10,
  "offset": 0
}
```

Use metadata values returned by search when adding equipment or device filters. For a subsequent page, keep all filters and increase offset by the returned count.

Search for a four-week program with three workouts per week:

```json
{ "weeks": 4, "workoutsPerWeek": 3, "limit": 10 }
```

Inspect one returned workout with `get_library_workout`:

```json
{ "workoutId": "00000000-0000-4000-8000-000000000001" }
```

Inspect one returned program with `get_library_program`:

```json
{ "programId": "00000000-0000-4000-8000-000000000002" }
```

These IDs are synthetic examples. Replace them with literal search result IDs. Detail tools require the exact 36-character UUID representation and reject whitespace, URLs, paths and query strings. They do not trim, lowercase or repair identifiers. Validation happens before authentication/client initialization and again in direct handler calls.

## Details and limitations

Workout details include prescribed sets in their API array order, with movement IDs, block numbers, reps or durations, weight percentages and available programming flags. `order` is a 1-based array position, not a rewritten block number. Set duration values remain seconds and weight percentages are not pounds. Missing sets are null, not proof of an empty workout. These are prescriptions, not completed activity results. Use workout-activity tools for performed training.

Program details include `weeks`, `workoutsPerWeek`, the supplied boolean `cadence`, `programWorkoutIds` and sessions with workout IDs, supplied workout numbers, program week/day and available session compatibility. Live API responses use workout IDs in `programWorkoutIds`; the reader also tolerates explicit session-record IDs by matching linked fields. Each session record is consumed once. Repeated workout references consume distinct records in workout-number order, so repeated workouts remain separate scheduled slots without doubling the list. Unlisted session records follow in their API order. Without the reference list, sessions sort by `workoutNumber`; without session records, known references resolve against the `workouts` array. Unknown references remain explicit as `unresolvedReferenceId` with a null workout ID, rather than guessing their type. The tool never invents dates for a missing schedule. Fetch individual workout details separately for prescribed sets.

Publication is not a guarantee that a workout is playable on a particular machine. Compatibility fields are reported metadata, not a device handshake or entitlement check. Unknown compatibility is not approval. Search indexes may not include full metadata. Inspect details and verify availability in Tonal before training.

All four tools have `readOnlyHint: true` and `destructiveHint: false`. Existing write tools remain available in the server and are unchanged. A consuming integration must explicitly expose these tools through its own allowlist; this feature does not update, reload or activate any integration.

## Offline verification

Tests use only synthetic records and mocked client methods. They cover registration, MCP listing/dispatch, validation before client initialization, paging/counts, case-insensitive matching, duration units, null metadata, compatibility, prescribed set order, program schedules and API errors. No live Tonal authentication or API smoke test is part of these tests.

Run `npm ci --ignore-scripts --no-audit --no-fund`, `npm run build`, `npm run typecheck`, `npm test` and `npm audit --omit=dev`. This fork tracks the npm lockfile for reproducible local and GitHub Actions verification, unlike the upstream ignore policy. No dependency ranges, author attribution or license were changed.
