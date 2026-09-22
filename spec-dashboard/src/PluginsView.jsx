import { useEffect, useMemo, useState } from 'react'
import { apiUrl } from './project.js'
import { useT } from './i18n/index.jsx'
import { Segmented } from './Segmented.jsx'
import { useResizable } from './useResizable.js'
import { SpecBody } from './NodeView.jsx'

// THE AUTOMATION, AS A PLACE YOU WORK RATHER THAN A PAGE YOU READ. Every plugin here is already a spec node
// and already in the graph, so this board is not about making them exist on screen — it is about reading
// them by the surface they plug into instead of the folder they sit in, and about seeing what one of them
// actually DOES without leaving.
//
// @@@a-board-is-a-frame-not-a-document - the first two versions were one column in the shared page
// scrollport: three stacked sections, one scrollbar, every row a link that navigated away. That is the
// shape of a settings page — something you visit once a quarter, read top to bottom, and leave — and it is
// the wrong shape for the thing a project's automation is. A surface you MANAGE holds still while you work
// it: the frame and its controls never move, the list and the detail scroll independently, and selecting a
// row answers the question in place instead of spending the whole window to go and look. So the page root
// is a bounded pane ([[page-scroll]] exempts these deliberately) and the split is the one
// [[diff-document]] already establishes — resizable master pane, detail pane owning its own overflow.
//
// @@@the-master-is-a-lifecycle-drawing - the master pane is not a list with event headings any more; it is
// the agent's lifecycle drawn the way the harness's own hooks reference and Vue's lifecycle diagram draw
// theirs: nested frames for the loops (a session, each turn inside it, each tool call inside that), a
// spine down the left with one station per event, and every hook as a pill hanging off the station it
// fires on. The other two surfaces take their real place in the same picture instead of two more headings:
// always-on prose is folded into the agent's context at SessionStart, and skills/commands are what the
// agent may reach for inside the tool loop. A station with nothing bound is still drawn — the lifecycle is
// the harness's, and an empty station says "nothing runs here", which a list could never say. The filter
// and the search DIM what they exclude rather than removing it, because a lifecycle with missing stations is
// a wrong picture, not a shorter one.
//
// @@@the-detail-is-a-spec-reading - the selected plugin IS a spec node, so its detail is drawn in the node
// page's own grammar ([[spec-view]]: title, one-line description, a property row under a hairline, then the
// body as rendered prose) with the plugin's script under it as the document's own code block. Nothing in it
// is pinned: the first build held the description and a facts grid fixed above a scrolling body, which put a
// block of overview over every plugin and left the body itself as raw markdown in a `<pre>`. A document
// scrolls whole; the frame around it is what holds still.
//
// @@@what-it-has-actually-done - a plugin's declarations are the same on every load; what it has DONE is the
// only thing on this page that moves, and it is exact rather than sampled because the dispatcher that writes
// it is the thing that runs every hook ([[hook-ledger]]). It is drawn under the marks rule like everything
// else: the ordinary case — it ran, nothing refused — puts NOTHING on the pill, because a count on all 27
// pills is the badge farm again. Only the two exceptional readings reach the drawing: a hook that has never
// fired in the whole window, and a refusal, which carries its tally on the mark that already exists. The
// rest — runs, failures, median, last, the window itself — is in the detail beside the plugin's own text,
// which is where a reader who wants a number has gone looking for one.
//
// @@@normal-is-not-drawable - a marker for the ORDINARY case must be unrepresentable, or nothing stands out
// because everything is marked. An earlier version put order, refusal and a file count on every row and
// read as a badge farm. So a mark is drawn only when the thing it names is true, and `order` is drawn only
// on an event carrying more than one hook — the only place the number decides anything, since elsewhere
// position already says it.

const specHref = (name) => `#/spec/${encodeURIComponent(name)}`
const ago = (ms, t) => {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 45) return t('time.justNow')
  const m = s / 60, h = m / 60, d = h / 24
  if (m < 45) return t('time.minutes', { n: Math.round(m) })
  if (h < 22) return t('time.hours', { n: Math.round(h) })
  if (d < 7) return t('time.days', { n: Math.round(d) })
  return t('time.weeks', { n: Math.round(d / 7) })
}
const SURFACE_FILTERS = ['all', 'hook', 'system', 'invoked']

// The detail is the one thing the old page could not do: say what the plugin DOES. Its text is fetched per
// selection ([[plugins-view]]), so this pane owns a small load of its own and says so rather than blanking.
const langOf = (path) => {
  const ext = path.split('.').pop()
  return ({ sh: 'sh', bash: 'sh', mjs: 'js', js: 'js', ts: 'ts', md: 'markdown', json: 'json' })[ext] || ext
}

