# Optional Persona Scene discovery contract

Amadeus QQ exposes `qq.listAuthorizedScenes()` as a synchronous, read-only Host service method. It complements the existing `qq.resolveTrustedSessionScene(sessionId)` and does not appear in the QQ model tool set or Owner HTTP API.

Each returned entry has `{ platform: 'qq', kind: 'group' | 'private', id: '<botId>:<peerId>', workspaceId, authorized: true }`. The list includes only currently allowlisted, unpaused Scenes for which `qq.read` is effective and a DSH Workspace ID is configured. It can include a Scene before any message or Session exists. It never creates a Session or changes QQ configuration.

Persona must compare `workspaceId` with its bound Workspace and re-read the list before accepting or applying a prebinding. After first Session creation, `resolveTrustedSessionScene(sessionId)` remains the authority for mapping an active Agent to a Scene. QQ revocation, pause, read denial, bot switch, or Workspace change removes the old entry from the list. Saved Persona bindings may be archived, but must not inject when the current Host list or Session mapping no longer authorizes them.

The new method returns no token, NapCat endpoint, message body, media path, participant roster, or permission mutation handle. Existing service methods, Agent Presets, continuous conversation, and platform permission checks are unchanged. Callers that do not know this method continue working with the previous Session-only contract.
