/** Conclude a whole conversation subtree, even when a descendant has live tasks. */
export function hiddenConversationIds(
  conversations: readonly {
    id: number
    parentConversationId?: number
    branchOf?: { conversationId: number }
  }[],
  archived: readonly number[],
) {
  const hidden = new Set(archived)
  let changed = true
  while (changed) {
    changed = false
    for (const conversation of conversations) {
      const parent = conversation.parentConversationId ?? conversation.branchOf?.conversationId
      if (parent !== undefined && hidden.has(parent) && !hidden.has(conversation.id)) {
        hidden.add(conversation.id)
        changed = true
      }
    }
  }
  return hidden
}
