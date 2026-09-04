export function hardcodedDisplay() {
  return 'Hardcoded helper copy'
}

export function FailingFixture() {
  return <div aria-label="Hardcoded label" title="Hardcoded title">
    Hardcoded JSX copy
    <input placeholder="Hardcoded placeholder" />
  </div>
}
