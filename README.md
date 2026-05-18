# trainspotter-mcp

An MCP server for UK train tracking and fare search. Wraps the Darwin LDBWS, HSP, and BR Fares APIs into tools that Claude (or any MCP client) can call.

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

## Development

```bash
npm run dev     # run with tsx
npm run build   # compile typescript
npm test        # run tests (vitest)
```

104 tests covering SOAP XML parsing, fare response handling, station lookups, and delay calculation edge cases.

## Darwin Evolution (heads up)

NRE is migrating Darwin to a new system mid-2026. If the LDBWS endpoint changes, `DarwinClient` takes a custom URL so it shouldn't require a rewrite. Check [raildata.org.uk](https://raildata.org.uk) if things stop working.

## License

MIT
