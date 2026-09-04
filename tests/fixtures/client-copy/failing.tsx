export function hardcodedDisplay() {
  return 'Hardcoded helper copy'
}

export function FailingFixture({ condition, value }: { readonly condition: boolean; readonly value?: string }) {
  return <div aria-label="Hardcoded label" title="Hardcoded title">
    Hardcoded JSX copy
    <input placeholder="Hardcoded placeholder" />
    <span>{'Hardcoded expression copy'}</span>
    <button aria-label={'Hardcoded expression label'}>{true ? 'Ready' : 'Failed'}</button>
    <span>{condition && 'Hardcoded logical copy'}</span>
    <button aria-label={value ?? 'Hardcoded fallback label'} />
    <h1>@all</h1>
  </div>
}

export function displayStatus(ready: boolean) {
  return ready ? 'Ready' : 'Failed'
}

export function displayGreeting(name: string) {
  return `Hello ${name}`
}

export function displayFallback(value?: string) {
  return value || 'Unknown'
}

export function displayConstant() {
  return 'Ready' as const
}

export const displayConcise = () => 'Ready'
