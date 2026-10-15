import React, {useCallback, useEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Activity, ArrowDown, ArrowRight, ArrowUpRight, BookOpen, Brain, Check, CheckCircle2, ChevronRight, Circle, CircleAlert, Clock3, Database, FileCheck2, FolderOpen, GitBranch, Layers3, LayoutDashboard, LockKeyhole, Menu, Pause, Play, RefreshCw, Search, ShieldCheck, SlidersHorizontal, Wrench, Workflow, X} from 'lucide-react';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import './styles.css';
import {playback} from './playback.mjs';
import ThemeControl from './ThemeControl.jsx';
import BenchmarkMonitor from './BenchmarkMonitor.jsx';
import helixMark from '../docs/assets/helix-mark.svg';

const demo = new URLSearchParams(location.search).get('demo') === '1';
const developmentMonitor = import.meta.env.MODE === 'monitor';
const sections = [
  ['overview', 'Overview', LayoutDashboard], ['flow', 'Flow', GitBranch],
  ['evidence', 'Evidence', FileCheck2], ['memory', 'Memory', Database],
  ['troubleshooting', 'Troubleshooting', Wrench],
  ...(developmentMonitor ? [['benchmarks', 'Benchmarks', SlidersHorizontal]] : []),
];
const number = value => value == null ? 'Not reported' : new Intl.NumberFormat().format(value);
const time = value => value == null || !Number.isFinite(new Date(value).getTime()) ? 'Not reported' : new Intl.DateTimeFormat(undefined, {hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false}).format(new Date(value));
const readable = value => value == null ? 'Not reported' : String(value).replaceAll('_', ' ');
const sectionFromHash = () => sections.some(([id]) => id === location.hash.slice(1)) ? location.hash.slice(1) : 'overview';

function useSnapshot() {
  const [snapshot, setSnapshot] = useState(null);
  const [state, setState] = useState('loading');
  const [paused, setPaused] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [received, setReceived] = useState(null);
  useEffect(() => {
    let disposed = false, timer;
    async function poll() {
      try {
        if (!demo && typeof window.helix?.snapshot !== 'function') { if (!disposed) setState('offline'); return; }
        const next = demo ? playback : await window.helix.snapshot();
        if (next?.schema !== 'helix.monitor.v1' || !Array.isArray(next.active) || !Array.isArray(next.events) || !next.counters) throw new Error('Unsupported monitor snapshot');
        if (!disposed) { setSnapshot(next); setState('connected'); setReceived(Date.now()); }
      } catch { if (!disposed) setState('error'); }
      if (!disposed && !paused && !demo) timer = setTimeout(poll, 2000);
    }
    poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [paused, refresh]);
  useEffect(() => {
    if (demo || paused || typeof window.helix?.onModelState !== 'function') return;
    return window.helix.onModelState(model => setSnapshot(previous => previous ? {...previous, model_state: model} : previous));
  }, [paused]);
  return {snapshot, state, paused, setPaused, received, refresh: () => setRefresh(n => n + 1)};
}

function IconButton({label, children, ...props}) {
  return <button className="icon-button" title={label} aria-label={label} {...props}>{children}</button>;
}

function Badge({children, tone = 'neutral', dot = false}) {
  return <span className={`badge ${tone}`}>{dot && <span className="status-dot" />}{children}</span>;
}

function Empty({icon: Icon = Layers3, title, children}) {
  return <div className="empty"><Icon size={25} strokeWidth={1.4} /><strong>{title}</strong>{children && <p>{children}</p>}</div>;
}

function Heading({title, children, aside}) {
  return <div className="section-heading"><div><h2>{title}</h2>{children && <p>{children}</p>}</div>{aside}</div>;
}

function Detail({detail, close}) {
  const ref = useRef(null);
  useEffect(() => { if (detail) ref.current?.showModal(); else ref.current?.close(); }, [detail]);
  return <dialog ref={ref} className="detail-dialog" onCancel={close} onClick={event => { if (event.target === ref.current) close(); }} aria-labelledby="detail-title">
    {detail && <><div className="dialog-header"><div><span className="label">Inspector</span><h2 id="detail-title">{detail.title}</h2></div><IconButton label="Close inspector" onClick={close}><X size={19} /></IconButton></div>
      <dl className="details">{Object.entries(detail.fields).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{readable(value)}</dd></div>)}</dl>
      {detail.literal !== undefined && <pre className="literal-result exact-note">{detail.literal}</pre>}
      {detail.note && <p className="inspector-note"><ShieldCheck size={17} />{detail.note}</p>}</>}
  </dialog>;
}

