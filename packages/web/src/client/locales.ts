/** Typed dictionaries for every Agent Workspace-owned Browser label. */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Locale namespace attached to both additive workspace slots. */
export const AGENT_WORKSPACE_LOCALE = 'agentWorkspace'

/** Simplified Chinese dictionary defines the complete Agent Workspace key set. */
export const zh = {
  'workspace.title': '智能体工作区',
  'workspace.open': '打开智能体工作区',
  'workspace.views': '工作区视图',
  'workspace.chat': '聊天',
  'workspace.agents': '智能体',
  'workspace.loading': '正在读取智能体工作区…',
  'workspace.processing': '处理中…',
  'workspace.agentsProcessing': '智能体处理中…',
  'workspace.refresh': '刷新',
  'workspace.close': '关闭',
  'workspace.requestFailed': '工作区请求失败：{detail}',
  'workspace.streamFailed': '实时状态连接失败：{detail}',
  'room.conversations': '会话',
  'room.newGroup': '新建群聊',
  'room.name': '群聊名称',
  'room.create': '创建',
  'room.cancel': '取消',
  'room.direct': '私聊',
  'room.empty': '还没有会话，可以新建群聊或从智能体实例发起私聊。',
  'room.select': '选择一个会话后开始协作。',
  'room.members': '{count} 名成员',
  'room.noMessages': '这个会话还没有消息。',
  'room.groupPlaceholder': '输入消息；可 @all 或 @成员，Ctrl/⌘ + Enter 发送',
  'room.directPlaceholder': '输入私聊消息，Ctrl/⌘ + Enter 发送',
  'room.send': '发送',
  'room.directTarget': '私聊对象',
  'room.groupMembers': '群成员',
  'room.addAgent': '添加智能体',
  'room.join': '加入群聊',
  'room.remove': '移出',
  'agent.definitions': '智能体定义',
  'agent.newDefinition': '新建定义',
  'agent.noDefinitions': '先创建一个智能体定义，例如 Java 工程师、产品经理或架构师。',
  'agent.newDefinitionTitle': '新建智能体定义',
  'agent.fallbackTitle': '智能体',
  'agent.selectDefinition': '从左侧选择一个定义。',
  'agent.name': '名称',
  'agent.description': '职责说明',
  'agent.instructions': 'Instructions',
  'agent.namePlaceholder': '例如：Java 工程师',
  'agent.descriptionPlaceholder': '这个角色负责什么',
  'agent.instructionsPlaceholder': '给智能体的角色指令',
  'agent.createDefinition': '创建定义',
  'agent.syncExisting': '保存新 Revision 后同步到现有实例',
  'agent.saveRevision': '保存新 Revision',
  'agent.revision': '修订 {number}',
  'agent.instances': '实例',
  'agent.instancesHint': '每个实例拥有独立会话、记忆和群成员关系',
  'agent.instanceNamePlaceholder': '实例名称，例如：后端-Alice',
  'agent.createInstance': '创建实例',
  'agent.employed': '在职',
  'agent.departed': '已离职',
  'agent.depart': '离职',
  'agent.reemploy': '重新入职',
  'turn.replying': '正在回复…',
  'turn.saving': '正在保存…',
  'turn.thinking': '正在思考…',
  'turn.reasoning': '思考过程',
  'turn.generating': '生成中',
  'turn.completed': '已完成',
  'turn.toolCall': '工具调用',
  'turn.toolNamed': '工具：{name}',
  'turn.running': '执行中',
  'turn.failed': '失败',
  'turn.arguments': '参数',
  'turn.result': '结果',
  'turn.error': '错误',
  'turn.extensionOutput': '扩展输出',
  'actor.system': '系统',
  'actor.me': '我',
  'error.reservedDirectRouting': '私聊 {roomId} 不能使用保留路由 {token}。',
  'error.agentMissing': '找不到智能体 {agentId}。',
  'error.agentDeparted': '智能体 {agentId} 已离职。',
  'error.duplicateMembership': '智能体 {agentId} 已在会话 {roomId} 中。',
  'error.staleRevision': '定义 {definitionId} 的修订 {revisionId} 已过期。',
  'error.invalidTaskAuthority': '智能体 {agentId} 无权处理任务 {taskId}。',
} as const

