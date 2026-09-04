export function hardcodedDisplay() {
  return 'Hardcoded helper copy'
}

export function FailingFixture() {
  return <div aria-label="Hardcoded label" title="Hardcoded title">
    Hardcoded JSX copy
    <input placeholder="Hardcoded placeholder" />
    <span>{'Hardcoded expression copy'}</span>
    <button aria-label={'Hardcoded expression label'}>{true ? 'Ready' : 'Failed'}</button>
  </div>
}

export function displayStatus(ready: boolean) {
  return ready ? 'Ready' : 'Failed'
}

export function displayGreeting(name: string) {
  return `Hello ${name}`
}