function Detail({ name, row, profile, activity, t }) {
  const [detail, setDetail] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!name) return undefined
    let live = true
    setDetail(null)
    setError(null)
    fetch(apiUrl(`/api/plugins/surfaces/${encodeURIComponent(name)}`))
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data) => { if (live) setDetail(data) })
      .catch((err) => { if (live) setError(err.message || String(err)) })
    return () => { live = false }
  }, [name])

  if (!name) return <div className="pg-detail pg-detail-empty">{t('plugins.pickOne')}</div>

  const hook = row?.surfaces?.includes('hook')
  const off = profile.disables.includes(name)
  // the property row follows the marks rule: a chip exists only for a fact that is TRUE of this plugin
  return (
    <article className="pane-doc pg-detail" key={name}>
      <h1 className="doc-title">{name}</h1>
      {row?.desc && <blockquote className="doc-desc">{row.desc}</blockquote>}
      <div className="doc-stat">
        {(row?.surfaces || []).map((surface) => (
          <span className={`stat-status pg-surface pg-surface-${surface}`} key={surface}><i className="stat-dot" />{surface}</span>
        ))}
        {hook && row.events?.length > 0 && <span className="stat-chip">{t('plugins.factEvents')} <b>{row.events.join(', ')}</b></span>}
        {hook && <span className="stat-chip">{t('plugins.factOrder')} <b>{row.order}</b></span>}
        {hook && row.block && <span className="stat-chip pg-chip-refuse" data-tip={t('plugins.blocksTip')}>{t('plugins.factBlock')}</span>}
        {off && <span className="stat-chip pg-chip-off">{t('plugins.factOff', { profile: profile.name })}</span>}
        {detail?.tools?.length > 0 && <span className="stat-chip">{t('plugins.factTools')} <b>{detail.tools.join(', ')}</b></span>}
        <a className="stat-back pg-detail-node" href={specHref(name)}>{t('plugins.openNode')} ↗</a>
      </div>
      {activity.available && row?.surfaces?.includes('hook') && (() => {
        const seen = activity.byHook[name]
        return (
          <dl className="pg-run" data-tip={t('plugins.runWindow', { since: activity.sinceDay, days: activity.days })}>
            <dt>{t('plugins.runRuns')}</dt><dd>{seen ? seen.runs : t('plugins.runNever')}</dd>
            {seen?.refusals > 0 && <><dt>{t('plugins.runRefused')}</dt><dd className="pg-run-refuse">{seen.refusals}</dd></>}
            {seen?.failures > 0 && <><dt>{t('plugins.runFailed')}</dt><dd className="pg-run-refuse">{seen.failures}</dd></>}
            {seen?.unfinished > 0 && <><dt>{t('plugins.runUnfinished')}</dt><dd>{seen.unfinished}</dd></>}
            {seen?.medianMs != null && <><dt>{t('plugins.runMedian')}</dt><dd>{t('plugins.runMs', { n: seen.medianMs })}</dd></>}
            {seen?.lastMs && <><dt>{t('plugins.runLast')}</dt><dd>{ago(seen.lastMs, t)}</dd></>}
            {seen?.lastRefusal?.reason && <><dt>{t('plugins.runWhy')}</dt><dd className="pg-run-why">{seen.lastRefusal.reason}</dd></>}
          </dl>
        )
      })()}
      {error && <p className="pg-error">{t('plugins.failed', { reason: error })}</p>}
      {!error && !detail && <div className="pane-loading"><span className="spinner" aria-label={t('plugins.loading')} /></div>}
      {detail && <>
        <SpecBody body={detail.body} />
        {detail.files.map((file) => (
          <section className="pg-file" key={file.path}>
            <h2 className="pg-file-name">{file.path.split('/').pop()}
              <span className="pg-file-path">{file.path}</span>
            </h2>
            <pre className="doc-pre pg-script"><code className={`language-${langOf(file.path)}`}>{file.text}</code></pre>
            {file.truncated && <p className="pg-file-cut">{t('plugins.truncated', { bytes: file.bytes })}</p>}
          </section>
        ))}
      </>}
    </article>
  )
}


// The harness's lifecycle vocabulary, in the order an agent meets it and the loop each event belongs to.
// [[plugins-view]] says which events carry hooks; this says where each sits in the picture. An event the
// reader carries that is not named here is drawn after the session frame rather than dropped.
// The session itself is not drawn as a frame: it is the page, and a box around everything is a box that
// says nothing. What repeats is framed — each turn, and each tool call inside it.
const LIFECYCLE = {
  before: ['SessionStart'],
  loop: { key: 'turn', events: ['UserPromptSubmit'], inner: { key: 'tool', events: ['PreToolUse', 'PostToolUse'], inner: null, after: [] }, after: [] },
  after: ['Notification', 'Stop', 'StopFailure'],
}
const KNOWN_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'StopFailure'])
// a station's aside: what the agent is doing there that no hook is — said once, where it happens
const STATION_ASIDE = { PreToolUse: 'plugins.toolRuns', Notification: 'plugins.waiting', Stop: 'plugins.refusedBack' }

