/**
 * dsh-worktree-toggle — package entry.
 *
 * The Host half now lives in `host.js` so the Loader row can name the subpath
 * `dsh-worktree-toggle/host`: changing that row name gives a running Host a
 * fresh module URL to import instead of a cached one.
 */
export * from './host.js'
