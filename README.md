# trainspotter-mcp

An MCP server for UK train tracking and fare search. Wraps the Darwin LDBWS, HSP, and BR Fares APIs, plus the Uber Travel (Omio) price search, into tools that Claude (or any MCP client) can call.

Built this because I kept asking "is my train delayed?" and "how much is a ticket to Leeds?" in separate browser tabs. Now I can ask my AI assistant instead.

## What it does

**Real-time tracking** (Darwin LDBWS)
- Live departure and arrival boards for any UK station
- Full service details with every calling point and delay prediction
- Station-to-station train search
- Disruption messages
- 825 stations with fuzzy name search

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
- `TSU` -- Two Together
- `SRN` -- Senior
- `FAM` -- Family & Friends
- `DIS` -- Disabled Persons
- `NGC` -- Network Railcard
- `HMF` -- HM Forces
- `JCP` -- Jobcentre Plus

## Uber Travel (Omio) price search notes

`search_omio_fares` asks the search behind [travel.uber.com](https://travel.uber.com), which is run on Omio's inventory. It answers a different question from `search_fares`: not "which fares exist on this route" but "what does each train or coach on this date cost right now". It needs no API key and has no monthly quota, so it works well as a second opinion next to `search_fares`.

**Read this before relying on it:**

- **It is an undocumented API.** Nobody has promised it will keep working. Uber can change or remove it at any time, and when the response shape changes the tools fail with an explicit "response did not match the expected shape" error instead of guessing.
- **Prices are list prices at search time, not a booking.** Nothing is reserved or held. The price can change, or the fare can sell out, between the search and a purchase. Always confirm on the retailer's own site before quoting a price to someone.
- **It is not a full-day timetable.** Trains come back for roughly five hours from `time` (default 06:00). Search again with a later `time` for the rest of the day. Coaches come back for the rest of the day in one go.
- **Coaches use their own stops.** A coach row shows the stop it really leaves from, which is usually not the rail station you searched.

Arguments: `from` and `to` take a CRS code (`LPY`) or a place name (`Liverpool`). A CRS code only ever resolves to the station with that name; if Uber Travel lists it under a different name the search stops with an error instead of guessing. `date` is `YYYY-MM-DD`; optional `time` (`HH:MM`, UK local), `modes` (`train`, `coach`), `railcards` (one code), `age` and `direct_only`. If a place does not resolve, `omio_locations` shows the names Uber Travel knows.

Railcard codes accepted by `search_omio_fares` (one per search): `YNG` 16-25, `TST` 26-30, `TSU` 16-17 Saver, `SRN` Senior, `2TR` Two Together, `FAM` Family & Friends, `DIS` Disabled Persons, `DIC` Disabled Child, `HMF` HM Forces, `VET` Veterans, `NEW` Network Railcard, `NGC` Gold Card, `JCP` Jobcentre Plus.

Example output:

```
Uber Travel (Omio) prices: Liverpool South Parkway → London Euston, Sat 30 Jan 2027 from 10:00
Trains cover departures 10:00-14:58. Search again with a later time for later trains. Coaches cover the rest of the day.

dep→arr | from → to | changes | operator | mode | price
10:54→13:03 | Liverpool South Parkway → London Euston | direct | Avanti West Coast | train | £41.00
10:58→13:30 | Liverpool South Parkway → London Euston | 1 change at Runcorn | Transport for Wales + Avanti West Coast | train | £39.00 | split ticket, saves £74.00
11:00→18:10 | Liverpool, One Bus Station, Canning Place → London, Victoria Coach Station | direct | National Express | coach | £7.40
```

The client is deliberately gentle with a service that never offered an API: one search at a time, polling once a second (the first results get 20 seconds, the whole search 35), at most two requests for later trains, a five-minute result cache, and no retries. Please keep it that way.

## Development

```bash
npm run dev     # run with tsx
npm run build   # compile typescript
npm test        # run tests (vitest)

# opt-in: one real search against Uber Travel
OMIO_LIVE=1 npx vitest run test/omio.live.test.ts
```

Around 200 tests covering SOAP XML parsing, fare response handling, station lookups, delay calculation edge cases, and Uber Travel response parsing against fixtures cut from a sanitized browser capture.

## Darwin Evolution (heads up)

NRE is migrating Darwin to a new system mid-2026. If the LDBWS endpoint changes, `DarwinClient` takes a custom URL so it shouldn't require a rewrite. Check [raildata.org.uk](https://raildata.org.uk) if things stop working.

## License

MIT
