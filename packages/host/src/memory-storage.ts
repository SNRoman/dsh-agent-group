/** Opens retained memory domains without rewriting authoritative storage headers. */
import type { Domain, DomainFacility, DomainSpec } from '@deepseek-ai/dsh-storage-domain'

/** Retry declared predecessor versions only when a backend rejects the current unit header.
 * @param facility Native routed storage-domain facility.
 * @param spec Current memory-domain schema and explicitly readable predecessors.
 * @returns A schema-validated domain; a fallback handle retains its predecessor unit version on writes.
 */
export async function openMemoryDomain<S extends DomainSpec>(facility: Pick<DomainFacility, 'open'>, spec: S): Promise<Domain<S>> {
  try { return await facility.open(spec) }
  catch (error) {
    if (!isVersionMismatch(error)) throw error
    for (const version of spec.compatibleVersions ?? []) {
      const predecessor: S = { ...spec, version, compatibleVersions: [] }
      try { return await facility.open(predecessor) }
      catch (predecessorError) { if (!isVersionMismatch(predecessorError)) throw predecessorError }
    }
    throw error
  }
}

function isVersionMismatch(error: unknown): boolean {
  return error instanceof Error && error.name === 'StorageError' && 'code' in error && error.code === 'version-mismatch'
}
