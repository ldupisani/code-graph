import { create } from 'zustand';
import type { PresenceState, SessionInfo } from '../api/types';

// ---------------------------------------------------------------------------
// Presence: who else has this project open, and (optionally) whose view we're
// mirroring. Fed by the SSE `sessions` / `presence` events (wired in App.tsx);
// consumed by the SessionsPill HUD, the follow effect in App.tsx, and
// EditorPane's live-buffer view of the followed session's edits.
// ---------------------------------------------------------------------------

// Identity is PER TAB (sessionStorage, not localStorage): each window is its
// own session — that's the whole point of presence — but a reload of the same
// tab keeps its identity so followers aren't dropped by a refresh.
export interface SessionIdentity {
  id: string;
  name: string;
  color: string;
}

const IDENTITY_KEY = 'code-graph-session-identity';

const ADJECTIVES = [
  'Amber', 'Cobalt', 'Crimson', 'Dapper', 'Electric', 'Fuzzy', 'Golden',
  'Indigo', 'Jade', 'Lunar', 'Mellow', 'Nimble', 'Opal', 'Plucky', 'Quiet',
  'Rusty', 'Scarlet', 'Teal', 'Umber', 'Vivid',
];
const ANIMALS = [
  'Fox', 'Badger', 'Crane', 'Dingo', 'Egret', 'Ferret', 'Gecko', 'Heron',
  'Ibis', 'Jackal', 'Koala', 'Lemur', 'Marmot', 'Newt', 'Otter', 'Panda',
  'Quokka', 'Raven', 'Stoat', 'Tapir',
];
// Distinct, canvas-friendly hues (bright enough for the dark theme).
const COLORS = [
  '#e0b050', '#4a9eff', '#5fd38a', '#ef6f6f', '#c792ea', '#56c8d8',
  '#f78c6c', '#e2e060', '#f07daa', '#8bd649',
];

function randomFrom<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

export function getSessionIdentity(): SessionIdentity {
  try {
    const stored = sessionStorage.getItem(IDENTITY_KEY);
    if (stored) return JSON.parse(stored) as SessionIdentity;
  } catch {
    // Corrupt / unavailable storage — fall through to a fresh identity.
  }
  const identity: SessionIdentity = {
    id: crypto.randomUUID(),
    name: `${randomFrom(ADJECTIVES)} ${randomFrom(ANIMALS)}`,
    color: randomFrom(COLORS),
  };
  try {
    sessionStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  } catch {
    // Storage full/blocked: identity just won't survive a reload.
  }
  return identity;
}

interface PresenceStore {
  // Roster from the server, self included. Empty when disconnected/solo.
  sessions: readonly SessionInfo[];
  // Last-known state per session id (self excluded — we don't echo).
  presence: ReadonlyMap<string, PresenceState>;
  // Session id we're mirroring, or null. Set by SessionsPill; consumed by the
  // follow effect in App.tsx and by EditorPane's followed-buffer view.
  followingId: string | null;
  setSessions: (sessions: readonly SessionInfo[]) => void;
  setPresence: (sessionId: string, state: PresenceState) => void;
  setFollowing: (id: string | null) => void;
  clear: () => void;
}

export const usePresenceStore = create<PresenceStore>((set) => ({
  sessions: [],
  presence: new Map(),
  followingId: null,
  setSessions: (sessions) =>
    set((s) => ({
      sessions,
      // A departed session can't keep stale presence or remain followed.
      presence: new Map(
        [...s.presence].filter(([id]) => sessions.some((x) => x.id === id)),
      ),
      followingId:
        s.followingId && sessions.some((x) => x.id === s.followingId)
          ? s.followingId
          : null,
    })),
  setPresence: (sessionId, state) =>
    set((s) => {
      const next = new Map(s.presence);
      next.set(sessionId, state);
      return { presence: next };
    }),
  setFollowing: (followingId) => set({ followingId }),
  clear: () => set({ sessions: [], presence: new Map(), followingId: null }),
}));

// Dev-only console hook, mirroring useGraphStore / useSourceStore.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (
    window as unknown as { usePresenceStore: typeof usePresenceStore }
  ).usePresenceStore = usePresenceStore;
}
