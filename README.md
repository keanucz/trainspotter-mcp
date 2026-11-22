# trainspotter-mcp

An MCP server for UK train tracking and fare search. Wraps the Darwin LDBWS, HSP, and BR Fares APIs, plus the Uber Travel (Omio) price search, into tools that Claude (or any MCP client) can call.

Built this because I kept asking "is my train delayed?" and "how much is a ticket to Leeds?" in separate browser tabs. Now I can ask my AI assistant instead.

## What it does

**Real-time tracking** (Darwin LDBWS)
- Live departure and arrival boards for any UK station
- Full service details with every calling point and delay prediction
- Station-to-station train search
- Disruption messages
- All 2,610 National Rail stations in Great Britain, with fuzzy name search

**Historical performance** (HSP)
- Delay statistics between any two stations
- On-time percentages, cancellation rates, average delays
- Configurable time range (default 28 days)

**Fare search** (BR Fares Easy Fares API)
- Walk-up, advance, and pay-as-you-go fares between any two stations
- Railcard support (16-25, Two Together, Senior, etc. -- up to 3 per search)
- All UK fares from the National Rail database, updated daily
- Free demo tier: 100 searches per month

**Per-departure prices** (Uber Travel, Omio-backed, unofficial)
- Train and coach prices for a given date and time, one row per departure
- Advance fares as currently priced, split tickets, National Express coaches
- No API key and no monthly quota
- Undocumented API: see [the caveats](#uber-travel-omio-price-search-notes)

## Tools

| Tool | What it does |
|------|-------------|
| `get_departures` | Live departure board for a station |
| `get_arrivals` | Live arrival board |
| `get_service_details` | Full journey details for a specific train |
| `search_trains` | Find trains between two stations |
| `get_disruptions` | Current disruption messages |
| `get_delay_history` | Historical delay stats (HSP) |
| `get_station_info` | Look up station CRS codes by name |
| `search_fares` | Search fares between two stations |
| `list_railcards` | List available railcard codes |
| `list_fare_locations` | List stations with fare data |
| `search_rtt` | Departures for any date via Realtime Trains (past 14 days to weeks ahead) |
| `get_rtt_service` | Calling points of one train on one date via Realtime Trains |
| `search_omio_fares` | Train and coach prices per departure for a date via Uber Travel (Omio). Unofficial, no key needed |
| `omio_locations` | Look up the stations, coach stops and cities Uber Travel knows for a name |

## Setup

```bash
git clone https://github.com/keanucz/trainspotter-mcp.git
cd trainspotter-mcp
npm install
npm run build
```

### API keys

You need at least the LDBWS token. The others are optional depending on which tools you want.

| Variable | Where to get it | Required for |
|----------|----------------|-------------|
| `LDBWS_TOKEN` | [NRE OpenLDBWS registration](https://realtime.nationalrail.co.uk/OpenLDBWSRegistration) | Departures, arrivals, service details |
| `OPENRAIL_USERNAME` | [Rail Data Marketplace](https://raildata.org.uk) | HSP delay history |
| `OPENRAIL_PASSWORD` | Same as above | HSP delay history |
| `BRFARES_API_KEY` | [Rail Data Marketplace](https://raildata.org.uk) -- subscribe to Easy Fares API (Demo) | Fare search |
| `RTT_API_TOKEN` | [Realtime Trains API portal](https://api-portal.rtt.io) -- free tier, 10 requests/min | `search_rtt`, `get_rtt_service` (any-date timetables) |

### Claude Code

Add to `~/.claude/.mcp.json`:

```json
{
  "mcpServers": {
    "trainspotter": {
      "command": "node",
      "args": ["/path/to/trainspotter-mcp/dist/index.js"],
      "env": {
        "LDBWS_TOKEN": "your-token",
        "BRFARES_API_KEY": "your-key",
        "OPENRAIL_USERNAME": "your-email",
        "OPENRAIL_PASSWORD": "your-password"
      }
    }
  }
}
```

### Claude Desktop

Same idea, add to your Claude Desktop MCP config.

## Station codes

Stations use 3-letter CRS codes. Some common ones:

| Code | Station |
|------|---------|
| KGX | London Kings Cross |
| MAN | Manchester Piccadilly |
| LDS | Leeds |
| EDB | Edinburgh Waverley |
| BHM | Birmingham New Street |
| BRI | Bristol Temple Meads |

Don't know the code? Use `get_station_info` with a name like "Manchester" and it'll fuzzy-match.

## Fare search notes

The BR Fares API returns all fares from the National Rail database. Prices are walk-up and advance *base fares* -- not live availability. The API can't tell you whether a specific advance fare has seats left on a specific train. It can tell you the fare exists and what it costs.

Common railcard codes for `search_fares`:
- `YNG` -- 16-25 Railcard
- `TST` -- 26-30 Railcard
- `TSU` -- 16-17 Saver
- `2TR` -- Two Together
- `SRN` -- Senior
- `FAM` -- Family & Friends
- `DIS` -- Disabled Persons
- `NEW` -- Network Railcard
- `NGC` -- Annual Gold Card
- `HMF` -- HM Forces
- `VET` -- Veterans
- `JCP` -- Jobcentre Plus

`list_railcards` returns the full list.

## Uber Travel (Omio) price search notes

`search_omio_fares` asks the search behind [travel.uber.com](https://travel.uber.com), which is run on Omio's inventory. It answers a different question from `search_fares`: not "which fares exist on this route" but "what does each train or coach on this date cost right now". It needs no API key and has no monthly quota, so it works well as a second opinion next to `search_fares`.

**Read this before relying on it:**

- **It is an undocumented API.** Nobody has promised it will keep working. Uber can change or remove it at any time, and when it changes the tools fail with an explicit error that says so ("response did not match the expected shape", or "turned the request down before running it") instead of guessing.
- **Prices are list prices at search time, not a booking.** Nothing is reserved or held. The price can change, or the fare can sell out, between the search and a purchase. Always confirm on the retailer's own site before quoting a price to someone.
- **It is not a full-day timetable.** Trains come back for at least `hours` hours from `time` (defaults: 4 hours from 06:00). Raise `hours` (up to 12) or search again with a later `time` for the rest of the day. Coaches come back for the rest of the day in one go.
- **Coaches use their own stops.** A coach row shows the stop it really leaves from, which is usually not the rail station you searched.

Arguments: `from` and `to` take a CRS code (`LPY`) or a place name (`Liverpool`). A CRS code only ever resolves to the station it stands for: a British station that Uber Travel stores under that station's name (compared without regard to case and punctuation) and that stands within a kilometre of where the station is. `WAT` is London Waterloo, never London Waterloo East. If no such station comes back the search stops with an error that names the stations Uber Travel does offer, instead of guessing. Every station in the table was looked up against the live search in November 2026. Of the 2,610, 2,548 are stored under the table's name, 51 under another name (`ABW` as "Abbey Wood Station", `ADL` as "Adlington (Lancs)"; those are looked up by that name first and the table's name second), and 11 are not there at all (newly opened stations such as Ashington, and a few stops with no regular service). Both lists are in `src/omio-station-names.ts`. `date` is `YYYY-MM-DD`; optional `time` (`HH:MM`, UK local), `hours` (1 to 12, default 4), `modes` (`train`, `coach`), `railcards` (one code), `age` and `direct_only`. If a place does not resolve, `omio_locations` shows the names Uber Travel knows.

Railcard codes accepted by `search_omio_fares` (one per search): `YNG` 16-25, `TST` 26-30, `TSU` 16-17 Saver, `SRN` Senior, `2TR` Two Together, `FAM` Family & Friends, `DIS` Disabled Persons, `DIC` Disabled Child, `HMF` HM Forces, `VET` Veterans, `NEW` Network Railcard, `NGC` Gold Card, `JCP` Jobcentre Plus.

Example output:

```
Uber Travel (Omio) prices: Liverpool South Parkway → London Euston, Sat 30 Jan 2027 from 10:00
Trains cover departures 10:00-14:58. For later trains, search again with a later time or a larger hours value. Coaches cover the rest of the day.

dep→arr | from → to | changes | operator | mode | price
10:54→13:03 | Liverpool South Parkway → London Euston | direct | Avanti West Coast | train | £41.00
10:58→13:30 | Liverpool South Parkway → London Euston | 1 change at Runcorn | Transport for Wales + Avanti West Coast | train | £39.00 | split ticket, saves £74.00
11:00→18:10 | Liverpool, One Bus Station, Canning Place → London, Victoria Coach Station | direct | National Express | coach | £7.40
```

The client is deliberately gentle with a service that never offered an API: one search at a time, polling once a second (the first results get 20 seconds, the whole search about 35; the budget is checked between requests, so one slow reply can run it over), only as many extensions for later trains as `hours` needs and never more than ten, a five-minute result cache, and no retries, with one exception: a request the service answers with a gateway error (HTTP 502, 503 or 504, which its front end does now and then while the search behind it is fine) is tried once more after a second, never a third time, and not at all when there is no time left for it in the search's budget. (If such a first try at starting a search did in fact get through, the second leaves an unused search behind on the service's side; the error seen so far says the request never arrived.) Please keep it that way.

How it tells a broken API from a failed search: the server turns down a request that does not fit its schema before running it (HTTP 400: a changed field, a changed input type, a removed enum value, or a move to server-side stored queries). That is reported as a schema change, which means these tools need updating. A search the server ran and could not finish (HTTP 500), such as an expired search, is reported as the plain error it is. The split was checked against the live service with 34 deliberately broken requests: every HTTP 400 that carried an error list was a request that did not fit the schema, and no other kind of failure produced one. It is not complete the other way round: a few changes surface as HTTP 500 (a field the server needs and no longer gets, for example), so if every search starts failing that way, suspect a change as well.

Place names: the location search wants an apostrophe exactly where its stored name has one. A name typed with an apostrophe is tried as typed and then without it. A name typed without one, which the search does not know, is tried once more with an apostrophe put back (`Shepherds Bush` is stored as `Shepherd's Bush`). A fare search remembers an unknown name for a minute, so an immediate retry does not look it up again. `omio_locations` does not use that memory: for a name it has no stored result for, it asks, first as given and then with the same spellings a fare search would try.

## Development

```bash
npm run dev     # run with tsx
npm run build   # compile typescript
npm test        # run tests (vitest)

# opt-in: one real search against Uber Travel
OMIO_LIVE=1 npx vitest run test/omio.live.test.ts

# opt-in, about an hour: look every station code up against Uber Travel, one code a second
OMIO_LIVE_STATIONS=1 npx vitest run test/omio.live.test.ts
# the same for a few codes only
OMIO_LIVE_STATIONS=1 OMIO_LIVE_STATION_CODES=ABW,BIS npx vitest run test/omio.live.test.ts
```

Around 350 tests covering SOAP XML parsing, fare response handling, station lookups, delay calculation edge cases, and Uber Travel response parsing against fixtures cut from a sanitized browser capture.

## Darwin Evolution (heads up)

NRE is migrating Darwin to a new system mid-2026. If the LDBWS endpoint changes, `DarwinClient` takes a custom URL so it shouldn't require a rewrite. Check [raildata.org.uk](https://raildata.org.uk) if things stop working.

## License

The code is MIT.

The station table, `src/station-data.ts` (codes, names and positions of the stations), is data under the [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/). It is derived from the [uk-railway-stations](https://github.com/davwheat/uk-railway-stations) dataset by davwheat, which is derived from [Trainline EU's stations dataset](https://github.com/trainline-eu/stations#licence), whose data come from OpenStreetMap (© OpenStreetMap contributors), SNCF OpenData, GeoNames, Digitraffic.fi, OpenTransportData.swiss and admin.ch. The changes made to it are described at the top of that file.
