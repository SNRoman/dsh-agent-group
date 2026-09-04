/** Test-only rendering stand-ins for browser-only primitive bundles. */
export function DisclosureRow(props: Readonly<Record<string, unknown>>) {
  return { type: 'section', props }
}

export function MarkdownText({ text }: { readonly text: string }) {
  return text
}
