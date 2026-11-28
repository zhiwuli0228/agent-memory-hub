/**
 * Standalone console (ADR-0010): the first-class human management surface
 * for every host. One self-contained HTML file — React 18 UMD + htm inlined,
 * zero network, zero build steps at runtime (see scripts/panel/panel.html and
 * scripts/panel/bake-panel.mjs).
 *
 * The generated module is serialized with JSON.stringify, which makes the
 * historical template-literal escape hazards (a `'\n'` becoming a real
 * newline inside the inline <script>) structurally impossible.
 */
export { PANEL_HTML } from './panel.generated.js'
