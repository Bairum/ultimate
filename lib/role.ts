/**
 * The role a conversation runs as, from its agent profile: its definition, else the label branches and older children
 * carry. An agent made on the fly has none, whatever the caller named it, so a label such as `coordinator` gives it no
 * coordinator handling.
 */
export const roleOf = (
  profile: { definition?: string; adhoc?: true } | undefined,
  label: string | undefined,
) => (profile?.adhoc ? undefined : (profile?.definition ?? label))