/** Complete English dictionary aligned with the Simplified Chinese key set. */
export type AgentWorkspaceLocaleKey = keyof typeof zh

export const en = {
  'workspace.title': 'Agent Workspace', 'workspace.open': 'Open Agent Workspace', 'workspace.views': 'Workspace views', 'workspace.chat': 'Chat', 'workspace.agents': 'Agents', 'workspace.loading': 'Loading Agent Workspace…', 'workspace.processing': 'Working…', 'workspace.agentsProcessing': 'Agents working…', 'workspace.refresh': 'Refresh', 'workspace.close': 'Close', 'workspace.requestFailed': 'Workspace request failed: {detail}', 'workspace.streamFailed': 'Live status connection failed: {detail}',
  'room.conversations': 'Conversations', 'room.newGroup': 'New group', 'room.name': 'Group name', 'room.create': 'Create', 'room.cancel': 'Cancel', 'room.direct': 'Direct', 'room.empty': 'No conversations yet. Create a group or start a direct conversation from an agent instance.', 'room.select': 'Select a conversation to begin collaborating.', 'room.members': '{count} members', 'room.noMessages': 'No messages in this conversation yet.', 'room.groupPlaceholder': 'Write a message; use @all or @member, Ctrl/⌘ + Enter to send', 'room.directPlaceholder': 'Write a direct message, Ctrl/⌘ + Enter to send', 'room.send': 'Send', 'room.directTarget': 'Direct participant', 'room.groupMembers': 'Group members', 'room.addAgent': 'Add agent', 'room.join': 'Join group', 'room.remove': 'Remove',
  'agent.definitions': 'Agent definitions', 'agent.newDefinition': 'New definition', 'agent.noDefinitions': 'Create an agent definition first, such as a Java engineer, product manager, or architect.', 'agent.newDefinitionTitle': 'New agent definition', 'agent.fallbackTitle': 'Agent', 'agent.selectDefinition': 'Select a definition from the left.', 'agent.name': 'Name', 'agent.description': 'Responsibilities', 'agent.instructions': 'Instructions', 'agent.namePlaceholder': 'For example: Java engineer', 'agent.descriptionPlaceholder': 'What is this role responsible for?', 'agent.instructionsPlaceholder': 'Instructions for the agent role', 'agent.createDefinition': 'Create definition', 'agent.syncExisting': 'Synchronize existing instances after saving the new revision', 'agent.saveRevision': 'Save new revision', 'agent.revision': 'Revision {number}', 'agent.instances': 'Instances', 'agent.instancesHint': 'Each instance has an independent session, memory, and group membership', 'agent.instanceNamePlaceholder': 'Instance name, for example: backend-Alice', 'agent.createInstance': 'Create instance', 'agent.employed': 'Employed', 'agent.departed': 'Departed', 'agent.depart': 'Depart', 'agent.reemploy': 'Re-employ',
  'turn.replying': 'Replying…', 'turn.saving': 'Saving…', 'turn.thinking': 'Thinking…', 'turn.reasoning': 'Reasoning', 'turn.generating': 'Generating', 'turn.completed': 'Completed', 'turn.toolCall': 'Tool call', 'turn.toolNamed': 'Tool: {name}', 'turn.running': 'Running', 'turn.failed': 'Failed', 'turn.arguments': 'Arguments', 'turn.result': 'Result', 'turn.error': 'Error', 'turn.extensionOutput': 'Extension output',
  'actor.system': 'System', 'actor.me': 'Me', 'error.reservedDirectRouting': 'Direct room {roomId} cannot use reserved route {token}.', 'error.agentMissing': 'Agent {agentId} was not found.', 'error.agentDeparted': 'Agent {agentId} has departed.', 'error.duplicateMembership': 'Agent {agentId} is already in room {roomId}.', 'error.staleRevision': 'Revision {revisionId} for definition {definitionId} is stale.', 'error.invalidTaskAuthority': 'Agent {agentId} is not authorized for task {taskId}.',
} satisfies Record<AgentWorkspaceLocaleKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    agentWorkspace: AgentWorkspaceLocaleKey
  }
}
