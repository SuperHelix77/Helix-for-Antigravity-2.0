import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Activity, CircleAlert, FolderOpen, Pause, Play, RefreshCw, SlidersHorizontal} from 'lucide-react';

const number = value => value == null ? 'Not reported' : new Intl.NumberFormat().format(value);
const readable = value => value == null ? 'Not reported' : String(value).replaceAll('_', ' ');
const time = value => value == null || !Number.isFinite(new Date(value).getTime()) ? 'Not reported' : new Intl.DateTimeFormat(undefined, {hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false}).format(new Date(value));
const measures = [['solves','Solved'],['submitted','Submitted'],['graded','Graded'],['requests','Requests'],['input','Known input tokens'],['output','Known output tokens'],['reasoning','Known reasoning tokens'],['tokens','Known total tokens'],['unknown','Unknown usage'],['failed_requests','Failed requests'],['failed_issues','Failed issues'],['failed_issue_requests','Failed issue requests'],['compactions','Compactions']];

export default function BenchmarkMonitor({demo}) {
  const [benchmark, setBenchmark] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [paused, setPaused] = useState(false), [received, setReceived] = useState(null);
  const inFlight = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const read = useCallback(async () => {
    if (demo || document.visibilityState === 'hidden' || typeof window.helix?.benchmark !== 'function' || inFlight.current) return;
    inFlight.current = true; if (mounted.current) setBusy(true);
    try {
      const next = await window.helix.benchmark();
      if (mounted.current) { setBenchmark(next); setError(''); setReceived(Date.now()); }
    } catch { if (mounted.current) setError('Benchmark observation failed. Last observed data retained.'); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }, [demo]);
  useEffect(() => {
    let cancelled = false, timer;
    async function tick() { await read(); if (!cancelled) timer = setTimeout(tick, 2000); }
    if (!paused) tick();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [paused, read]);
  async function choose() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true);
    try { const next = await window.helix.chooseBenchmark(); if (next && mounted.current) { setBenchmark(next); setError(''); setReceived(Date.now()); } }
    catch { if (mounted.current) setError('The selected benchmark could not be loaded. Last observed data retained.'); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }
  const canChoose = !demo && typeof window.helix?.chooseBenchmark === 'function';
  const canRead = !demo && typeof window.helix?.benchmark === 'function';
  const live = benchmark?.live;
  const status = live?.status === 'prepared' ? 'Pending' : readable(live?.status);
  return <section className="benchmarks">
    <div className="section-heading"><div><h2>Development benchmark monitor</h2><p>Read-only observation. No run is started from this view.</p></div><div className="benchmark-controls"><button className="icon-button" title={paused ? 'Resume benchmark updates' : 'Pause benchmark updates'} aria-label={paused ? 'Resume benchmark updates' : 'Pause benchmark updates'} disabled={!canRead} onClick={() => setPaused(value => !value)}>{paused ? <Play size={16} /> : <Pause size={16} />}</button><button className="icon-button" title="Refresh benchmark" aria-label="Refresh benchmark" disabled={!canRead || busy} onClick={read}><RefreshCw size={16} /></button><button className="secondary-button" onClick={choose} disabled={!canChoose || busy}><FolderOpen size={16} />{busy ? 'Reading...' : 'Choose evidence'}</button></div></div>
    <div className="benchmark-observation"><span className={`badge ${error ? 'red' : 'neutral'}`}>{error ? 'Stale observation' : paused ? 'Observation paused' : canRead ? 'Observing every 2 seconds' : 'Observation unavailable'}</span><span className="numeric">{received ? `Received ${time(received)}` : 'No observation received'}</span></div>
    {error && <p role="alert" className="error-text"><CircleAlert size={15} />{error}</p>}
    {!benchmark ? <div className="empty"><SlidersHorizontal size={25} strokeWidth={1.4} /><strong>No benchmark loaded</strong><p>{demo ? 'Playback contains no benchmark results.' : 'No aggregate benchmark evidence has been selected.'}</p></div> : <>
      <div className="benchmark-meta"><h3>{benchmark.name}</h3><span className={`badge ${benchmark.complete ? 'green' : 'neutral'}`}>{benchmark.complete ? 'Complete set' : 'Incomplete set'}</span><span>{benchmark.model} / {benchmark.effort}</span></div>
      <section className="benchmark-live" aria-label="Live benchmark observation"><div className="live-heading"><Activity size={18} /><div><h3>Current run</h3><p>{readable(live?.phase)}</p></div><span className={`badge ${live?.status === 'running' || live?.status === 'completed' ? 'green' : 'neutral'}`}>{status}</span></div>{live?.status === 'prepared' && <p className="pending-run">Prepared. Execution has not started.</p>}<div className="live-instance"><span>Current issue <strong className="numeric">{number(live?.current)}</strong></span><span className="numeric">{live?.instance_id || 'No current instance reported'}</span></div><div className="live-metrics">{[['Requests',live?.requests],['Known input',live?.known_input],['Known output',live?.known_output],['Known tokens',live?.known_tokens],['Unknown usage',live?.unknown_usage],['Submitted',live?.submitted],['Graded',live?.graded],['Solved',live?.solved],['Matched pairs',live?.matched_pairs],['In flight',live?.in_flight],['Native tool calls',live?.native_tool_calls],['Tool commands',live?.tool_commands]].map(([label,value]) => <div key={label}><span>{label}</span><strong className="numeric">{number(value)}</strong></div>)}</div><p className="usage-cost">Cumulative token usage is measured. Monetary cost is not reported.</p></section>
      <div className="section-heading"><h2>Recent run activity</h2><span className="muted small">{number(live?.activity?.length)} retained observations</span></div><div className="table-scroll"><table><thead><tr><th>Operation</th><th>Action</th><th>Status</th><th className="align-right">Known input</th><th className="align-right">Known output</th><th className="align-right">Time</th></tr></thead><tbody>{live?.activity?.map((event,index) => <tr key={event.id || index}><th>{readable(event.kind)}</th><td>{readable(event.action)}</td><td><span className={`badge ${event.status === 'failed' ? 'red' : event.status === 'complete' ? 'green' : 'neutral'}`}>{readable(event.status)}</span></td><td className="align-right numeric">{number(event.input_tokens)}</td><td className="align-right numeric">{number(event.output_tokens)}</td><td className="align-right numeric">{time(event.at)}</td></tr>)}</tbody></table></div>{!live?.activity?.length && <div className="inline-empty">No run activity reported.</div>}
      <div className="section-heading aggregate-heading"><h2>Lane totals</h2></div><div className="table-scroll"><table><thead><tr><th>Measure</th><th className="align-right">Vanilla (historical)</th><th className="align-right">Modified (current)</th></tr></thead><tbody>{measures.map(([key,label]) => <tr key={key}><th>{label}</th><td className="align-right numeric">{number(benchmark.lanes?.vanilla?.[key])}</td><td className="align-right numeric">{number(benchmark.lanes?.modified?.[key])}</td></tr>)}</tbody></table></div>
      <div className="benchmark-savings"><span>Matched known token savings<strong>{benchmark.known_savings_percent == null ? 'Not available' : `${number(benchmark.known_savings_percent)}%`}</strong></span><span>Matched complete token savings<strong>{benchmark.complete_savings_percent == null ? 'Not established' : `${number(benchmark.complete_savings_percent)}%`}</strong></span><span>Matched output token savings<strong>{benchmark.output_savings_percent == null ? 'Not available' : `${number(benchmark.output_savings_percent)}%`}</strong></span></div><div className="benchmark-limitations"><h3>Evidence limits</h3><p>Lane totals include historical vanilla and current modified usage, including failed attempts. Savings compare only the graded matched prefix. Unknown usage makes token totals incomplete.</p>{benchmark.limitations?.map((item,index) => <p key={index}>{item}</p>)}</div>{benchmark.pairs?.length > 0 && <><div className="section-heading"><h2>Paired outcomes</h2></div><div className="table-scroll"><table><thead><tr><th>Instance</th><th>Order</th><th>Vanilla</th><th>Modified</th><th className="align-right">Vanilla tokens</th><th className="align-right">Modified tokens</th></tr></thead><tbody>{benchmark.pairs.map((pair,index) => <tr key={`${pair.instance_id}-${index}`}><th>{pair.instance_id}</th><td>{readable(pair.order)}</td><td>{pair.vanilla_pass == null ? 'Not graded' : pair.vanilla_pass ? 'Pass' : 'Fail'}</td><td>{pair.modified_pass == null ? 'Not graded' : pair.modified_pass ? 'Pass' : 'Fail'}</td><td className="align-right numeric">{number(pair.vanilla_tokens)}</td><td className="align-right numeric">{number(pair.modified_tokens)}</td></tr>)}</tbody></table></div></>}
    </>}
  </section>;
}