const nodeInfo = {
  client: {name: 'Client', subtitle: 'Explicit request', icon: Activity},
  controller: {name: 'Controller', subtitle: 'Local service', icon: Workflow},
  'tool-flow': {name: 'Tool flow', subtitle: 'Deterministic steps', icon: GitBranch},
  evidence: {name: 'Evidence', subtitle: 'Literal records', icon: FileCheck2},
  memory: {name: 'Memory', subtitle: 'Explicit retrieval', icon: Database},
};

function ModelState({snapshot, live}) {
  const model = snapshot.model_state;
  const available = live && model && model.source !== 'none';
  const phase = available ? model.state : 'unknown';
  const reasoning = phase === 'reasoning' && model.observed === true;
  const phases = ['idle', 'waiting', 'reasoning', 'generating', 'tool', model?.source === 'codex-native' ? 'compacting' : 'complete'];
  return <section className="model-section" aria-label="Model activity">
    <Heading title="Model activity" aside={<Badge tone={phase === 'failed' ? 'red' : phase === 'unknown' ? 'neutral' : 'green'}>{readable(phase)}</Badge>} />
    <div className="model-state-layout"><div className="model-phase"><div className="model-identity"><Layers3 size={20} /><strong>{model?.model || 'Model not reported'}</strong><span className="muted">{demo ? 'Synthetic observation' : available ? readable(model.source) : 'No current observation'}</span></div>
      <ol className="phase-track" aria-label="Model phases">{phases.map(item => <li key={item} aria-current={phase === item ? 'step' : undefined}><span className="phase-marker" />{readable(item)}</li>)}</ol>
      <p className="muted small">{!live ? 'Current model phase is unknown while updates are paused or disconnected.' : model?.detail || 'No model phase has been observed.'}</p>
      <span className="phase-time muted">Last observation <span className="numeric">{time(model?.updated_at)}</span></span>
    </div><div className="reasoning-panel" data-active={reasoning} role="status" aria-label="Observed reasoning"><span className="reasoning-lamp"><Brain size={23} /></span><div><strong>{reasoning ? 'Reasoning observed' : 'No active reasoning observed'}</strong><p>{reasoning ? 'Reasoning event received from the model connection.' : 'Waiting, generation, and tool activity do not light this indicator.'}</p></div></div></div>
  </section>;
}

function decodeMemory(response) {
  if (!Array.isArray(response?.content)) return response;
  const literal = response.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  try { return JSON.parse(literal); } catch { return literal; }
}

function EngineGraph({snapshot, inspect}) {
  const nodes = snapshot?.graph?.nodes || [];
  const active = snapshot?.graph?.active || [];
  return <section className="flow-section">
    <Heading title="Engine flow" aside={<div className="legend"><span className="status-dot" /> In use <span className="legend-idle" /> Available</div>} />
    {!nodes.length ? <Empty icon={GitBranch} title="No flow snapshot" /> : <div className="graph-scroll"><div className="engine-graph" role="group" aria-label="Client to controller to tool flow to evidence; controller also connects to memory">
      <div className="graph-rail rail-main" aria-hidden="true" /><div className="graph-rail rail-memory" aria-hidden="true" />
      {nodes.filter(node => nodeInfo[node]).map(node => {
        const {name, subtitle, icon: Icon} = nodeInfo[node];
        const inUse = node === 'controller' ? !!snapshot.active?.length : active.includes(node);
        return <button key={node} className={`graph-node node-${node} ${inUse ? 'in-use' : ''}`} onClick={() => inspect({title: name, fields: {Component: name, State: inUse ? 'In use by a current request' : 'Available in the engine graph', Source: demo ? 'Public playback fixture' : 'Local engine snapshot'}, note: 'Graph presence is not proof of an active model call.'})}>
          <span className="node-icon"><Icon size={20} strokeWidth={1.7} /></span><span><strong>{name}</strong><small>{subtitle}</small></span><span className="node-dot" />
        </button>;
      })}
      <span className="graph-caption">Request boundary</span><span className="graph-caption caption-memory">Context on request</span>
      <ArrowRight className="graph-arrow arrow-a" size={13} /><ArrowRight className="graph-arrow arrow-b" size={13} /><ArrowRight className="graph-arrow arrow-c" size={13} /><ArrowDown className="graph-arrow arrow-d" size={13} />
    </div></div>}
  </section>;
}

