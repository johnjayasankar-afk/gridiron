# Sportradar fixtures

These JSON files are **hand-written for tests**. They are **not captured API responses**. Nobody has called Sportradar's API for them, and nothing in Gridiron's Sportradar adapter has been checked against a real response.

They follow the shapes described in Sportradar's public developer documentation for the NFL v7 and NCAA Football v7 APIs, checked on 2026-09-14:

- Developer documentation: https://developer.sportradar.com
- NFL v7 feeds: `https://api.sportradar.com/nfl/official/{access_level}/v7/en/{feed}.json`
- NCAA Football v7 feeds: `https://api.sportradar.com/ncaafb/{access_level}/v7/en/{feed}.json`

## Files

| File | Feed it imitates | Contents |
| --- | --- | --- |
| `nfl-week-schedule.json` | `games/{season_year}/{PRE,REG,PST}/{week}/schedule.json` | `week.games[]` with one closed, one in-progress and one scheduled game |
| `nfl-boxscore-inprogress.json` | `games/{game_id}/boxscore.json` | The in-progress game, with a situation |
| `nfl-pbp-inprogress.json` | `games/{game_id}/pbp.json` | The same game: two drives with a touchdown pass, an extra point, a penalty and a timeout event |

## What is made up

- **Teams.** Harbor City Gulls, Red Mesa Coyotes, Lakeport Pilots, Iron Valley Forge, Bayshore Tides and Summit Peaks are fictional, so no score here can be mistaken for a real result.
- **Ids.** Every UUID is a placeholder with an obvious pattern. None is a Sportradar id.
- **Plays, times and scores.** Invented to exercise the normalizer.
- **`details[].category` values.** The documentation names the field but these values are placeholders. Gridiron does not read `category`.
- **Event fields.** Only `event_type` is documented for event items. The `id`, `sequence`, `clock`, `wall_clock` and `description` on the timeout event assume the same names as on plays.
- **Anything not listed in the documented shapes** is left out rather than guessed.

The season schedule feed (`games/current_season/schedule.json`) is what the provider reads, but its container shape is not in the documented facts, so there is no fixture for it. The parser reads every `games` list in a schedule document, and the tests use the weekly fixture for it.
