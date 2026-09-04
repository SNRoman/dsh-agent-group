interface Props {
  readonly t: (key: string) => string
  readonly agent: { readonly name: string }
}

export function protocolKind() {
  return 'room/message'
}

export function PassingFixture({ t, agent }: Props) {
  return <button
    type="button"
    className="workspace-action"
    data-command="@all"
    aria-label={t('action.open')}
    title={t('action.open')}
  >
    {agent.name}
    <span aria-hidden="true">✦</span>
  </button>
}