function Runtime({snapshot}) {
  const policy = snapshot.compaction;
  return <aside className="runtime">
    <Heading title="Runtime" aside={<Badge tone="green">Local</Badge>} />
    <dl className="runtime-list"><div><dt>Core process</dt><dd><span className={`small-dot ${snapshot.core === 'online' ? 'green-dot' : ''}`} />{readable(snapshot.core)}</dd></div>
      <div><dt>Memory</dt><dd>{readable(snapshot.memory?.status)}</dd></div>
      <div><dt>Stored notes</dt><dd className="numeric">{number(snapshot.memory?.notes)}</dd></div>
      <div><dt>Claude-Mem bridge</dt><dd>{snapshot.memory?.claude_bridge ? 'Configured' : 'Not configured'}</dd></div>
      <div><dt>RTK</dt><dd>{snapshot.rtk?.enabled === true ? snapshot.rtk.available === true ? 'Enabled / available' : snapshot.rtk.available === false ? 'Enabled / unavailable' : 'Enabled / unknown' : snapshot.rtk?.enabled === false ? 'Disabled' : 'Not reported'}</dd></div>
    </dl>
    <div className="runtime-subheading"><Layers3 size={16} /><h3>Compaction</h3></div>
    <dl className="runtime-list"><div><dt>Policy</dt><dd>{readable(policy?.mode)}</dd></div><div><dt>Threshold override</dt><dd>{policy?.threshold_override == null ? 'None' : readable(policy.threshold_override)}</dd></div><div><dt>Forced early</dt><dd>{policy?.forced_early == null ? 'Not reported' : policy.forced_early ? 'Yes' : 'No'}</dd></div><div><dt>Observed</dt><dd className="numeric">{number(policy?.observed)}</dd></div></dl>
  </aside>;
}

function ActiveRequests({snapshot, inspect}) {
  return <section className="request-section"><Heading title="Active requests" aside={<Badge tone={snapshot.active.length ? 'green' : 'neutral'}>{number(snapshot.active.length)} running</Badge>} />
    {snapshot.active.length ? <div className="request-list">{snapshot.active.map(request => <button className="request-row" key={request.id} onClick={() => inspect({title: `${readable(request.kind)} / ${readable(request.action)}`, fields: {ID: request.id, Kind: request.kind, Action: request.action, Started: time(request.started), State: demo ? 'Recorded active request' : 'Running in local service'}})}><span className="request-status"><Activity size={17} /></span><div><strong>{readable(request.kind)} <span>/</span> {readable(request.action)}</strong><small>Started {time(request.started)}</small></div><Badge tone="green">{demo ? 'Recorded' : 'Running'}</Badge><ChevronRight size={16} /></button>)}</div> : <div className="inline-empty"><Circle size={15} />No requests running</div>}
  </section>;
}

function Goals({snapshot, inspect, compact = false}) {
  const goals = snapshot.goals || [];
  return <section className="goals-section"><Heading title="Stored goals" aside={<Badge>{number(goals.length)} retained</Badge>}>History only. Stored state does not start work.</Heading>
    {goals.length ? <div className="goal-list">{goals.slice(0, compact ? 2 : undefined).map(goal => <button className="goal-row" key={goal.id} onClick={() => inspect({title: 'Stored goal', fields: {ID: goal.id, Project: goal.project, Objective: goal.objective, 'Stored state': goal.state, Cursor: goal.cursor, Revision: goal.revision, Execution: 'Stored only; no request implied'}, note: 'Memory and previous goals are evidence, not authorization to resume work.'})}><BookOpen size={18} /><div><strong>{goal.objective}</strong><small>{goal.project} <span>/</span> Revision {number(goal.revision)}</small></div><Badge>{readable(goal.state)}</Badge><ChevronRight size={16} /></button>)}</div> : <div className="inline-empty"><BookOpen size={16} />No stored goals</div>}
  </section>;
}

