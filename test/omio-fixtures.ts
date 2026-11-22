import { readFileSync } from 'node:fs'

/**
 * Loads a response body cut from a sanitized browser capture of the Uber Travel
 * search page (see test/fixtures/omio). A fresh copy is parsed on every call so
 * tests can change one without affecting the next.
 */
export function loadOmioFixture(name: string): any {
  return JSON.parse(readFileSync(new URL(`./fixtures/omio/${name}.json`, import.meta.url), 'utf8'))
}
