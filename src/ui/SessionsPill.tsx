import { getSessionIdentity, usePresenceStore } from '../graph/presence';

// Header roster of every session connected to this project. Click another
// session to follow it (mirror selection + camera + live edit buffer); click
// again to unfollow. Hidden entirely while solo — presence is only
// interesting with company.
export function SessionsPill() {
  const sessions = usePresenceStore((s) => s.sessions);
  const followingId = usePresenceStore((s) => s.followingId);
  const setFollowing = usePresenceStore((s) => s.setFollowing);
  const presence = usePresenceStore((s) => s.presence);
  const selfId = getSessionIdentity().id;

  if (sessions.length <= 1) return null;

  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
      {sessions.map((session) => {
        const isSelf = session.id === selfId;
        const isFollowed = session.id === followingId;
        const isEditing = presence.get(session.id)?.editFileId != null;
        return (
          <button
            key={session.id}
            type="button"
            disabled={isSelf}
            onClick={() => setFollowing(isFollowed ? null : session.id)}
            title={
              isSelf
                ? 'This window'
                : isFollowed
                  ? `Following ${session.name} — click to unfollow`
                  : `Follow ${session.name}${isEditing ? ' (editing now)' : ''}`
            }
            style={{
              appearance: 'none',
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
              border: `1px solid ${isFollowed ? session.color : '#3a3a40'}`,
              borderRadius: 999,
              background: isFollowed ? `${session.color}22` : '#26262b',
              color: isSelf ? '#8a8a92' : '#cfcfd6',
              fontFamily: 'ui-monospace, monospace',
              fontSize: '0.72rem',
              padding: '0.18rem 0.55rem',
              cursor: isSelf ? 'default' : 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: session.color,
                flexShrink: 0,
              }}
            />
            {session.name}
            {isSelf ? ' (you)' : ''}
            {/* Live pencil: this session is in edit mode right now. */}
            {isEditing ? <span style={{ color: session.color }}>✎</span> : null}
            {isFollowed ? <span style={{ opacity: 0.75 }}>· following</span> : null}
          </button>
        );
      })}
    </span>
  );
}