function Operations({events, inspect, full = false}) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [sort, setSort] = useState('recent');
  const filtered = events.filter(event => (status === 'all' || event.status === status) && `${event.kind} ${event.action || ''} ${event.id}`.toLowerCase().includes(query.toLowerCase()));
  const sorted = [...filtered].sort((a, b) => sort === 'slowest' ? (b.elapsed_ms || 0) - (a.elapsed_ms || 0) : new Date(b.at) - new Date(a.at));
  const visible = full ? sorted : sorted.slice(0, 5);
  return <section className="operations"><Heading title={full ? 'Operation evidence' : 'Recent operations'} aside={<span className="muted small">{number(filtered.length)} retained events</span>} />
    <div className="table-toolbar"><label className="search-field"><Search size={16} /><input aria-label="Search operations" placeholder="Search operations..." value={query} onChange={e => setQuery(e.target.value)} />{query && <button type="button" aria-label="Clear operation search" onClick={() => setQuery('')}><X size={14} /></button>}</label><label className="select-field"><span className="sr-only">Operation status</span><select aria-label="Operation status" value={status} onChange={e => setStatus(e.target.value)}><option value="all">All statuses</option><option value="complete">Complete</option><option value="failed">Failed</option></select></label><label className="select-field sort-field"><span className="sr-only">Sort operations</span><select aria-label="Sort operations" value={sort} onChange={e => setSort(e.target.value)}><option value="recent">Most recent</option><option value="slowest">Slowest first</option></select></label></div>
    <div className="table-scroll"><table><thead><tr><th>Operation</th><th>Action</th><th>Status</th><th className="align-right">Duration</th><th className="align-right">Time</th><th><span className="sr-only">Details</span></th></tr></thead><tbody>{visible.map(event => <tr key={event.id}><td><span className={`event-icon ${event.status === 'failed' ? 'failed' : ''}`}>{event.status === 'failed' ? <CircleAlert size={15} /> : <CheckCircle2 size={15} />}</span><strong>{readable(event.kind)}</strong></td><td>{readable(event.action)}</td><td><Badge tone={event.status === 'failed' ? 'red' : event.status === 'complete' ? 'green' : 'neutral'}>{readable(event.status)}</Badge></td><td className="align-right numeric">{event.elapsed_ms == null ? 'Unknown' : `${number(event.elapsed_ms)} ms`}</td><td className="align-right numeric muted">{time(event.at)}</td><td><IconButton label={`Inspect ${readable(event.kind)} ${readable(event.action)}`} onClick={() => inspect({title: 'Operation evidence', fields: {ID: event.id, Kind: event.kind, Action: event.action, Status: event.status, 'Elapsed (ms)': event.elapsed_ms, Time: time(event.at)}, note: 'Status records the tool result. It does not certify task correctness.'})}><ArrowUpRight size={16} /></IconButton></td></tr>)}</tbody></table></div>
    {!visible.length && <Empty icon={Search} title={events.length ? 'No matching operations' : 'No operations recorded'}>{events.length ? 'No retained events match these filters.' : 'Operations appear after explicit requests reach the engine.'}</Empty>}
  </section>;
}

