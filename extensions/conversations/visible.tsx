/** Archive a whole conversation subtree, even when a descendant has live tasks. */
export function hiddenConversationIds(
  conversations: readonly { id: number; parentConversationId?: number }[],
  archived: readonly number[],
) {
  const hidden = new Set(archived)
  let changed = true
  while (changed) {
    changed = false
    for (const conversation of conversations) {
      if (
        conversation.parentConversationId !== undefined &&
        hidden.has(conversation.parentConversationId) &&
        !hidden.has(conversation.id)
      ) {
        hidden.add(conversation.id)
        changed = true
      }
    }
  }
  return hidden
}
