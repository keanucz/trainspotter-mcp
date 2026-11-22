import { describe, it, expect } from 'vitest'
import { OmioClient } from '../src/omio.js'
import { formatOmioFares } from '../src/omio-format.js'

// Opt-in: this makes a real search against Uber Travel. Run it with
//   OMIO_LIVE=1 npx vitest run test/omio.live.test.ts
// Optional: OMIO_LIVE_DATE=YYYY-MM-DD (default: four weeks from today).
const live = process.env['OMIO_LIVE'] === '1'

function defaultDate(): string {
  const date = new Date(Date.now() + 28 * 24 * 60 * 60 * 1000)
  return date.toISOString().slice(0, 10)
}

describe.skipIf(!live)('Uber Travel live search', () => {
  it('finds priced Liverpool South Parkway to London Euston trains', async () => {
    const client = new OmioClient()
    const result = await client.searchFares({
      from: 'LPY',
      to: 'EUS',
      date: process.env['OMIO_LIVE_DATE'] ?? defaultDate(),
      time: '10:00',
      modes: ['train'],
    })

    expect(result.origin.name).toBe('Liverpool South Parkway')
    expect(result.destination.name).toBe('London Euston')
    expect(result.journeys.length).toBeGreaterThan(0)
    for (const journey of result.journeys) {
      expect(journey.dep >= `${result.date}T10:00:00`).toBe(true)
      expect(journey.mode).toBe('train')
    }
    expect(result.journeys.some((journey) => journey.pricePence !== null)).toBe(true)
    expect(formatOmioFares(result)).toContain('Liverpool South Parkway → London Euston')
  }, 60_000)
})