function Pill({ row, name, selected, onSelect, dim, off, mark = null, order = null, small = false, cold = false, coldTip = null, coldLabel = null }) {
  const on = selected === name
  return (
    <button type="button"
      className={`lc-pill${small ? ' lc-chip' : ''}${on ? ' on' : ''}${dim ? ' is-dim' : ''}${off ? ' is-off' : ''}`}
      aria-current={on ? 'true' : undefined} data-tip={row?.desc || undefined}
      onClick={() => onSelect(name)}>
      {mark}<span className="lc-pill-name">{name}</span>
      {order != null && <span className="pg-ord">{order}</span>}
      {cold && <span className="lc-never" data-tip={coldTip}>{coldLabel}</span>}
    </button>
  )
}

function Station({ event, hooks, byName, keep, profile, activity, selected, onSelect, t, children }) {
  const many = hooks.length > 1
  return (
    <div className="lc-station">
      <span className="lc-dot" aria-hidden="true" />
      <div className="lc-station-body">
        <div className="lc-station-row">
          <span className="lc-event">{event}</span>
          {hooks.length > 0 && <span className="lc-tie" aria-hidden="true" />}
          <div className="lc-hooks">
            {hooks.map((hook) => {
              const row = byName.get(hook.name)
              const seen = activity.byHook[hook.name]
              const refusals = seen?.refusals || 0
              return <Pill key={hook.name} row={row} name={hook.name} selected={selected} onSelect={onSelect}
                dim={!keep(row)} off={profile.disables.includes(hook.name)}
                cold={activity.available && !seen}
                coldTip={t('plugins.neverTip', { since: activity.sinceDay })}
                coldLabel={t('plugins.never')}
                mark={hook.block
                  ? <span className={`pg-mark pg-refuse${refusals > 0 ? ' has-count' : ''}`}
                      data-tip={refusals > 0 ? t('plugins.refusedTip', { n: refusals }) : t('plugins.blocksTip')}>
                      ⊘{refusals > 0 && <b>{refusals}</b>}
                    </span>
                  : null}
                order={many ? hook.order : null} />
            })}
          </div>
          {STATION_ASIDE[event] && <span className={`lc-aside lc-aside-${event}`}>{t(STATION_ASIDE[event])}</span>}
        </div>
        {children}
      </div>
    </div>
  )
}

function Cluster({ label, rows, keep, selected, onSelect }) {
  if (rows.length === 0) return null
  return (
    <div className="lc-cluster">
      <span className="lc-cluster-label">{label}</span>
      <div className="lc-cluster-pills">
        {rows.map((row) => <Pill key={row.name} row={row} name={row.name} selected={selected} onSelect={onSelect}
          dim={!keep(row)} small />)}
      </div>
    </div>
  )
}