function Memory({snapshot, inspect}) {
  const [project, setProject] = useState(''), [query, setQuery] = useState(''), [result, setResult] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [projects, setProjects] = useState([]), [source, setSource] = useState('helix'), [notes, setNotes] = useState(null), [reading, setReading] = useState(null), [nextCursor, setNextCursor] = useState(null);
  const revision = useRef(0);
  const supported = !demo && typeof window.helix?.memorySearch === 'function';
  const browsable = !demo && typeof window.helix?.memoryBrowse === 'function';
  useEffect(() => {
    let current = true;
    if (!demo && window.helix?.memoryProjects) window.helix.memoryProjects().then(value => { if (current) setProjects(Array.isArray(value) ? value : []); }).catch(() => { if (current) setError('Project list unavailable. Enter a project to continue.'); });
    return () => { current = false; revision.current++; };
  }, []);
  function changeScope(change) {
    revision.current++; setBusy(false); setReading(null); setNotes(null); setNextCursor(null); setResult(null); setError(''); change();
  }
  async function retrieve(event, browse = false, cursor = null) {
    event?.preventDefault();
    const request = ++revision.current;
    setBusy(true); setError(''); setResult(null); if (cursor === null) { setNotes(null); setNextCursor(null); } setReading(null);
    try {
      const response = decodeMemory(await (browse ? window.helix.memoryBrowse({project: project.trim(), source, limit: 20, ...(cursor === null ? {} : {cursor})}) : window.helix.memorySearch({project: project.trim(), query: query.trim(), source, limit: 20})));
      if (request !== revision.current) return;
      const items = Array.isArray(response) ? response : response?.notes || response?.results;
      if (Array.isArray(items)) { setNotes(previous => cursor === null ? items : [...(previous || []), ...items]); setNextCursor(browse ? response?.next_cursor ?? null : null); }
      else setResult(typeof response === 'string' ? response : JSON.stringify(response, null, 2));
    } catch { if (request === revision.current) setError('Memory retrieval failed. Check the local engine and try again.'); }
    finally { if (request === revision.current) setBusy(false); }
  }
  async function read(note) {
    const request = ++revision.current;
    setReading(note.id); setError('');
    try {
      const value = decodeMemory(await window.helix.memoryRead({id: note.id, project: project.trim(), source: note.source || source}));
      if (request === revision.current) inspect({title: value?.title || note.title || 'Exact memory note', fields: {ID: value?.id ?? note.id, Project: value?.project || project, Source: value?.source || note.source || source, Task: value?.task, Kind: value?.kind, Created: time(value?.created)}, literal: typeof value === 'string' ? value : typeof value?.body === 'string' ? value.body : JSON.stringify(value, null, 2), note: 'Exact stored content. Retrieval does not start or resume work.'});
    } catch { if (request === revision.current) setError('The exact note could not be read. Try again.'); }
    finally { if (request === revision.current) setReading(null); }
  }
  async function connectClaudeMem() {
    const request = ++revision.current;
    setBusy(true); setError(''); setResult(null); setNotes(null); setNextCursor(null);
    try {
      const status = await window.helix.connectClaudeMem();
      if (request !== revision.current || status == null) return;
      setResult(typeof status === 'string' ? status : status.message || status.status || JSON.stringify(status, null, 2));
      setSource('claude-mem'); setProject('');
      const list = await window.helix.memoryProjects();
      if (request === revision.current) setProjects(Array.isArray(list) ? list : []);
    } catch { if (request === revision.current) setError('Claude-Mem could not connect. Choose an accessible memory database and try again.'); }
    finally { if (request === revision.current) setBusy(false); }
  }
  return <><section className="memory-summary"><Heading title="Deterministic memory" aside={<div className="memory-heading-actions"><Badge>{readable(snapshot.memory?.status)}</Badge><button className="secondary-button" onClick={connectClaudeMem} disabled={demo || busy || reading !== null || typeof window.helix?.connectClaudeMem !== 'function'}><FolderOpen size={16} />Connect Claude-Mem</button></div>} /><div className="memory-count"><Database size={28} /><strong>{number(snapshot.memory?.notes)}</strong><span>stored notes</span></div>
    <form className="memory-form" onSubmit={retrieve}><label>Source<select aria-label="Memory source" value={source} onChange={e => changeScope(() => setSource(e.target.value))} disabled={(!supported && !browsable) || busy || reading !== null}><option value="helix">HELIX</option><option value="claude-mem">Claude-Mem</option></select></label><label>Project<input name="project" autoComplete="off" list="memory-projects" value={project} onChange={e => changeScope(() => setProject(e.target.value))} placeholder="Project identifier" required disabled={(!supported && !browsable) || busy || reading !== null} /></label><datalist id="memory-projects">{projects.filter(item => item.source === source).map(item => <option key={`${item.source}:${item.project}`} value={item.project}>{number(item.notes)} notes</option>)}</datalist><label>Query<input name="query" autoComplete="off" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search stored notes" disabled={!supported || busy} /></label><div className="memory-actions"><button type="button" className="secondary-button" onClick={() => retrieve(null, true)} disabled={!browsable || busy || reading !== null || !project.trim()}><FolderOpen size={16} />Browse notes</button><button className="primary-button" disabled={!supported || busy || reading !== null || !project.trim() || !query.trim()}><Search size={16} />{busy ? 'Loading...' : 'Search memory'}</button></div></form>
    {!supported && <p className="muted small">{demo ? 'Memory search is unavailable in playback.' : 'Memory search is unavailable in this connection.'}</p>}
    {error && <p className="error-text" role="alert">{error}</p>}<div aria-live="polite">{busy && <p className="muted memory-progress">Retrieving stored notes...</p>}{notes !== null && <><div className="memory-results-heading"><strong>{number(notes.length)} notes returned</strong><span className="muted">{source === 'helix' ? 'HELIX' : 'Claude-Mem'} / {project}</span></div>{notes.length ? <div className="memory-note-list">{notes.map(note => <button className="memory-note" key={`${note.source || source}:${note.id}`} disabled={busy || reading !== null || typeof window.helix?.memoryRead !== 'function'} onClick={() => read(note)}><BookOpen size={18} /><div><strong>{note.title || note.task || `Note ${note.id}`}</strong><p>{note.preview || note.body || note.kind || 'No preview available'}</p><small className="muted">{note.source || source} / {time(note.created)}</small></div><span>{reading === note.id ? 'Reading...' : <ArrowUpRight size={17} />}</span></button>)}</div> : <Empty icon={Search} title="No matching notes" />}{nextCursor !== null && <button className="secondary-button memory-load-more" disabled={busy || reading !== null} onClick={() => retrieve(null, true, nextCursor)}><ArrowDown size={16} />Load more notes</button>}</>}{result !== null && <pre className="literal-result">{result}</pre>}</div>
  </section><Goals snapshot={snapshot} inspect={inspect} /></>;
}

