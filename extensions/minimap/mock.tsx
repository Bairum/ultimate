/** Made-up marks for the preview round: what each kind of conversation's rail could show. */

export type MarkKind =
  | 'user'
  | 'answer'
  | 'branch'
  | 'landed'
  | 'failed'
  | 'commit'
  | 'preview'
  | 'subagent'
  | 'report'
  | 'screenshot'
  | 'compaction'

export interface Mark {
  kind: MarkKind
  text: string
  at: string
}

export type Profile = 'ultimate' | 'coordinator' | 'worker'

export const kindLabel: Record<MarkKind, string> = {
  user: 'You',
  answer: 'Answer',
  branch: 'Branch started',
  landed: 'Landed',
  failed: 'Landing failed',
  commit: 'Commit',
  preview: 'Preview started',
  subagent: 'Subagent started',
  report: 'Subagent reported',
  screenshot: 'Screenshot',
  compaction: 'Compacted',
}

/** Which kinds a profile shows as milestones by default. */
export const milestones: Record<Profile, readonly MarkKind[]> = {
  ultimate: ['branch', 'landed', 'failed', 'compaction'],
  coordinator: ['commit', 'preview', 'subagent', 'report', 'landed', 'failed', 'compaction'],
  worker: ['commit', 'screenshot', 'compaction'],
}

const asks = [
  'can you check why the lander failed on the tailscale tests',
  'make the sidebar rows quieter, the counts are too loud',
  'he it’s gone again — something with tailscale or is ultimate running?',
  'redesign the jump rail like the screenshot',
  'please do it, I need to continue rn',
  'start an ultimate instance in the omarchy-config folder',
  'why is the context meter at 90% already',
  'ok approve, ship it',
  'what happened overnight?',
  'let’s try variant B with filter chips',
]
const answers = [
  'The lander failed on a stale fixture; I started a branch to fix it.',
  'Started branch Sidebar polish; it will send a preview.',
  'Ultimate is running; Tailscale Serve lost its mapping, I restarted it.',
  'Landed 3f2a91c: quieter sidebar counts.',
  'Two branches landed overnight, one is waiting on your approval.',
  'The assessment is in: medium, about 400 lines, no core change.',
]
const branches = [
  'Sidebar polish',
  'Fix lander fixture',
  'Conversation minimap',
  'Tailscale serve teardown',
  'Context meter estimate',
]
const commits = [
  'minimap: rail with tick marks per kind',
  'minimap: wheel steps through marks',
  'sidebar: quieter counts',
  'lander: refresh stale fixture',
  'minimap: popover list with filters',
  'tests: cover mark classification',
]

/** A deterministic made-up transcript for `profile`, oldest first. */
export function mockMarks(profile: Profile): Mark[] {
  const marks: Mark[] = []
  let minute = 8 * 60 + 2
  const at = () => {
    minute += 3 + ((marks.length * 7) % 11)
    return `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
  }
  const push = (kind: MarkKind, text: string) => marks.push({ kind, text, at: at() })
  const rounds = profile === 'ultimate' ? 26 : profile === 'coordinator' ? 18 : 12
  for (let round = 0; round < rounds; round++) {
    push('user', asks[round % asks.length])
    if (profile === 'ultimate') {
      if (round % 3 === 1) push('branch', branches[round % branches.length])
      if (round % 4 === 2)
        push(round % 8 === 6 ? 'failed' : 'landed', commits[round % commits.length])
    } else if (profile === 'coordinator') {
      if (round % 3 === 0) push('subagent', `worker: ${commits[round % commits.length]}`)
      if (round % 3 === 1) push('report', `worker reported: ${commits[round % commits.length]}`)
      if (round % 2 === 0) push('commit', commits[round % commits.length])
      if (round === 4 || round === 11) push('preview', 'Preview on :4810')
      if (round === 16) push('landed', 'Landed 9c1d0e2 into main')
    } else {
      push('commit', commits[round % commits.length])
      if (round % 2 === 1) push('screenshot', 'Rail at 1400×900, dark')
    }
    push('answer', answers[round % answers.length])
    if (round === Math.floor(rounds / 2)) push('compaction', 'Context compacted at 71%')
  }
  return marks
}
