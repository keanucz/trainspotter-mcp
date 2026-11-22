// GraphQL documents for the Uber Travel (Omio-backed) search API.
//
// This API is undocumented. The documents below ask only for the fields the
// tools read, so an unrelated field being renamed upstream does not break us.

export const SEARCH_LOCATION_QUERY = `query SearchLocation($request: SearchLocation__Input!) {
  SearchLocation(request: $request) {
    locations { id countryCode latitude longitude name type }
  }
}`;

export const SEARCH_JOURNEYS_MUTATION = `mutation SearchJourneys($request: SearchQuotes__Input!) {
  SearchJourneys(request: $request) {
    booking { searchId status }
  }
}`;

const JOURNEY_FRAGMENT = `fragment JourneyFields on JourneyWithoutQuotes {
  id
  cheapestPriceCents
  discounts { totalValueInCents }
  departure {
    departureTime { timestamp timezone }
    arrivalTime { timestamp timezone }
    travelMode
    carrierId
    split { savingCents }
    isAlternativeDeparture
    isAlternativeArrival
    segments {
      departure { name type }
      arrival { name type }
      departureTime { timestamp timezone }
      arrivalTime { timestamp timezone }
      carrierId
      transportId
      travelMode
    }
  }
}`;

export const GET_SEARCH_QUERY = `query GetSearchWithoutQuotes($request: GetSearchWithoutQuotes__Input!) {
  GetSearchWithoutQuotes(request: $request) {
    booking {
      currency
      searchId
      status
      journeys {
        ...JourneyFields
        splitJourneys { ...JourneyFields }
      }
      extensionOptions {
        travelMode
        outboundLater
        currentIntervals { outbound { start end } }
      }
      carriers { id name }
      searchDisclaimers { message }
    }
  }
}

${JOURNEY_FRAGMENT}`;

export const EXTEND_SEARCH_QUERY = `query ExtendSearchWithoutQuotes($request: ExtendSearchWithoutQuotes__Input!) {
  ExtendSearchWithoutQuotes(request: $request) {
    booking { searchId status }
  }
}`;
