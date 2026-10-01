Notices as small toasts under the header: what the server reports with `notice` events (a failed conversation refresh, an unknown document) and what the browser reports itself (a failed command, unsaved UI state). Info fades after 5 s, warnings after 9 s, errors after 15 s; hovering keeps them, and each can be dismissed.

An `overlay` slot component over `useNotices()`; the last four show at once.
