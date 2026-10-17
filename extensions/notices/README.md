Notices as small toasts centred under the header, so they never cover the sidebar or an open right panel: what the server reports with `notice` events (a failed conversation refresh, an unknown document) and what the browser reports itself (a failed command, unsaved UI state). Info fades after 5 s, warnings after 9 s, errors after 15 s; hovering keeps them, and each can be dismissed. A browser notice with an action, such as "Ultimate was updated · Reload" after a cloud deploy, stays until it is taken or dismissed.

An `overlay` slot component over `useNotices()`; the last four show at once.
