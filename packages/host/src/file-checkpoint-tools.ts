/** Around-dispatch observation for attributed DSH file tools. */
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { FileCheckpointJournal, ManagedFileInput } from './file-checkpoints.ts'

/** @param journal Raw byte capture owner. @param input Actual managed turn input. @param exec Dispatched tool. @param next Remaining execution waterfall. @returns Original tool result. */
export async function observeWorkspaceFileTool<T>(journal: FileCheckpointJournal, input: ManagedFileInput, exec: { readonly name: string; readonly arguments: unknown; readonly callId: ToolCallId }, next: () => Promise<T>): Promise<T> {
  if (exec.name === 'write' || exec.name === 'edit') {
    const args = exec.arguments
    if (args !== null && typeof args === 'object' && 'file_path' in args && typeof args.file_path === 'string') return await journal.observe(input, exec.callId, args.file_path, next)
    await journal.unavailable({ ...input, callId: exec.callId, path: '', reason: 'file tool has no usable file_path' })
  } else if (exec.name === 'bash' || exec.name === 'pwsh' || exec.name === 'shell' || exec.name === 'exec_command' || exec.name === 'terminal_exec' || exec.name === 'str_replace_editor') {
    return await journal.unattributed({ ...input, callId: exec.callId, path: '', reason: 'unattributed command or unsupported file effects cannot be automatically restored' }, next)
  }
  return await next()
}
