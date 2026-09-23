/** Test-only stand-in for the browser bundle's store factory. */
export function defineStore<T>(definition: T): { readonly definition: T } {
  return { definition }
}