function Troubleshooting({refreshSnapshot}) {
  const [report, setReport] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirm, setConfirm] = useState(false), [restarting, setRestarting] = useState(false), [restartResult, setRestartResult] = useState('');
  const current = useRef(true);
  const supported = !demo && typeof window.helix?.diagnostics === 'function';
  async function check() {
    setBusy(true); setError('');
    try { const next = await window.helix.diagnostics(); if (current.current) setReport(next); }
    catch { if (current.current) setError('Diagnostics could not reach the desktop connection.'); }
    finally { if (current.current) setBusy(false); }
  }
  useEffect(() => { current.current = true; if (supported) check(); return () => { current.current = false; }; }, []);
  async function restart() {
    setConfirm(false); setRestarting(true); setError(''); setRestartResult('');
    try { const value = await window.helix.restartCore(); if (current.current) { setRestartResult(typeof value === 'string' ? value : value?.message || value?.status || 'Restart request completed.'); refreshSnapshot(); await check(); } }
    catch { if (current.current) setError('The restart request failed. Check diagnostics before trying again.'); }
    finally { if (current.current) setRestarting(false); }
  }
  return <section className="diagnostics-section"><Heading title="Connection checks" aside={<button className="secondary-button" onClick={check} disabled={!supported || busy || restarting}><RefreshCw size={16} />{busy ? 'Checking...' : 'Run checks'}</button>} />
    {!supported && <Empty icon={Wrench} title={demo ? 'Diagnostics unavailable in playback' : 'Desktop diagnostics unavailable'} />}
    {error && <p role="alert" className="error-text">{error}</p>}
    {report && <><div className="diagnostics-meta muted">Checked <span className="numeric">{time(report.checked_at)}</span><span>Model calls <strong>{number(report.model_calls)}</strong></span></div><div className="diagnostics-list">{(report.checks || []).map(item => <div className="diagnostic-check" key={item.id}>{item.status === 'ok' ? <CheckCircle2 size={18} /> : <CircleAlert size={18} />}<div><strong>{item.label}</strong><p>{item.detail}</p>{item.remedy && <p className="diagnostic-remedy">{item.remedy}</p>}</div><Badge tone={item.status === 'error' ? 'red' : item.status === 'ok' ? 'green' : 'neutral'}>{item.status}</Badge></div>)}</div></>}
    <div className="restart-section"><div><h2>Local core</h2><p className="muted">Restarting interrupts current core requests.</p></div><button className="secondary-button" onClick={() => setConfirm(true)} disabled={demo || busy || restarting || typeof window.helix?.restartCore !== 'function'}><RefreshCw size={16} />{restarting ? 'Restarting...' : 'Restart core'}</button></div>
    {confirm && <div className="restart-confirmation" role="alert"><strong>Restart the local core now?</strong><p>Current requests may fail. The core will reconnect after restart.</p><div><button className="secondary-button" onClick={() => setConfirm(false)}>Cancel</button><button className="primary-button" onClick={restart}><RefreshCw size={16} />Confirm restart</button></div></div>}
    {restartResult && <p className="restart-result" role="status">{restartResult}</p>}
  </section>;
}