export default function PluginsView() {
  const t = useT()
  const [view, setView] = useState(null)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(null)
  const [query, setQuery] = useState('')
  const [surface, setSurface] = useState('all')
  const [activity, setActivity] = useState({ available: false, sinceDay: null, days: 0, runs: 0, byHook: {} })
  const [width, onDragStart, resetWidth] = useResizable('spex.pluginsPanelWidth', 380, { min: 260, max: 640 })

  useEffect(() => {
    let live = true
    fetch(apiUrl('/api/plugins/surfaces'))
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data) => { if (live) setView(data) })
      .catch((err) => { if (live) setError(err.message || String(err)) })
    return () => { live = false }
  }, [])

  // the activity is a second, independent read: the inventory never changes between loads and this changes on
  // every event, so a failure here leaves the drawing whole and simply says nothing about what has run.
  useEffect(() => {
    let live = true
    fetch(apiUrl('/api/plugins/activity'))
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data) => { if (live) setActivity(data) })
      .catch(() => {})
    return () => { live = false }
  }, [])

  const byName = useMemo(() => new Map((view?.rows || []).map((row) => [row.name, row])), [view])

  // One predicate for both panes: the filter decides what the list SHOWS, never what the inventory IS
  // ([[plugins-view]] always answers whole), and the counts in the bar report the filtered view honestly.
  const keep = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (row) => {
      if (!row) return false
      if (surface === 'invoked' ? !row.surfaces.some((s) => s === 'skill' || s === 'command')
        : surface !== 'all' && !row.surfaces.includes(surface)) return false
      if (!needle) return true
      return row.name.toLowerCase().includes(needle) || (row.desc || '').toLowerCase().includes(needle)
    }
  }, [query, surface])

  if (error) return <div className="pg-frame"><p className="pg-error">{t('plugins.failed', { reason: error })}</p></div>
  if (!view) return <div className="pg-frame" />

  const { rows, spine, profile } = view
  const shown = rows.filter(keep)
  const system = rows.filter((row) => row.surfaces.includes('system'))
  const invoked = rows.filter((row) => row.surfaces.includes('skill') || row.surfaces.includes('command'))
  const hooksOf = new Map(spine.map((slot) => [slot.event, slot.hooks]))
  const offSpine = spine.filter((slot) => !KNOWN_EVENTS.has(slot.event))
  const ctx = { byName, keep, profile, activity, selected, onSelect: setSelected, t }

  // one station of the lifecycle; the two clusters ride the station where their surface acts
  const drawStation = (event) => (
    <Station key={event} event={event} hooks={hooksOf.get(event) || []} {...ctx}>
      {event === 'SessionStart' && <Cluster label={t('plugins.foldedIn')} rows={system} keep={keep}
        selected={selected} onSelect={setSelected} />}
      {event === 'PreToolUse' && <Cluster label={t('plugins.mayInvoke')} rows={invoked} keep={keep}
        selected={selected} onSelect={setSelected} />}
    </Station>
  )
  // one repeating frame: its stations, the frame nested inside it, then the stations after that
  const drawFrame = (frame) => (
      // a frame draws its own spine only when it has two stations of its own to join; one station and a
      // nested loop have nothing to connect, and a line running past the loop to nowhere is a dangling stroke
      <div className={`lc-frame lc-frame-${frame.key}${frame.events.length + frame.after.length > 1 ? ' lc-frame-spined' : ''}`}
        data-label={t(`plugins.frame.${frame.key}`)}>
        <span className="lc-loop" aria-hidden="true" title={t('plugins.repeats')}>↺</span>
        {frame.events.map(drawStation)}
        {frame.inner && drawFrame(frame.inner)}
        {frame.after.map(drawStation)}
      </div>
  )

  return (
    <div className="pg-frame">
      {/* The bar carries what the reader acts WITH — never what the tab strip already says. */}
      <header className="pg-bar">
        <span className="pg-count">{t('plugins.count', { shown: shown.length, total: rows.length })}</span>
        <input className="pg-search" type="search" value={query} placeholder={t('plugins.searchHint')}
          aria-label={t('plugins.searchHint')} onChange={(e) => setQuery(e.target.value)} />
        <Segmented label={t('plugins.surfaceFilter')} value={surface} onPick={setSurface}
          options={SURFACE_FILTERS.map((value) => ({ value, label: t(`plugins.filter.${value}`) }))} />
        {activity.available && <span className="pg-ledger" data-tip={t('plugins.runWindow', { since: activity.sinceDay, days: activity.days })}>
          {t('plugins.ledger', { runs: activity.runs, since: activity.sinceDay })}
        </span>}
        {/* THE PROFILE IS ONLY NEWS WHEN IT SUBTRACTS. A profile that retains everything was drawn as a
            sentence saying so, which is the ordinary case wearing a label — the same thing the marks rule
            forbids on a pill. When nothing is disabled the drawing already says it: every hook is there,
            none struck through. When something IS disabled the strikes say WHICH, and the only fact left
            for the bar is which profile did it. */}
        {profile.disables.length > 0 && <span className="pg-profile"
          data-tip={t('plugins.profileTip', { off: profile.disables.join(', ') })}>
          {t('plugins.profileOff', { name: profile.name, n: profile.disables.length })}
        </span>}
      </header>

      <div className="pg-split" style={{ '--pg-panel': `${width}px` }}>
        <nav className="pg-list lc" aria-label={t('plugins.listLabel')}>
          <div className="lc-root">
            {LIFECYCLE.before.map(drawStation)}
            {drawFrame(LIFECYCLE.loop)}
            {LIFECYCLE.after.map(drawStation)}
          </div>
          {offSpine.length > 0 && <div className="lc-frame lc-frame-else" data-label={t('plugins.frameElse')}>
            {offSpine.map((slot) => <Station key={slot.event} event={slot.event} hooks={slot.hooks} {...ctx} />)}
          </div>}
        </nav>
        <div className="pg-resize" onMouseDown={onDragStart} onDoubleClick={resetWidth} aria-hidden="true" />
        <Detail name={selected} row={byName.get(selected)} profile={profile} activity={activity} t={t} />
      </div>
    </div>
  )
}
