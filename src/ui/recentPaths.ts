// Recently-opened project paths, for the FolderPicker's dropdown ONLY.
// localStorage is shared across all windows of the same origin, so it must NOT
// be used to decide which project a window shows (that's the per-window URL
// `?path=`) — otherwise opening a project in one window would change what
// another window reopens on reload. This list is purely a convenience.

const KEY = 'code-graph:recentPaths';
const MAX = 12;

export function getRecentPaths(): string[] {
    try {
        const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
        return [];
    }
}

export function addRecentPath(path: string): void {
    try {
        const list = getRecentPaths().filter((p) => p !== path);
        list.unshift(path);
        localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
    } catch {
        // localStorage unavailable (private mode etc.) — recents are optional.
    }
}