function App() {
  const {snapshot, state, paused, setPaused, received, refresh} = useSnapshot();
  const [section, setSection] = useState(sectionFromHash), [detail, setDetail] = useState(null), [mobileNav, setMobileNav] = useState(false);
  useEffect(() => { const onHash = () => { setSection(sectionFromHash()); setDetail(null); setMobileNav(false); }; addEventListener('hashchange', onHash); return () => removeEventListener('hashchange', onHash); }, []);
  const inspect = useCallback(value => setDetail(value), []);
  const title = sections.find(([id]) => id === section)[1];
  const connected = state === 'connected';
  const statusLabel = demo ? 'DEMO / PLAYBACK' : state === 'loading' ? 'Connecting' : state === 'error' ? 'Connection lost' : state === 'offline' ? 'Offline' : paused ? 'Updates paused' : 'Local connection';
  return <div className="app-shell">
    <a href="#main" className="skip-link">Skip to content</a>
    <aside className={`sidebar ${mobileNav ? 'mobile-open' : ''}`}><div className="brand"><span className="brand-icon brand-mark"><img src={helixMark} alt="" width="24" height="24" /></span><strong>HELIX<span>1.0</span></strong><IconButton label="Close navigation" className="mobile-close icon-button" onClick={() => setMobileNav(false)}><X size={19} /></IconButton></div><div className="workspace-label">ENGINE MONITOR</div>
      <nav aria-label="Primary">{sections.map(([id,label,Icon]) => <a key={id} href={`#${id}`} aria-current={section === id ? 'page' : undefined}><Icon size={18} /><span>{label}</span>{id === 'evidence' && snapshot?.counters.failed > 0 && <span className="nav-count">{number(snapshot.counters.failed)}</span>}{section === id && <ChevronRight size={15} className="nav-chevron" />}</a>)}</nav>
      <div className="sidebar-footer"><div className="local-indicator"><span className={`small-dot ${connected ? 'green-dot' : ''}`} /><strong>{demo ? 'Playback fixture' : 'Local engine'}</strong><span className="numeric">{snapshot?.version || '1.0.1'}</span></div><div className="privacy-row"><LockKeyhole size={14} /><span>Raw session export <strong>{snapshot?.privacy?.raw_session_export === false ? 'off' : snapshot?.privacy?.raw_session_export === true ? 'on' : 'unknown'}</strong></span></div><div className="privacy-row"><ShieldCheck size={14} /><span>Background models <strong>{snapshot?.privacy?.background_llm === false ? 'off' : snapshot?.privacy?.background_llm === true ? 'on' : 'unknown'}</strong></span></div></div>
      <ThemeControl />
    </aside>
    {mobileNav && <button className="mobile-backdrop" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}
    <div className="main-shell"><header className="topbar"><div className="breadcrumb"><IconButton label="Open navigation" className="mobile-menu icon-button" onClick={() => setMobileNav(true)}><Menu size={20} /></IconButton><span>Engine</span><ChevronRight size={13} /><strong>{title}</strong></div><div className="topbar-controls"><Badge tone={demo ? 'purple' : connected ? 'green' : 'neutral'} dot>{statusLabel}</Badge><span className="snapshot-time numeric" title="Last snapshot received">{demo ? 'PUBLIC FIXTURE' : received ? time(received) : 'No snapshot'}</span><IconButton label={paused ? 'Resume updates' : 'Pause updates'} onClick={() => setPaused(value => !value)} disabled={demo || !snapshot}>{paused ? <Play size={16} /> : <Pause size={16} />}</IconButton><IconButton label="Refresh snapshot" onClick={refresh}><RefreshCw size={16} /></IconButton></div></header>
      <main id="main" tabIndex={-1}><div className="page-heading"><div><div className="page-label"><span className="section-number">0{sections.findIndex(([id]) => id === section) + 1}</span> LOCAL OPERATIONS</div><h1>{section === 'overview' ? 'Engine overview' : title}</h1><p>{section === 'overview' ? 'Requests, retained evidence, and runtime state.' : section === 'flow' ? 'Current requests and deterministic execution.' : section === 'evidence' ? 'Retained tool results from the local service.' : section === 'memory' ? 'Explicit retrieval and stored context.' : section === 'troubleshooting' ? 'Local connection, integrations, and recovery.' : 'Paired results, known usage, and evidence limits.'}</p></div><div className="engine-status"><span className={`status-ring ${connected && snapshot?.status === 'online' ? 'connected' : ''}`}><Activity size={19} /></span><div><strong>{demo ? 'Recorded snapshot' : connected ? `Engine ${readable(snapshot?.status)}` : state === 'loading' ? 'Connecting to engine' : 'Engine unavailable'}</strong><span>{demo ? 'Synthetic public data' : connected ? paused ? 'Automatic updates paused' : 'Snapshot every 2 seconds' : 'Awaiting local connection'}</span></div></div></div>
        {demo && <div className="notice playback-notice"><Play size={15} /><strong>DEMO / PLAYBACK</strong><span>Synthetic fixture. No live engine, model calls, or benchmark results.</span></div>}
        {state === 'error' && <div className="notice error-notice" role="alert"><CircleAlert size={17} /><span>Connection lost.{snapshot ? ' Last snapshot retained.' : ' No snapshot available.'} Refresh after the local engine reconnects.</span></div>}
        {developmentMonitor && section === 'overview' && snapshot?.monitored_benchmark && <section className="benchmark-strip" aria-label="Development run observation"><Activity size={17} /><div><strong>Development run <span className={`badge ${snapshot.monitored_benchmark.status === 'running' ? 'green' : 'neutral'}`}>{snapshot.monitored_benchmark.status === 'prepared' ? 'Pending' : readable(snapshot.monitored_benchmark.status)}</span></strong><p>{readable(snapshot.monitored_benchmark.phase)}</p></div><span>Issue <strong className="numeric">{number(snapshot.monitored_benchmark.current)}</strong></span><span>Requests <strong className="numeric">{number(snapshot.monitored_benchmark.requests)}</strong></span><a href="#benchmarks">View benchmark <ArrowUpRight size={14} /></a></section>}
        {section === 'troubleshooting' ? <Troubleshooting refreshSnapshot={refresh} /> : !snapshot ? <section className="connection-state">{state === 'loading' ? <Empty icon={RefreshCw} title="Waiting for engine snapshot">Connecting to the local monitor bridge.</Empty> : <Empty icon={CircleAlert} title="Local engine is offline">Open this monitor through the HELIX desktop app to connect.</Empty>}<button className="secondary-button" onClick={refresh}><RefreshCw size={16} />Retry connection</button><a className="connection-help" href="#troubleshooting"><Wrench size={16} />Troubleshooting</a></section> : <>
          {(section === 'overview' || section === 'flow') && <ModelState snapshot={snapshot} live={connected && !paused} />}
          {(section === 'overview' || section === 'flow') && <><div className="metrics-strip">{[['Active requests',snapshot.active.length,Activity,'Running now'],['Operations',snapshot.counters.operations,Workflow,'Tool calls recorded'],['Failed operations',snapshot.counters.failed,CircleAlert,'Retained in totals'],['Model calls',snapshot.counters.model_calls,Layers3,'Engine-issued calls'],['Memory lookups',snapshot.counters.memory_lookups,Database,'Explicit retrievals']].map(([label,value,Icon,caption]) => <div className="metric" key={label}><span><Icon size={16} />{label}</span><strong className={label === 'Failed operations' && value > 0 ? 'failure-value' : ''}>{number(value)}</strong><small>{caption}</small></div>)}</div><div className="flow-layout"><EngineGraph snapshot={snapshot} inspect={inspect} /><Runtime snapshot={snapshot} /></div><div className="activity-layout"><ActiveRequests snapshot={snapshot} inspect={inspect} /><Goals snapshot={snapshot} inspect={inspect} compact /></div></>}
          {(section === 'overview' || section === 'flow' || section === 'evidence') && <Operations events={snapshot.events} inspect={inspect} full={section !== 'overview'} />}
          {section === 'memory' && <Memory snapshot={snapshot} inspect={inspect} />}
          {developmentMonitor && section === 'benchmarks' && <BenchmarkMonitor demo={demo} />}
          {section === 'evidence' && <section className="usage-summary"><Heading title="Engine model usage" /><dl><div><dt>Known input</dt><dd>{number(snapshot.counters.known_input)}</dd></div><div><dt>Known output</dt><dd>{number(snapshot.counters.known_output)}</dd></div><div><dt>Unknown usage</dt><dd>{number(snapshot.counters.unknown_usage)}</dd></div></dl><p>These are engine counters, not usage for the surrounding agent session.</p></section>}
        </>}
        <footer className="page-footer"><span><ShieldCheck size={14} />{demo ? 'Public fixture only' : 'Local snapshot only'}</span><span>Stored context is not authorization to resume work.</span><span className="numeric">HELIX / 1.0</span></footer>
      </main>
    </div><Detail detail={detail} close={() => setDetail(null)} />
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);
