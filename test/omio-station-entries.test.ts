import { describe, it, expect, vi } from 'vitest'

// Made-up tables, so the rule for a station that is listed twice can be tried on stations with
// two names and with two spellings. The real tables hold no such station with a named entry.
vi.mock('../src/omio-station-names.js', () => ({
  OMIO_STATION_NAMES: { ABW: 'Abbey Wood Station' },
  OMIO_STATION_ENTRIES: { ABW: 'named', SPB: 'named', HMY: 'named' },
  OMIO_UNLISTED_STATIONS: new Set<string>(),
}))

import { OmioClient } from '../src/omio.js'
import { getStationName, getStationPosition } from '../src/stations.js'

interface Listed {
  id: string
  name: string
  type: string
  countryCode: string
  latitude: number
  longitude: number
}

/** A station as the location search lists it, standing where the station of `code` is. */
function entry(code: string, name: string, id: string): Listed {
  const position = getStationPosition(code)
  if (!position) throw new Error(`no position for ${code}`)
  return { id, name, type: 'station', countryCode: 'GB', latitude: position.latitude, longitude: position.longitude }
}

/** A client whose location search answers each query from `replies`, and the queries it was sent. */
function clientWith(replies: Record<string, Listed[]>): { client: OmioClient; asked: string[] } {
  const asked: string[] = []
  const fetchFn = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body))
    if (body.operationName !== 'SearchLocation') throw new Error(`unexpected operation ${body.operationName}`)
    const name: string = body.variables.request.name
    asked.push(name)
    return new Response(JSON.stringify({ data: { SearchLocation: { locations: replies[name] ?? [] } } }))
  }
  return { client: new OmioClient({ fetchFn, now: () => 0, sleep: async () => undefined }), asked }
}

describe('a station the location search lists twice', () => {
  it('uses stations that have the names the tests below assume', () => {
    expect(getStationName('ABW')).toBe('Abbey Wood')
    expect(getStationName('HMY')).toBe('Hairmyres')
    expect(getStationName('SPB')).toBe("Shepherd's Bush")
  })

  it('looks every name up before choosing, and takes the named entry from a later reply', async () => {
    // The stored name brings back the other entry alone. Only the table name brings back both.
    const other = entry('ABW', 'Abbey Wood Station', 'other')
    const named = entry('ABW', 'Abbey Wood Station', 'named')
    const { client, asked } = clientWith({ 'Abbey Wood Station': [other], 'Abbey Wood': [other, named] })
    expect((await client.resolvePlace('ABW')).id).toBe('named')
    expect(asked).toEqual(['Abbey Wood Station', 'Abbey Wood'])
  })

  it('looks every spelling up before choosing, and takes the named entry from a later reply', async () => {
    const other = entry('SPB', "Shepherd's Bush", 'other')
    const named = entry('SPB', "Shepherd's Bush", 'named')
    const { client, asked } = clientWith({ "Shepherd's Bush": [other], 'Shepherds Bush': [named, other] })
    expect((await client.resolvePlace('SPB')).id).toBe('named')
    expect(asked).toEqual(["Shepherd's Bush", 'Shepherds Bush'])
  })

  it('takes the named entry when the two entries come back in different replies', async () => {
    const other = entry('ABW', 'Abbey Wood', 'other')
    const named = entry('ABW', 'Abbey Wood', 'named')
    const { client } = clientWith({ 'Abbey Wood Station': [named], 'Abbey Wood': [other] })
    expect((await client.resolvePlace('ABW')).id).toBe('named')
  })

  it('takes the one entry there is when the named entry is not listed under any name', async () => {
    const other = entry('ABW', 'Abbey Wood Station', 'other')
    const { client, asked } = clientWith({ 'Abbey Wood Station': [other], 'Abbey Wood': [other] })
    expect((await client.resolvePlace('ABW')).id).toBe('other')
    expect(asked).toEqual(['Abbey Wood Station', 'Abbey Wood'])
  })

  it('refuses two entries when neither is the named one', async () => {
    const first = entry('ABW', 'Abbey Wood Station', 'first')
    const second = entry('ABW', 'Abbey Wood Station', 'second')
    const { client } = clientWith({ 'Abbey Wood Station': [first], 'Abbey Wood': [first, second] })
    await expect(client.resolvePlace('ABW')).rejects.toThrow(
      /more than one British station with that name came back, and they cannot be told apart/,
    )
  })

  it('does not take the named entry when it stands somewhere else', async () => {
    const other = entry('ABW', 'Abbey Wood Station', 'other')
    const elsewhere = { ...entry('ABW', 'Abbey Wood Station', 'named'), latitude: 53.4 }
    const { client } = clientWith({ 'Abbey Wood Station': [other, elsewhere] })
    expect((await client.resolvePlace('ABW')).id).toBe('other')
  })

  it('guesses no spelling for a station with a named entry', async () => {
    // Without a named entry an empty reply for "Hairmyres" would be followed by "Hairmyre's".
    const { client, asked } = clientWith({})
    await expect(client.resolvePlace('HMY')).rejects.toThrow(/no British station with that name came back/)
    expect(asked).toEqual(['Hairmyres'])
  })

  it('still stops at the first match for a station without a named entry', async () => {
    const { client, asked } = clientWith({ 'Liverpool South Parkway': [entry('LPY', 'Liverpool South Parkway', 'lpy')] })
    expect((await client.resolvePlace('LPY')).id).toBe('lpy')
    expect(asked).toEqual(['Liverpool South Parkway'])
  })
})
